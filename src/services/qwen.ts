import { getQwenHeaders, getBasicHeaders } from './playwright.js';
import { getMockSessionId, isPlaywrightMockEnabled } from '../core/test-mode.js';
import type { QwenReasoningEffort } from '../utils/types.js';
import crypto from 'crypto';

const CACHED_TIMEZONE = new Date().toString().split(' (')[0];

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RetryableQwenStreamError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string;
  readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message);
    this.name = 'QwenUpstreamError';
    this.upstreamCode = upstreamCode;
    this.upstreamStatus = upstreamStatus;
  }
}

interface SessionEntry {
  parentId: string | null;
  timestamp: number;
}

const sessionStates: Map<string, SessionEntry> = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, entry] of sessionStates.entries()) {
    if (now - entry.timestamp > SESSION_TTL_MS) {
      sessionStates.delete(key);
    }
  }
}

export function updateSessionParent(sessionId: string, parentId: string | null) {
  if (sessionId) {
    if (sessionStates.size > 10000) cleanupStaleSessions();
    sessionStates.set(sessionId, { parentId, timestamp: Date.now() });
  }
}

function getSessionParent(sessionId: string): string | null | undefined {
  const entry = sessionStates.get(sessionId);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > SESSION_TTL_MS) {
    sessionStates.delete(sessionId);
    return undefined;
  }
  return entry.parentId;
}

interface WarmPoolEntry {
  chatId: string;
  headers: Record<string, string>;
  accountId: string;
  timestamp: number;
}

const warmPool: Map<string, WarmPoolEntry[]> = new Map();

const refillPromises: Map<string, Promise<void>> = new Map();

const WARM_POOL_SIZE = 5;
const WARM_POOL_TTL_MS = 10 * 60 * 1000;

function cleanupStalePool(accountId: string) {
  const pool = warmPool.get(accountId);
  if (!pool) return;
  const now = Date.now();
  const filtered = pool.filter(e => now - e.timestamp <= WARM_POOL_TTL_MS);
  if (filtered.length !== pool.length) warmPool.set(accountId, filtered);
}

async function getBasicQwenHeaders(accountId?: string): Promise<Record<string, string>> {
  const { cookie, userAgent, bxV } = await getBasicHeaders(accountId);
  return {
    cookie,
    'user-agent': userAgent,
    'bx-v': bxV,
  };
}

async function createRealQwenChat(
  header: Record<string, string>,
  model = 'qwen3.7-plus',
  chatType = 't2t',
): Promise<string> {
  const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      cookie: header['cookie'],
      origin: 'https://chat.qwen.ai',
      referer: 'https://chat.qwen.ai/c/new-chat',
      'user-agent': header['user-agent'],
      'x-request-id': crypto.randomUUID(),
      'bx-v': header['bx-v'],
    },
    body: JSON.stringify({
      title: 'Nova Conversa',
      models: [model],
      chat_mode: 'normal',
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: '',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) throw new Error(`Failed to create chat: ${response.status}`);
  const json = await response.json();
  const chatId = json.chat_id || json.id || json.data?.chat_id || json.data?.id;
  if (!chatId) throw new Error(`Unexpected chat response: ${JSON.stringify(json).slice(0, 200)}`);
  return chatId;
}

async function refillPoolForAccount(accountId: string) {
  let pool = warmPool.get(accountId);
  if (!pool) { pool = []; warmPool.set(accountId, pool); }
  cleanupStalePool(accountId);
  const need = Math.max(0, WARM_POOL_SIZE - pool.length);
  if (need === 0) return;

  let headers: Record<string, string>;
  try {
    headers = await getBasicQwenHeaders(accountId === 'global' ? undefined : accountId);
  } catch (err) {
    console.error(`[WarmPool] header fetch failed for ${accountId}:`, (err as Error).message);
    return;
  }

  const creationPromises = Array.from({ length: need }, async () => {
    try {
      const chatId = await createRealQwenChat(headers);
      return { chatId, headers, accountId, timestamp: Date.now() };
    } catch (err) {
      console.error(`[WarmPool] chat creation failed for ${accountId}:`, (err as Error).message);
      return null;
    }
  });

  const results = await Promise.all(creationPromises);
  for (const entry of results) {
    if (entry) pool.push(entry);
  }
}

export async function getWarmedChat(accountId?: string) {
  const key = accountId || 'global';
  if (isPlaywrightMockEnabled()) {
    return {
      chatId: getMockSessionId(),
      headers: await getBasicQwenHeaders(undefined),
      accountId: key,
      timestamp: Date.now(),
    };
  }

  let pool = warmPool.get(key);
  if (!pool) { pool = []; warmPool.set(key, pool); }
  cleanupStalePool(key);
  if (pool.length === 0) {
    if (!refillPromises.has(key)) {
      refillPromises.set(key, refillPoolForAccount(key).finally(() => refillPromises.delete(key)));
    }
    await refillPromises.get(key);
  }
  if (pool.length === 0) throw new Error(`Warm pool empty for ${key}`);
  return pool.shift()!;
}

