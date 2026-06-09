import test from 'node:test';
import assert from 'node:assert';

import { app } from '../api/server.js';
import { enablePlaywrightMock } from '../core/test-mode.js';
import { closePlaywright, initPlaywright } from '../services/playwright.js';

enablePlaywrightMock();

test('deep research endpoint uses Qwen deep_research mode and returns cited sources', async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload: any = null;

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayload = JSON.parse(String(init?.body || '{}'));
      const sse = [
        'data: {"choices":[{"delta":{"phase":"web_search","extra":{"web_search_info":['
          + '{"url":"https://example.com/source","title":"Research source","snippet":"Evidence"}'
          + ']}}}]}',
        'data: {"choices":[{"delta":{"phase":"answer","content":"Research report [[1]]"}}]}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return originalFetch(input, init);
  };

  await initPlaywright(false);

  try {
    const res = await app.fetch(new Request('http://localhost/v1/deep-research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Research current React docs' }),
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.report, 'Research report [[1]]');
    assert.deepStrictEqual(body.sources, [{
      citation_index: 1,
      url: 'https://example.com/source',
      title: 'Research source',
      snippet: 'Evidence',
    }]);
    assert.strictEqual(capturedPayload.messages[0].chat_type, 'deep_research');
    assert.strictEqual(capturedPayload.messages[0].sub_chat_type, 'deep_research');
    assert.strictEqual(capturedPayload.messages[0].feature_config.research_mode, 'deep');
    assert.strictEqual(capturedPayload.messages[0].feature_config.auto_search, true);
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('image generations endpoint uses Qwen t2i mode and returns image URLs', async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload: any = null;

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayload = JSON.parse(String(init?.body || '{}'));
      const sse = [
        'data: {"choices":[{"delta":{"phase":"answer","content":"refined prompt"}}]}',
        'data: {"choices":[{"delta":{"phase":"image_gen","content":"https://example.com/image.png","extra":{"seed":123}}}]}',
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return originalFetch(input, init);
  };

  await initPlaywright(false);

  try {
    const res = await app.fetch(new Request('http://localhost/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A product photo', size: '1:1' }),
    }));

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.data, [{
      url: 'https://example.com/image.png',
      revised_prompt: 'refined prompt',
      qwen_extra: { seed: 123 },
    }]);
    assert.strictEqual(capturedPayload.messages[0].chat_type, 't2i');
    assert.strictEqual(capturedPayload.messages[0].sub_chat_type, 't2i');
    assert.strictEqual(capturedPayload.size, '1:1');
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});
