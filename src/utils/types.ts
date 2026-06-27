/*
 * File: types.ts
 * Project: deepsproxy
 * Re-exports from canonical types/openai.ts for backwards compatibility.
 */

export type {
  JsonSchema,
  FunctionToolDefinition,
  ToolChoice,
  ToolCallFunction,
  MessageToolCall,
  Message,
  OpenAIRequest,
  ToolCall,
  ChoiceDelta,
  Choice,
  Usage,
  ChatCompletionChunk,
} from '../types/openai.ts';