export async function warmAllPools(accountIds: string[]) {
  for (const id of accountIds) refillPoolForAccount(id).catch(() => {});
}

export interface QwenMessage {
  fid: string;
  parentId: string | null;
  childrenIds: string[];
  role: 'user' | 'assistant';
  content: string;
  user_action: string;
  files: any[];
  timestamp: number;
  models: string[];
  chat_type: string;
  feature_config: {
    thinking_enabled: boolean;
    output_schema: string;
    research_mode: string;
    auto_thinking: boolean;
    thinking_mode: string;
    thinking_format?: string;
    auto_search: boolean;
    thinking_budget?: number;
  };
  extra: {
    meta: {
      subChatType: string;
    };
  };
  sub_chat_type: string;
  parent_id: string | null;
}

export interface QwenPayload {
  stream: boolean;
  version: string;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: string;
  model: string;
  parent_id: string | null;
  messages: QwenMessage[];
  timestamp: number;
  size?: string;
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

interface NativeToolCapabilities {
  webSearch: boolean;
  imageGeneration: boolean;
}

const nativeToolsConfigured = new Map<string, NativeToolCapabilities>();
const nativeToolsConfigurationPromises = new Map<string, Promise<void>>();

function coversNativeTools(
  current: NativeToolCapabilities | undefined,
  target: NativeToolCapabilities,
): boolean {
  return Boolean(
    current
      && (!target.webSearch || current.webSearch)
      && (!target.imageGeneration || current.imageGeneration)
  );
}

function mergeNativeTools(
  current: NativeToolCapabilities | undefined,
  target: NativeToolCapabilities,
): NativeToolCapabilities {
  return {
    webSearch: Boolean(current?.webSearch || target.webSearch),
    imageGeneration: Boolean(current?.imageGeneration || target.imageGeneration),
  };
}

export async function configureNativeTools(
  accountId?: string,
  requested: Partial<NativeToolCapabilities> = { webSearch: true },
): Promise<void> {
  const cacheKey = accountId || 'global';
  const target: NativeToolCapabilities = {
    webSearch: Boolean(requested.webSearch),
    imageGeneration: Boolean(requested.imageGeneration),
  };
  if (coversNativeTools(nativeToolsConfigured.get(cacheKey), target)) return;
  if (isPlaywrightMockEnabled()) {
    nativeToolsConfigured.set(cacheKey, mergeNativeTools(nativeToolsConfigured.get(cacheKey), target));
    return;
  }
  const existing = nativeToolsConfigurationPromises.get(cacheKey);
  if (existing) {
    await existing;
    if (coversNativeTools(nativeToolsConfigured.get(cacheKey), target)) return;
  }

  const configuration = (async () => {
    try {
      const { headers } = await getQwenHeaders(false, accountId);
      const enabledTools = mergeNativeTools(nativeToolsConfigured.get(cacheKey), target);

      const payload = {
        tools_enabled: {
          web_extractor: false,
          web_search_image: false,
          web_search: enabledTools.webSearch,
          image_gen_tool: enabledTools.imageGeneration,
          code_interpreter: false,
          history_retriever: false,
          image_edit_tool: false,
          bio: false,
          image_zoom_in_tool: false,
          image_search: false
        }
      };

      console.log(`[Qwen] Configuring native tool capabilities for ${cacheKey}...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let response: Response;
      try {
        response = await fetch('https://chat.qwen.ai/api/v2/users/user/settings/update', {
          method: 'POST',
          headers: {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9',
            'content-type': 'application/json',
            'cookie': headers['cookie'],
            'origin': 'https://chat.qwen.ai',
            'referer': 'https://chat.qwen.ai/',
            'user-agent': headers['user-agent'],
            'x-request-id': crypto.randomUUID(),
            'bx-ua': headers['bx-ua'],
            'bx-umidtoken': headers['bx-umidtoken'],
            'bx-v': headers['bx-v']
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to configure native tools: ${response.status} - ${text}`);
      }
      console.log(`[Qwen] Native tool capabilities configured for ${cacheKey}.`);
      nativeToolsConfigured.set(cacheKey, enabledTools);
    } catch (err: any) {
      console.error(`[Qwen] Error configuring native tools for ${cacheKey}: ${err.message}`);
      throw err;
    } finally {
      nativeToolsConfigurationPromises.delete(cacheKey);
    }
  })();

  nativeToolsConfigurationPromises.set(cacheKey, configuration);
  return configuration;
}

