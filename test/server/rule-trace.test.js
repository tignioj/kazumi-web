import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { RuleParseTrace, TRACE_LIMITS } from '../../server/modules/rules/trace.js';
import { RuleEngine } from '../../server/modules/rules/engine.js';
import { registerRuleTestRoute } from '../../server/modules/rules/test-route.js';
import { createInteractive } from '../../server/modules/verification/interactive.js';
import { VerificationTasks } from '../../server/modules/verification/tasks.js';
import { handleError } from '../../server/middleware/errors.js';

const rule = {
  name: 'Trace draft',
  api: '9',
  version: '1.0',
  baseURL: 'https://example.com',
  searchURL: 'https://example.com/search?wd=@keyword',
  searchList: '//article',
  searchName: '//a',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
};

test('trace bounds response and details while retaining complete candidate counts', () => {
  const trace = new RuleParseTrace('search', 'xpath');
  const raw = 'x'.repeat(TRACE_LIMITS.response + 1);
  trace.capture(raw, 'html');
  for (let index = 1; index <= TRACE_LIMITS.nodes + 5; index++) {
    trace.node({
      kind: 'item',
      index,
      status: index % 2 ? 'accepted' : 'skipped',
      fragment: 'f'.repeat(TRACE_LIMITS.fragment + 1),
    });
  }
  for (let index = 0; index < TRACE_LIMITS.selections + 2; index++)
    trace.select('searchList', '//article', '响应', 205);
  for (let index = 0; index < TRACE_LIMITS.diagnostics + 1; index++)
    trace.diagnostic('missing field');
  const result = trace.snapshot();
  assert.equal(result.response.raw.length, TRACE_LIMITS.response);
  assert.equal(result.response.length, raw.length);
  assert.equal(result.response.truncated, true);
  assert.deepEqual(result.counts.items, { matched: 205, accepted: 103, skipped: 102 });
  assert.equal(result.nodes.length, TRACE_LIMITS.nodes);
  assert.equal(result.omittedNodes, 5);
  assert.equal(result.nodes[0].fragment.length, TRACE_LIMITS.fragment);
  assert.equal(result.nodes[0].fragmentLength, TRACE_LIMITS.fragment + 1);
  assert.equal(result.nodes[0].fragmentTruncated, true);
  assert.equal(result.selections.length, TRACE_LIMITS.selections);
  assert.equal(result.omittedSelections, 2);
  assert.equal(result.diagnostics.length, TRACE_LIMITS.diagnostics);
  assert.equal(result.omittedDiagnostics, 1);
});

test('a new response clears earlier parse records and snapshots are independent', () => {
  const trace = new RuleParseTrace('chapters', 'api');
  trace.capture('challenge', 'html');
  trace.select('roadsPath', '$.data[*]', '响应', 1);
  trace.node({ kind: 'road', index: 1, status: 'skipped', fragment: 'old' });
  trace.diagnostic('old response');
  const old = trace.snapshot();
  trace.capture('{"data":[]}', 'json');
  const current = trace.snapshot();
  assert.equal(current.response.raw, '{"data":[]}');
  assert.deepEqual(current.nodes, []);
  assert.deepEqual(current.selections, []);
  assert.deepEqual(current.diagnostics, []);
  assert.equal(current.counts.roads.matched, 0);
  assert.equal(old.nodes[0].fragment, 'old');
  current.response.raw = 'changed';
  current.counts.roads.matched = 123;
  assert.equal(trace.snapshot().response.raw, '{"data":[]}');
  assert.equal(trace.snapshot().counts.roads.matched, 0);
});

test('late skipped episodes retain their reason when successful nodes fill the trace budget', () => {
  const trace = new RuleParseTrace('chapters', 'xpath');
  for (let index = 1; index <= TRACE_LIMITS.nodes; index++)
    trace.node({ kind: 'episode', roadIndex: 1, index, status: 'accepted', fragment: 'ok' });
  trace.node({
    kind: 'episode',
    roadIndex: 1,
    index: 201,
    status: 'skipped',
    reason: '剧集地址为空',
    fragment: '<a>第201集</a>',
  });
  const result = trace.snapshot();
  assert.equal(result.nodes.length, TRACE_LIMITS.nodes);
  assert.equal(result.nodes.at(-1).index, 201);
  assert.equal(result.nodes.at(-1).reason, '剧集地址为空');
  assert.equal(result.omittedNodes, 1);
  assert.deepEqual(result.counts.episodes, { matched: 201, accepted: 200, skipped: 1 });
});

