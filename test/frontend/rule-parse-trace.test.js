import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import {
  formatTraceJson,
  TRACE_JSON_MAX_CHARS,
} from '../../src/features/rules/format-trace-json.js';

const vite = await createServer({ server: { middlewareMode: true, hmr: false } });
let RuleParseTrace;
try {
  ({ RuleParseTrace } = await vite.ssrLoadModule('/src/features/rules/RuleParseTrace.jsx'));
} finally {
  await vite.close();
}

const hostile = '<script>window.injected = true</script><img src=x onerror="alert(1)">';
function trace(overrides = {}) {
  return {
    stage: 'search',
    mode: 'xpath',
    response: { format: 'html', raw: hostile, length: 300000, truncated: true },
    selections: [{ label: '条目名称', expression: '//h2/a', context: '条目 9', matched: 0 }],
    nodes: [
      {
        kind: 'item',
        index: 3,
        status: 'accepted',
        name: 'Found',
        fragment: '<a>Found</a>',
        fragmentLength: 12,
        fragmentTruncated: false,
      },
      {
        kind: 'item',
        index: 9,
        status: 'skipped',
        reason: '缺少名称',
        fragment: hostile,
        fragmentLength: 8000,
        fragmentTruncated: true,
      },
    ],
    counts: { items: { matched: 30, accepted: 29, skipped: 1 } },
    diagnostics: ['条目 9 的名称为空'],
    omittedNodes: 28,
    omittedSelections: 12,
    omittedDiagnostics: 4,
    ...overrides,
  };
}

test('trace renders source documents as inert text with original indices and full truncation counts', () => {
  const dom = new JSDOM(
    renderToStaticMarkup(React.createElement(RuleParseTrace, { trace: trace() })),
  );
  const document = dom.window.document;
  assert.equal(document.querySelector('script, img, iframe'), null);
  assert.equal(document.querySelector('[aria-label="搜索原始响应文本"]').textContent, hostile);
  assert.equal(document.querySelector('[aria-label="搜索条目 9匹配片段"]').textContent, hostile);
  assert.ok([...document.querySelectorAll('details')].every((details) => !details.open));
  assert.match(document.body.textContent, /300,000/);
  assert.match(document.body.textContent, /保留 29/);
  assert.match(document.body.textContent, /另有 28 个节点未展示/);
  assert.match(document.body.textContent, /另有 12 条选择器记录未展示/);
  assert.match(document.body.textContent, /另有 4 条诊断未展示/);
  assert.match(document.body.textContent, /优先保留跳过节点/);
  assert.match(document.body.textContent, /条目 9 的名称为空/);
  dom.window.close();
});

test('a failed trace without a body still exposes zero-result diagnostics and selector evidence', () => {
  const markup = renderToStaticMarkup(
    React.createElement(RuleParseTrace, {
      trace: trace({
        response: undefined,
        nodes: [],
        counts: { items: { matched: 0, accepted: 0, skipped: 0 } },
      }),
    }),
  );
  const dom = new JSDOM(markup);
  assert.match(dom.window.document.body.textContent, /未解析到有效搜索结果/);
  assert.match(dom.window.document.body.textContent, /未取得响应正文/);
  assert.equal(
    dom.window.document.querySelector('.rule-trace-selections code').textContent,
    '//h2/a',
  );
  dom.window.close();
});

test('unserializable node fragments retain the parsed result and explain why no fragment is available', () => {
  const value = trace({
    nodes: [
      {
        kind: 'item',
        index: 7,
        status: 'accepted',
        name: 'Found',
        url: '/detail',
        fragment: '',
        fragmentLength: 0,
        fragmentTruncated: false,
        fragmentError: '片段无法序列化，请查看原始响应',
      },
    ],
  });
  const dom = new JSDOM(
    renderToStaticMarkup(React.createElement(RuleParseTrace, { trace: value })),
  );
  const node = dom.window.document.querySelector('.rule-trace-node');
  assert.match(node.textContent, /搜索条目 7/);
  assert.match(node.textContent, /Found/);
  assert.match(node.textContent, /已保留/);
  assert.match(node.textContent, /片段无法序列化，请查看原始响应/);
  assert.equal(node.querySelector('pre, button'), null);
  assert.equal(
    dom.window.document.querySelector('[aria-label="搜索原始响应文本"]').textContent,
    hostile,
  );
  dom.window.close();
});

async function mount(t, initial) {
  const dom = new JSDOM('<div id="root"></div>');
  const previous = new Map();
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async (text) => copied.push(text) },
    configurable: true,
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = (value) =>
    act(async () => root.render(React.createElement(RuleParseTrace, { trace: value })));
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    dom.window.close();
  });
  await render(initial);
  return { document: dom.window.document, copied, render, navigator: dom.window.navigator };
}

