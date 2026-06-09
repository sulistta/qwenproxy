import test from 'node:test';
import assert from 'node:assert';

import {
  QwenStreamParser,
  formatWebSearchSourcesAppendix,
  getCitedWebSearchSources,
} from '../utils/qwen-stream-parser.js';

test('QwenStreamParser collects cumulative web search sources', () => {
  const parser = new QwenStreamParser('test-session');

  parser.parseLine(JSON.stringify({
    choices: [{
      delta: {
        phase: 'web_search',
        extra: {
          web_search_info: [
            {
              url: 'https://example.com/first',
              title: 'First result',
              snippet: 'First snippet',
              hostname: 'example.com',
              date: ' (2026-06-09)',
            },
            {
              url: 'https://example.com/second',
              title: 'Second result',
            },
          ],
        },
      },
    }],
  }));

  assert.deepStrictEqual(parser.webSearchSources, [
    {
      citation_index: 1,
      url: 'https://example.com/first',
      title: 'First result',
      snippet: 'First snippet',
      hostname: 'example.com',
      date: '(2026-06-09)',
    },
    {
      citation_index: 2,
      url: 'https://example.com/second',
      title: 'Second result',
    },
  ]);
});

test('web search helpers expose only sources cited by the answer', () => {
  const sources = [
    { citation_index: 1, url: 'https://example.com/first', title: 'First result' },
    { citation_index: 2, url: 'https://example.com/second', title: 'Second result' },
    { citation_index: 3, url: 'https://example.com/third', title: 'Third [result]' },
  ];

  const cited = getCitedWebSearchSources(
    'The answer cites [[3]], then [[1]], and repeats [[3]].',
    sources,
  );

  assert.deepStrictEqual(cited, [sources[0], sources[2]]);
  assert.strictEqual(
    formatWebSearchSourcesAppendix(cited),
    '\n\nSources:\n[1] [First result](<https://example.com/first>)\n'
      + '[3] [Third \\[result\\]](<https://example.com/third>)',
  );
});
