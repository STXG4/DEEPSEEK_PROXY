/*
 * File: index.ts
 * Project: deepsproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createHash, timingSafeEqual } from 'crypto';
import { chatCompletions } from './routes/chat.ts';
import * as dotenv from 'dotenv';
import { initPlaywright } from './services/playwright.ts';
import { getContextLength } from './services/telemetry.ts';

dotenv.config();

export const app = new Hono();

function modelEntry(id: string) {
  const dynamicLimit = getContextLength(id);
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
    context_length: dynamicLimit,
    max_context_tokens: dynamicLimit,
    max_input_tokens: dynamicLimit,
    max_output_tokens: 8_000,
  };
}

// ─── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : undefined;

app.use('*', cors(allowedOrigins ? { origin: allowedOrigins } : {}));

// ─── Body Size Limit ───────────────────────────────────────────────────────────
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '1048576', 10); // 1MB default

app.use('*', async (c, next) => {
  const contentLength = c.req.header('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return c.json({ error: 'Payload Too Large' }, 413);
  }
  await next();
});

// ─── Rate Limiting (sliding window) ────────────────────────────────────────────
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);
const RATE_LIMIT_BURST = parseInt(process.env.RATE_LIMIT_BURST || '10', 10);
const rateLimitStore = new Map<string, number[]>();

app.use('*', async (c, next) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;

  let timestamps = rateLimitStore.get(ip) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);

  if (timestamps.length >= RATE_LIMIT_RPM) {
    return c.json({ error: 'Too Many Requests' }, 429);
  }

  // Burst check: max N requests in last second
  const oneSecAgo = now - 1000;
  const recentCount = timestamps.filter(t => t > oneSecAgo).length;
  if (recentCount >= RATE_LIMIT_BURST) {
    return c.json({ error: 'Too Many Requests' }, 429);
  }

  timestamps.push(now);
  rateLimitStore.set(ip, timestamps);
  await next();
});

// ─── Auth ──────────────────────────────────────────────────────────────────────
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to avoid leaking length info via timing
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || !secureCompare(providedKey, apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

// Basic health check
app.get('/health', (c) => c.json({ status: 'ok' }));

// OpenAI compatible routes
app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      modelEntry('deepseek-v4-flash'),
      modelEntry('deepseek-v4-flash-thinking'),
      modelEntry('deepseek-v4-pro'),
      modelEntry('deepseek-v4-pro-thinking')
    ]
  });
});

// Initialize playwright when server starts
import { fileURLToPath } from 'url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.API_KEY) {
    console.warn('[Security] API_KEY not set - all endpoints are open');
  }

  initPlaywright().then(() => {
    console.log('Playwright initialized.');
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    console.log(`Server is running on port ${port}`);

    serve({
      fetch: app.fetch,
      port
    });
  }).catch((err: any) => {
    console.error('Failed to initialize playwright:', err);
    process.exit(1);
  });
}
