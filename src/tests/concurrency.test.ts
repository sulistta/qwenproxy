import test from 'node:test';
import assert from 'node:assert';

import { app } from '../api/server.js';
import { enablePlaywrightMock } from '../core/test-mode.js';
import { initPlaywright, closePlaywright } from '../services/playwright.js';

enablePlaywrightMock();

test('Concurrent requests are serialized by mutex', async () => {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ 
        data: [{ id: 'qwen3.6-plus', owned_by: 'qwen', info: { created_at: Date.now(), meta: {} } }] 
      }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    const promises = Array.from({ length: 5 }, (_, i) =>
      app.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3.6-plus',
            messages: [{ role: 'user', content: `Request ${i}` }],
            stream: false
          })
        })
      )
    );

    const responses = await Promise.all(promises);
    
    // All requests should complete (serialized by mutex)
    for (const res of responses) {
      assert.ok(
        res.status === 200 || res.status === 429 || res.status === 502,
        `Unexpected status: ${res.status}`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('No-thinking model variant is accepted', async () => {
  const originalFetch = globalThis.fetch;
  
  globalThis.fetch = async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) {
      return new Response(JSON.stringify({ 
        data: [{ id: 'qwen3.6-plus', owned_by: 'qwen', info: { created_at: Date.now(), meta: { max_context_length: 1000000 } } }] 
      }), { status: 200 });
    }
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(
        'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return originalFetch(input);
  };

  await initPlaywright(false);

  try {
    // Test no-thinking model is accepted without error
    const res = await app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus-no-thinking',
          messages: [{ role: 'user', content: 'Test' }],
          stream: false
        })
      })
    );

    assert.ok(
      res.status === 200 || res.status === 429 || res.status === 502,
      `No-thinking model should be accepted, got status: ${res.status}`
    );
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('reasoning_effort maps to the Qwen feature configuration', async () => {
  const originalFetch = globalThis.fetch;
  const capturedFeatureConfigs: any[] = [];

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const payload = JSON.parse(String(init?.body || '{}'));
      capturedFeatureConfigs.push(payload.messages[0].feature_config);
      return new Response(
        'data: {"choices": [{"delta": {"phase": "answer", "content": "OK"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return originalFetch(input, init);
  };

  await initPlaywright(false);

  try {
    const cases = [
      {
        model: 'qwen3.6-plus',
        reasoning_effort: 'auto',
        expected: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: false,
        },
      },
      {
        model: 'qwen3.6-plus',
        reasoning_effort: 'thinking',
        expected: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: false,
        },
      },
      {
        model: 'qwen3.6-plus',
        reasoning_effort: 'fast',
        expected: {
          thinking_enabled: false,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Fast',
          auto_search: false,
        },
      },
      {
        model: 'qwen3.6-plus-no-thinking',
        expected: {
          thinking_enabled: false,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Fast',
          auto_search: false,
        },
      },
      {
        model: 'qwen3.6-plus-no-thinking',
        reasoning_effort: 'auto',
        expected: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: true,
          thinking_mode: 'Auto',
          thinking_format: 'summary',
          auto_search: false,
        },
      },
      {
        model: 'qwen3.6-plus',
        reasoning_effort: 'thinking',
        web_search: true,
        expected: {
          thinking_enabled: true,
          output_schema: 'phase',
          research_mode: 'normal',
          auto_thinking: false,
          thinking_mode: 'Thinking',
          thinking_format: 'summary',
          auto_search: true,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const res = await app.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: testCase.model,
            messages: [{ role: 'user', content: 'Test' }],
            stream: false,
            ...('reasoning_effort' in testCase
              ? { reasoning_effort: testCase.reasoning_effort }
              : {}),
            ...('web_search' in testCase
              ? { web_search: testCase.web_search }
              : {}),
          }),
        })
      );

      assert.strictEqual(res.status, 200);
    }

    assert.deepStrictEqual(
      capturedFeatureConfigs,
      cases.map(testCase => testCase.expected)
    );
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});

test('invalid reasoning_effort returns an OpenAI-style 400 response', async () => {
  const res = await app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Test' }],
        reasoning_effort: 'slow',
      }),
    })
  );

  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error.param, 'reasoning_effort');
  assert.match(body.error.message, /auto, thinking, fast/);
});

test('invalid web_search returns an OpenAI-style 400 response', async () => {
  const res = await app.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.6-plus',
        messages: [{ role: 'user', content: 'Test' }],
        web_search: 'yes',
      }),
    })
  );

  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error.param, 'web_search');
  assert.match(body.error.message, /boolean/);
});

test('web_search returns cited sources for streaming and non-streaming responses', async () => {
  const originalFetch = globalThis.fetch;
  const upstreamSse = [
    'data: {"choices":[{"delta":{"phase":"web_search","extra":{"web_search_info":['
      + '{"url":"https://example.com/unused","title":"Unused"},'
      + '{"url":"https://example.com/cited","title":"Cited source","snippet":"Current information"}'
      + ']}}}]}',
    'data: {"choices":[{"delta":{"phase":"answer","content":"Current answer [[2]]"}}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return new Response(upstreamSse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return originalFetch(input, init);
  };

  await initPlaywright(false);

  try {
    const makeRequest = (stream: boolean) => app.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: 'Find current information' }],
          web_search: true,
          stream,
        }),
      })
    );

    const nonStreamingResponse = await makeRequest(false);
    assert.strictEqual(nonStreamingResponse.status, 200);
    const nonStreamingBody = await nonStreamingResponse.json();
    const message = nonStreamingBody.choices[0].message;
    assert.match(message.content, /Sources:/);
    assert.match(message.content, /https:\/\/example\.com\/cited/);
    assert.deepStrictEqual(message.web_search_sources, [{
      citation_index: 2,
      url: 'https://example.com/cited',
      title: 'Cited source',
      snippet: 'Current information',
    }]);

    const streamingResponse = await makeRequest(true);
    assert.strictEqual(streamingResponse.status, 200);
    const streamingBody = await streamingResponse.text();
    assert.match(streamingBody, /Sources:/);
    assert.match(streamingBody, /web_search_sources/);
    assert.match(streamingBody, /https:\/\/example\.com\/cited/);
    assert.doesNotMatch(streamingBody, /https:\/\/example\.com\/unused/);
    assert.strictEqual(streamingBody.match(/data: \[DONE\]/g)?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await closePlaywright();
  }
});
