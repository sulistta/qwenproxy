import { Context } from 'hono';
import crypto from 'crypto';
import {
  createQwenStream,
  QwenUpstreamError,
  RetryableQwenStreamError,
  type QwenChatType,
  type QwenStreamOptions,
} from '../services/qwen.js';
import {
  getAccountCooldownInfo,
  getNextAccount,
  getNextAvailableAccount,
  markAccountRateLimited,
} from '../core/account-manager.js';
import {
  extractWebSearchSources,
  getCitedWebSearchSources,
} from '../utils/qwen-stream-parser.js';
import type { QwenReasoningEffort, WebSearchSource } from '../utils/types.js';

interface NativeStreamRequest {
  prompt: string;
  model: string;
  reasoningEffort: QwenReasoningEffort;
  webSearch: boolean;
  options: QwenStreamOptions;
}

interface NativeCollection {
  text: string;
  reasoning: string;
  images: Array<{ url: string; extra?: Record<string, unknown> }>;
  sources: WebSearchSource[];
}

function appendMaybeCumulative(current: string, next: string): string {
  if (!current) return next;
  if (next.startsWith(current)) return next;
  return current + next;
}

async function createNativeStream(request: NativeStreamRequest) {
  let account = getNextAccount();
  const triedAccountIds = new Set<string>();
  let lastError: any = null;

  while (account) {
    const accountId = account.id;
    const accountEmail = account.email;

    if (triedAccountIds.has(accountId)) {
      account = getNextAvailableAccount(accountId);
      continue;
    }
    triedAccountIds.add(accountId);

    const cooldownInfo = getAccountCooldownInfo(accountId);
    if (cooldownInfo && accountId !== 'global') {
      console.log(`[NativeTools] Skipping account ${accountEmail} (${accountId}) — on cooldown for ${Math.round(cooldownInfo.remainingMs / 1000)}s (${cooldownInfo.reason})`);
      account = getNextAvailableAccount(accountId);
      continue;
    }

    console.log(`[NativeTools] Routing ${request.options.chatType || 't2t'} request to account: ${accountEmail} (${accountId})`);

    let retries = 3;
    let retryDelay = 500;
    while (retries > 0) {
      try {
        return await createQwenStream(
          request.prompt,
          request.reasoningEffort,
          request.webSearch,
          request.model,
          null,
          accountId === 'global' ? undefined : accountId,
          undefined,
          undefined,
          request.options,
        );
      } catch (err: any) {
        retries--;

        if (err.upstreamCode === 'RateLimited' || err.upstreamStatus === 429) {
          const hourHint = err.message?.match(/Wait about (\d+) hour/);
          const cooldownMs = hourHint ? parseInt(hourHint[1], 10) * 60 * 60 * 1000 : undefined;
          markAccountRateLimited(accountId, cooldownMs, 'RateLimited');
          lastError = err;
          break;
        }

        if (retries === 0) {
          if (err.upstreamStatus && err.upstreamStatus >= 500) {
            markAccountRateLimited(accountId, undefined, 'ServerError');
          }
          lastError = err;
          break;
        }

        const useDelay = err instanceof RetryableQwenStreamError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : retryDelay;
        const isRetryable = err instanceof RetryableQwenStreamError
          || err.message?.includes('in progress')
          || err.message?.includes('Bad_Request');
        if (!isRetryable) {
          lastError = err;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, useDelay));
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    }

    account = getNextAvailableAccount(accountId);
  }

  throw lastError || new Error('All accounts failed');
}

async function collectNativeStream(stream: ReadableStream): Promise<NativeCollection> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let sources: WebSearchSource[] = [];
  const images: Array<{ url: string; extra?: Record<string, unknown> }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      let chunk: any;
      try {
        chunk = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (chunk.error) {
        const message = chunk.error.details || chunk.error.message || JSON.stringify(chunk.error);
        throw new QwenUpstreamError(`Qwen upstream error: ${message}`, chunk.error.code || 'UpstreamError', 502);
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.phase === 'web_search') {
        const extracted = extractWebSearchSources(delta);
        if (extracted.length > 0) sources = extracted;
        continue;
      }
      if (delta.phase === 'thinking_summary') {
        const thoughts = delta.extra?.summary_thought?.content;
        if (Array.isArray(thoughts)) reasoning = thoughts.join('\n');
        continue;
      }
      if (delta.phase === 'think' && typeof delta.content === 'string') {
        reasoning = appendMaybeCumulative(reasoning, delta.content);
        continue;
      }
      if (delta.phase === 'image_gen' && typeof delta.content === 'string' && delta.content) {
        images.push({ url: delta.content, ...(delta.extra ? { extra: delta.extra } : {}) });
        continue;
      }
      if (delta.phase === 'answer' && typeof delta.content === 'string') {
        text = appendMaybeCumulative(text, delta.content);
      }
    }
  }

  return { text, reasoning, images, sources: getCitedWebSearchSources(text, sources) };
}

function jsonError(c: Context, err: any) {
  const status = err?.upstreamStatus || 502;
  return c.json({
    error: {
      message: err?.message || 'Qwen native tool request failed',
      type: 'upstream_error',
    },
  }, status as any);
}

function parseString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export async function deepResearch(c: Context) {
  try {
    const body = await c.req.json();
    const query = parseString(body.query ?? body.prompt, 'query');
    const model = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : 'qwen3.7-plus';
    const result = await createNativeStream({
      prompt: query,
      model,
      reasoningEffort: 'auto',
      webSearch: true,
      options: {
        chatType: 'deep_research',
        researchMode: 'deep',
        autoSearch: true,
      },
    });
    const collection = await collectNativeStream(result.stream);
    return c.json({
      id: `research-${crypto.randomUUID()}`,
      object: 'deep_research.result',
      created: Math.floor(Date.now() / 1000),
      model,
      report: collection.text,
      reasoning_content: collection.reasoning || undefined,
      sources: collection.sources,
    });
  } catch (err: any) {
    if (err.message?.includes('query must')) {
      return c.json({ error: { message: err.message, type: 'invalid_request_error', param: 'query' } }, 400);
    }
    return jsonError(c, err);
  }
}

function normalizeImageSize(size: unknown): string | undefined {
  if (size === undefined) return undefined;
  if (typeof size !== 'string' || !/^\d+:\d+$/.test(size)) {
    throw new Error('size must be an aspect ratio like "1:1", "16:9", or "9:16"');
  }
  return size;
}

export async function imageGenerations(c: Context) {
  try {
    const body = await c.req.json();
    const prompt = parseString(body.prompt, 'prompt');
    const model = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : 'qwen3.7-plus';
    const size = normalizeImageSize(body.size);
    const result = await createNativeStream({
      prompt,
      model,
      reasoningEffort: 'thinking',
      webSearch: false,
      options: {
        chatType: 't2i' as QwenChatType,
        size,
        imageGeneration: true,
      },
    });
    const collection = await collectNativeStream(result.stream);
    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: collection.images.map(image => ({
        url: image.url,
        ...(collection.text ? { revised_prompt: collection.text } : {}),
        ...(image.extra ? { qwen_extra: image.extra } : {}),
      })),
      ...(collection.reasoning ? { reasoning_content: collection.reasoning } : {}),
    });
  } catch (err: any) {
    if (err.message?.includes('prompt must')) {
      return c.json({ error: { message: err.message, type: 'invalid_request_error', param: 'prompt' } }, 400);
    }
    if (err.message?.includes('size must')) {
      return c.json({ error: { message: err.message, type: 'invalid_request_error', param: 'size' } }, 400);
    }
    return jsonError(c, err);
  }
}