export async function fetchQwenModels(accountId?: string): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) {
    return cachedModels;
  }

  const { cookie, userAgent, bxV } = await getBasicHeaders(accountId);

  const response = await fetch('https://chat.qwen.ai/api/models', {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9',
      'cookie': cookie,
      'referer': 'https://chat.qwen.ai/',
      'user-agent': userAgent,
      'x-request-id': crypto.randomUUID(),
      'bx-v': bxV,
      'timezone': CACHED_TIMEZONE,
      'source': 'web'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  if (json.data && Array.isArray(json.data)) {
    const models = json.data.map((m: any) => ({
      id: m.id,
      object: 'model',
      created: m.info?.created_at || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by || 'qwen'
    }));

    const hasPlus = models.some((m: any) => m.id === 'qwen3.7-plus');
    const base = [
      ...models,
      ...(hasPlus ? [] : [{ id: 'qwen3.7-plus', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'qwen' }])
    ];

    const extendedModels = [
      ...base,
      ...base.map((m: any) => ({ ...m, id: `${m.id}-no-thinking` }))
    ];

    cachedModels = extendedModels;
    lastModelsFetch = now;
    return extendedModels;
  }

  return [];
}

export interface QwenFileEntry {
  type: string;
  file: any;
  id: string;
  url: string;
  name: string;
  [key: string]: any;
}

export type QwenChatType = 't2t' | 'search' | 't2i' | 'deep_research' | 'artifacts' | 'learn' | 'image_edit';

export interface QwenStreamOptions {
  chatType?: QwenChatType;
  size?: string;
  researchMode?: 'normal' | 'deep';
  autoSearch?: boolean;
  imageGeneration?: boolean;
}

async function getChatForRequest(
  accountId: string | undefined,
  model: string,
  chatType: QwenChatType,
): Promise<WarmPoolEntry> {
  if (chatType === 't2t') {
    return getWarmedChat(accountId);
  }

  const key = accountId || 'global';
  if (isPlaywrightMockEnabled()) {
    return {
      chatId: getMockSessionId(),
      headers: await getBasicQwenHeaders(undefined),
      accountId: key,
      timestamp: Date.now(),
    };
  }

  const headers = await getBasicQwenHeaders(accountId);
  const chatId = await createRealQwenChat(headers, model, chatType);
  return { chatId, headers, accountId: key, timestamp: Date.now() };
}

export async function createQwenStream(
  prompt: string,
  reasoningEffort: QwenReasoningEffort,
  webSearch: boolean,
  modelId: string,
  forcedParentId?: string | null,
  accountId?: string,
  files?: QwenFileEntry[],
  pendingMultimodal?: Array<Array<{ type: string; text?: string; image_url?: { url: string }; video_url?: { url: string }; audio_url?: { url: string }; file_url?: { url: string } }>>,
  options: QwenStreamOptions = {},
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string, controller: AbortController, accountId: string }> {
  const chatType = options.chatType ?? 't2t';
  const model = modelId.replace('-no-thinking', '');
  const autoSearch = options.autoSearch ?? webSearch;
  if (autoSearch || options.imageGeneration) {
    await configureNativeTools(accountId, {
      webSearch: autoSearch,
      imageGeneration: Boolean(options.imageGeneration),
    });
  }

  let chatEntry: WarmPoolEntry;
  try {
    chatEntry = await getChatForRequest(accountId, model, chatType);
  } catch (err: any) {
    if (err.message?.includes('chat is in progress') || err.message?.includes('The chat is in progress')) {
      const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
      throw new RetryableQwenStreamError(`Qwen: ${err.message}`, retryAfterMs);
    }
    throw err;
  }

  const chatId = chatEntry.chatId;
  const chatHeaders = chatEntry.headers;
  const actualParentId: string | null = forcedParentId !== undefined
    ? forcedParentId
    : getSessionParent(chatId) ?? null;

  // Process pending multimodal uploads — requires full headers with bx-ua/bx-umidtoken
  let resolvedFiles = files || [];
  if (pendingMultimodal && pendingMultimodal.length > 0 && resolvedFiles.length === 0) {
    try {
      const { processImagesForQwen } = await import('../routes/upload.ts');
      const { headers: fullHeaders } = await getQwenHeaders(false, accountId);
      const uploadHeaders: Record<string, string> = {
        cookie: fullHeaders['cookie'] || chatHeaders['cookie'] || '',
        'user-agent': fullHeaders['user-agent'] || chatHeaders['user-agent'] || '',
        'bx-ua': fullHeaders['bx-ua'] || '',
        'bx-umidtoken': fullHeaders['bx-umidtoken'] || '',
        'bx-v': fullHeaders['bx-v'] || chatHeaders['bx-v'] || '',
      };
      if (!uploadHeaders['bx-ua']) {
        console.warn('[Qwen] Missing bx-ua header for multimodal upload, attempting forced refresh...');
        const { headers: refreshedHeaders } = await getQwenHeaders(true, accountId);
        uploadHeaders['cookie'] = refreshedHeaders['cookie'] || uploadHeaders['cookie'];
        uploadHeaders['user-agent'] = refreshedHeaders['user-agent'] || uploadHeaders['user-agent'];
        uploadHeaders['bx-ua'] = refreshedHeaders['bx-ua'] || '';
        uploadHeaders['bx-umidtoken'] = refreshedHeaders['bx-umidtoken'] || '';
        uploadHeaders['bx-v'] = refreshedHeaders['bx-v'] || uploadHeaders['bx-v'];
      }
      const results = await Promise.all(
        pendingMultimodal.map(parts => processImagesForQwen(parts, uploadHeaders))
      );
      for (const r of results) {
        resolvedFiles.push(...r.files);
      }
    } catch (err: any) {
      console.error('[Qwen] Failed to process multimodal uploads:', err.message);
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const fid = crypto.randomUUID();
  const thinkingEnabled = chatType === 'deep_research' || reasoningEffort !== 'fast';
  const autoThinking = chatType === 'deep_research' || reasoningEffort === 'auto';
  const thinkingMode = autoThinking
    ? 'Auto'
    : reasoningEffort === 'thinking'
      ? 'Thinking'
      : 'Fast';
  const researchMode = options.researchMode ?? (chatType === 'deep_research' ? 'deep' : 'normal');

  const payload: QwenPayload = {
    stream: true,
    version: '2.1',
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    model: model,
    parent_id: actualParentId,
    messages: [
      {
        fid: fid,
        parentId: actualParentId,
        childrenIds: [],
        role: 'user',
        content: prompt,
        user_action: 'chat',
        files: resolvedFiles,
        timestamp: timestamp,
        models: [model],
        chat_type: chatType,
        feature_config: {
          thinking_enabled: thinkingEnabled,
          output_schema: 'phase',
          research_mode: researchMode,
          auto_thinking: autoThinking,
          thinking_mode: thinkingMode,
          ...(thinkingEnabled ? { thinking_format: 'summary' } : {}),
          ...(chatType !== 't2t' && !thinkingEnabled ? { thinking_budget: 81920 } : {}),
          auto_search: autoSearch
        },
        extra: {
          meta: {
            subChatType: chatType
          }
        },
        sub_chat_type: chatType,
        parent_id: actualParentId
      }
    ],
    timestamp: timestamp + 1
  };
  if (options.size && (chatType === 't2i' || chatType === 'image_edit')) {
    payload.size = options.size;
  }

  const url = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'accept-language': 'pt-BR,pt;q=0.9',
      'content-type': 'application/json',
      'cookie': chatHeaders['cookie'],
      'origin': 'https://chat.qwen.ai',
      'referer': `https://chat.qwen.ai/c/${chatId}`,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'timezone': CACHED_TIMEZONE,
      'user-agent': chatHeaders['user-agent'],
      'x-accel-buffering': 'no',
      'x-request-id': crypto.randomUUID(),
      'bx-v': chatHeaders['bx-v'],
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      try {
        const errorJson = JSON.parse(errText);
        if (errorJson?.data?.details?.includes('chat is in progress') ||
            errorJson?.data?.details?.includes('The chat is in progress')) {
          const retryAfterMs = 2000 + Math.floor(Math.random() * 2000);
          throw new RetryableQwenStreamError(
            `Qwen: ${errorJson.data.details}`,
            retryAfterMs,
          );
        }
        if (errorJson?.success === false) {
          const code = errorJson.data?.code || errorJson.code || 'UpstreamError';
          const details = errorJson.data?.details || errorJson.message || 'Qwen returned an error';
          const wait = errorJson.data?.num !== undefined
            ? ` Wait about ${errorJson.data.num} hour(s) before trying again.`
            : '';
          let status: number;
          if (code === 'RateLimited') status = 429;
          else if (code === 'Not_Found') status = 404;
          else if (code === 'UpstreamError') status = 502;
          else status = 502;
          throw new QwenUpstreamError(
            `Qwen upstream error: ${code}: ${details}.${wait}`,
            code,
            status,
          );
        }
        if (errorJson?.data?.details?.includes('is not exist') ||
            errorJson?.data?.details?.includes('not exist') ||
            errorJson.data?.details?.includes('does not exist')) {
          throw new RetryableQwenStreamError(
            `Qwen: ${errorJson.data.details}`,
            0,
          );
        }
      } catch (parseOrRetryError) {
        if (parseOrRetryError instanceof RetryableQwenStreamError ||
            parseOrRetryError instanceof QwenUpstreamError) {
          throw parseOrRetryError;
        }
      }
    }
    throw new Error(`Failed to fetch from Qwen: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers: chatHeaders, uiSessionId: chatId, controller, accountId: chatEntry.accountId };
}