test('trace skips expensive fragments outside its detail budget and tolerates serialization failures', () => {
  const trace = new RuleParseTrace('search', 'api');
  for (let index = 1; index <= TRACE_LIMITS.nodes; index++)
    trace.node({ kind: 'item', index, status: 'accepted', fragment: '{}' });
  trace.node({
    kind: 'item',
    index: 201,
    status: 'accepted',
    fragment: () => assert.fail('omitted nodes must not be serialized'),
  });
  trace.node({
    kind: 'item',
    index: 202,
    status: 'skipped',
    reason: '缺少来源',
    fragment: () => {
      throw new RangeError('Maximum call stack size exceeded');
    },
  });
  const result = trace.snapshot();
  assert.deepEqual(result.counts.items, { matched: 202, accepted: 201, skipped: 1 });
  assert.equal(result.omittedNodes, 2);
  assert.equal(result.nodes.at(-1).fragment, '');
  assert.match(result.nodes.at(-1).fragmentError, /片段无法序列化/);
  assert.match(result.diagnostics.at(-1), /搜索条目 202/);
});

async function fixture(t, raw, status = 200) {
  const app = express();
  const verification = new VerificationTasks();
  app.use(express.json());
  registerRuleTestRoute(app, {
    engine: new RuleEngine({ request: async () => ({ response: new Response(raw, { status }) }) }),
    media: { resolve: async () => ({ type: 'video', url: '/media' }) },
    interactive: createInteractive(verification),
  });
  app.use(handleError);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    verification.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return (stage, draft = rule, stream = false) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/rules/test`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(stream ? { accept: 'application/x-ndjson' } : {}),
      },
      body: JSON.stringify({ rule: draft, stage, keyword: 'test', url: '/detail' }),
    });
}

test('draft test returns raw HTML, matched fragments and skip counts with JSON and streamed success', async (t) => {
  const raw = '<article><a href="/detail">Found</a></article><article><a>No URL</a></article>';
  const run = await fixture(t, raw);
  for (const stream of [false, true]) {
    const response = await run('search', rule, stream);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = stream
      ? JSON.parse((await response.text()).trim()).result
      : await response.json();
    assert.deepEqual(result.items, [{ name: 'Found', url: 'https://example.com/detail' }]);
    assert.equal(result.trace.response.raw, raw);
    assert.equal(result.trace.mode, 'xpath');
    assert.deepEqual(result.trace.counts.items, { matched: 2, accepted: 1, skipped: 1 });
    const skipped = result.trace.nodes.find((node) => node.status === 'skipped');
    assert.equal(skipped.index, 2);
    assert.match(skipped.fragment, /No URL/);
    assert.ok(skipped.reason);
  }
  const resolved = await (await run('resolve')).json();
  assert.equal(Object.hasOwn(resolved, 'trace'), false);
});

test('zero-result search remains successful with trace and no playable chapters remain a traced 422', async (t) => {
  const raw = '<ul><li><a>Missing episode link</a></li></ul>';
  const run = await fixture(t, raw);
  const search = await run('search');
  assert.equal(search.status, 200);
  const searchResult = await search.json();
  assert.deepEqual(searchResult.items, []);
  assert.equal(searchResult.trace.selections[0].matched, 0);
  assert.ok(searchResult.trace.diagnostics.length);
  const chapters = await run('chapters');
  assert.equal(chapters.status, 422);
  const failed = await chapters.json();
  assert.match(failed.error, /未解析到可播放剧集/);
  assert.equal(failed.trace.response.raw, raw);
  assert.equal(failed.trace.counts.episodes.skipped, 1);
  assert.equal(failed.trace.counts.roads.skipped, 1);
});

test('invalid upstream JSON retains exact raw response and the existing failure status', async (t) => {
  const raw = '{"data": [invalid JSON';
  const run = await fixture(t, raw);
  const response = await run('search', {
    ...rule,
    searchMode: 'api',
    searchApiConfig: { request: { url: 'https://example.com/api?wd=@keyword' } },
  });
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.trace.mode, 'api');
  assert.equal(result.trace.response.raw, raw);
  assert.equal(result.trace.response.format, 'json');
  assert.ok(result.trace.diagnostics.length);
});

test('upstream HTTP errors retain the bounded body already read by draft execution', async (t) => {
  const raw = '<h1>Service unavailable</h1>';
  const run = await fixture(t, raw, 503);
  const response = await run('search');
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.match(result.error, /HTTP 503/);
  assert.equal(result.trace.response.raw, raw);
});
