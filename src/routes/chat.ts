/*
 * File: chat.ts
 * Project: deepsproxy
 * Main chat completions handler with retry logic.
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createDeepSeekStream } from '../services/deepseek.ts';
import type { OpenAIRequest, Usage } from '../types/openai.ts';
import { getModelTelemetry, recordSuccess, recordFailure } from '../services/telemetry.ts';
import { compressMessages } from '../utils/compression.ts';
import { serializeOpenAIMessages, appendToolInstructions } from './serialize.ts';
import { parseDeepSeekStreamToOpenAI, makeChunk } from './stream-parser.ts';
import type { ParsedCompletion } from './stream-parser.ts';

function getRetryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 10000);
}

async function peekStream(stream: ReadableStream): Promise<{ isEmpty: boolean; peekedStream: ReadableStream }> {
  const reader = stream.getReader();
  try {
    const { done, value } = await reader.read();
    if (done) {
      return { isEmpty: true, peekedStream: new ReadableStream({ start(c) { c.close(); } }) };
    }

    const peekedStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(value);
        try {
          while (true) {
            const { done: nextDone, value: nextValue } = await reader.read();
            if (nextDone) {
              controller.close();
              break;
            }
            controller.enqueue(nextValue);
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        reader.releaseLock();
      }
    });

    return { isEmpty: false, peekedStream };
  } catch (err) {
    reader.releaseLock();
    throw err;
  }
}

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    const messages = body.messages || [];

    const isThinkingModel = body.model.includes('thinking');
    const isProModel = body.model.includes('pro');
    const completionId = 'chatcmpl-' + uuidv4();

    if (!isStream) {
      let attempt = 0;
      const maxAttempts = 3;
      let lastError: any = null;
      let parsedResult: ParsedCompletion | null = null;
      let finalUiSessionId = '';

      while (attempt < maxAttempts) {
        attempt++;
        const telemetry = getModelTelemetry(body.model);
        const currentTargetLimit = telemetry.detectedLimit;

        const compressed = compressMessages(messages, currentTargetLimit, serializeOpenAIMessages);
        const serialized = serializeOpenAIMessages(compressed);
        const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
        const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
        const promptSize = finalPrompt.length;
        const promptTokens = Math.ceil(promptSize / 3.5);

        try {
          console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (non-stream) with prompt length ${promptSize} chars.`);
          const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);

          const parsed = await parseDeepSeekStreamToOpenAI(
            result.stream,
            completionId,
            body.model,
            promptTokens,
            result.uiSessionId,
            (body as any).tools || []
          );

          if (parsed.content === '' && parsed.toolCalls.length === 0) {
            console.warn(`[Chat] Attempt ${attempt} (non-stream) response was empty.`);
            recordFailure(body.model, promptSize);
            continue;
          }

          recordSuccess(body.model, promptSize);
          parsedResult = parsed;
          finalUiSessionId = result.uiSessionId;
          break;
        } catch (err: any) {
          console.error(`[Chat] Attempt ${attempt} (non-stream) failed:`, err.message);
          lastError = err;
          recordFailure(body.model, promptSize);
          if (attempt >= maxAttempts) break;
          await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
        }
      }

      if (!parsedResult) {
        throw lastError || new Error("Failed to get a non-empty response from DeepSeek after multiple attempts.");
      }

      const message: any = {
        role: 'assistant',
        content: parsedResult.toolCalls.length > 0 ? null : parsedResult.content
      };
      if (parsedResult.reasoningContent) message.reasoning_content = parsedResult.reasoningContent;
      if (parsedResult.toolCalls.length > 0) message.tool_calls = parsedResult.toolCalls;

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message,
          logprobs: null,
          finish_reason: parsedResult.finishReason
        }],
        usage: parsedResult.usage
      });
    }

    // Streaming mode
    let deepSeekStream: ReadableStream | null = null;
    let uiSessionId = '';
    let attempt = 0;
    const maxAttempts = 3;
    let lastError: any = null;
    let promptSizeUsed = 0;

    while (attempt < maxAttempts) {
      attempt++;
      const telemetry = getModelTelemetry(body.model);
      const currentTargetLimit = telemetry.detectedLimit;

      const compressed = compressMessages(messages, currentTargetLimit, serializeOpenAIMessages);
      const serialized = serializeOpenAIMessages(compressed);
      const systemPrompt = appendToolInstructions(serialized.systemPrompt, body);
      const finalPrompt = systemPrompt ? `${systemPrompt}\n${serialized.prompt}` : serialized.prompt;
      promptSizeUsed = finalPrompt.length;

      try {
        console.log(`[Chat] Attempt ${attempt}/${maxAttempts} (stream) with prompt length ${promptSizeUsed} chars.`);
        const result = await createDeepSeekStream(finalPrompt, isThinkingModel, isProModel, null);

        const { isEmpty, peekedStream } = await peekStream(result.stream);
        if (isEmpty) {
          console.warn(`[Chat] Attempt ${attempt} (stream) peeked stream was empty.`);
          recordFailure(body.model, promptSizeUsed);
          continue;
        }

        recordSuccess(body.model, promptSizeUsed);
        deepSeekStream = peekedStream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        console.error(`[Chat] Attempt ${attempt} (stream) failed:`, err.message);
        lastError = err;
        recordFailure(body.model, promptSizeUsed);
        if (attempt >= maxAttempts) break;
        await new Promise(r => setTimeout(r, getRetryDelay(attempt)));
      }
    }

    if (!deepSeekStream) {
      throw lastError || new Error("Failed to get a valid stream from DeepSeek after multiple attempts.");
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');

    const promptTokens = Math.ceil(promptSizeUsed / 3.5);

    return honoStream(c, async (streamWriter: any) => {
      const writeEvent = async (data: any) => {
        await streamWriter.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      await writeEvent(makeChunk(completionId, body.model, { role: 'assistant', content: '' }));

      const parsed = await parseDeepSeekStreamToOpenAI(
        deepSeekStream!,
        completionId,
        body.model,
        promptTokens,
        uiSessionId,
        (body as any).tools || [],
        writeEvent
      );

      await writeEvent(makeChunk(completionId, body.model, {}, parsed.finishReason, parsed.usage));
      await streamWriter.write('data: [DONE]\n\n');
    });
  } catch (err: any) {
    console.error('Error in chatCompletions:', err);
    const errMessage = err?.message || String(err);

    let status = 500;
    let code = 'upstream_error';
    if (/account is suspended/i.test(errMessage)) {
      status = 403;
      code = 'deepseek_account_suspended';
    } else if (/login is required/i.test(errMessage)) {
      status = 401;
      code = 'deepseek_login_required';
    } else if (/chat input unavailable|Timeout waiting for chat input/i.test(errMessage)) {
      status = 409;
      code = 'deepseek_chat_unavailable';
    }

    return c.json({ error: { message: errMessage, type: code, code } }, status as any);
  }
}