test('skip filtering preserves source indices and copying returns the unchanged raw fragment', async (t) => {
  const { document, copied, render, navigator } = await mount(t, trace());
  await act(async () => document.querySelector('input[type="checkbox"]').click());
  assert.equal(document.querySelectorAll('.rule-trace-nodes > li').length, 1);
  assert.match(document.querySelector('.rule-trace-node-title').textContent, /搜索条目 9/);
  await act(async () => document.querySelector('[aria-label="复制搜索条目 9片段"]').click());
  assert.deepEqual(copied, [hostile]);
  assert.match(document.body.textContent, /已复制/);
  await render(
    trace({ response: { format: 'html', raw: 'changed', length: 7, truncated: false } }),
  );
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(document.querySelectorAll('.rule-trace-nodes > li').length, 2);
  navigator.clipboard.writeText = async () => {
    throw new Error('denied');
  };
  await act(async () => document.querySelector('[aria-label="复制搜索原始响应"]').click());
  assert.match(document.body.textContent, /无法访问剪贴板，请选中文本后手动复制/);
});

test('JSON formatting runs on request, is display-only and explains invalid or truncated responses', async (t) => {
  const raw = '{"name":"<script>inert</script>","items":[1,2]}';
  const jsonTrace = (raw, truncated = false) =>
    trace({ mode: 'api', response: { format: 'json', raw, length: raw.length, truncated } });
  const { document, copied, render } = await mount(t, jsonTrace(raw));
  const code = () => document.querySelector('[aria-label="搜索原始响应文本"]');
  const formatButton = () =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === '格式化 JSON');
  assert.equal(code().textContent, raw);
  await act(async () => formatButton().click());
  assert.equal(code().textContent, JSON.stringify(JSON.parse(raw), null, 2));
  assert.equal(document.querySelector('script'), null);
  await act(async () => document.querySelector('[aria-label="复制搜索原始响应"]').click());
  assert.deepEqual(copied, [raw]);
  for (const value of [jsonTrace('{invalid'), jsonTrace(raw, true)]) {
    await render(value);
    if (!value.response.truncated) {
      assert.equal(formatButton().disabled, false);
      await act(async () => formatButton().click());
    }
    assert.equal(formatButton().disabled, true);
    assert.equal(code().textContent, value.response.raw);
    assert.match(
      document.body.textContent,
      value.response.truncated ? /响应已截断，无法格式化/ : /响应不是有效 JSON/,
    );
  }
});

test('deep and wide JSON never formats during rendering or expands into an oversized preview', async (t) => {
  const deep = '['.repeat(4000) + '0' + ']'.repeat(4000);
  const wide = `[${'0,'.repeat(130000)}0]`;
  assert.ok(wide.length < TRACE_JSON_MAX_CHARS);
  let parsed = 0;
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', (value, ...args) => {
    if (value === deep || value === wide) parsed++;
    return originalParse(value, ...args);
  });
  const jsonTrace = (raw) =>
    trace({ mode: 'api', response: { format: 'json', raw, length: raw.length, truncated: false } });
  const { document, render } = await mount(t, jsonTrace(deep));
  const code = () => document.querySelector('[aria-label="搜索原始响应文本"]');
  const formatButton = () =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === '格式化 JSON');
  assert.equal(parsed, 0);
  assert.equal(code().textContent, deep);
  await act(async () => formatButton().click());
  assert.equal(parsed, 0, 'excessive nesting is rejected before parsing');
  assert.match(document.body.textContent, /JSON 层级过深，保留原文/);
  assert.equal(formatButton().disabled, true);
  assert.equal(code().textContent, deep);
  await render(jsonTrace(wide));
  assert.equal(parsed, 0, 'new responses stay raw until formatting is requested');
  await act(async () => formatButton().click());
  assert.equal(parsed, 1);
  assert.match(document.body.textContent, /格式化内容过大，保留原文/);
  assert.equal(formatButton().disabled, true);
  assert.equal(code().textContent, wide);
  assert.ok(code().textContent.length <= TRACE_JSON_MAX_CHARS);
});

test('bounded JSON formatting preserves literals and accepts only output within the 256 Ki character budget', (t) => {
  t.mock.method(JSON, 'stringify', () => {
    throw new Error('formatting must not stringify an object');
  });
  const sample = '{"value":9007199254740993,"exponent":1e20,"text":"[\\\"}]","empty":[{},[]]}';
  const formatted = formatTraceJson(sample);
  assert.equal(formatted.error, undefined);
  assert.match(formatted.text, /9007199254740993/);
  assert.match(formatted.text, /1e20/);
  assert.deepEqual(JSON.parse(formatted.text), JSON.parse(sample));
  const boundary = `[${'0,'.repeat(52427)}0]`;
  const within = formatTraceJson(boundary);
  assert.equal(within.text.length, 262142);
  assert.ok(within.text.length <= TRACE_JSON_MAX_CHARS);
  assert.deepEqual(formatTraceJson(`[${'0,'.repeat(52428)}0]`), { error: 'size' });
  assert.equal(formatTraceJson('['.repeat(64) + '0' + ']'.repeat(64)).error, undefined);
  assert.deepEqual(formatTraceJson('['.repeat(65) + '0' + ']'.repeat(65)), { error: 'depth' });
});
