import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleEngine } from '../../server/modules/rules/engine.js';
import { BrowserResolver } from '../../server/modules/playback/browser-resolver.js';

const rule = {
  name: 'fixture',
  baseURL: 'https://example.com',
  searchURL: 'https://example.com/search?q=@keyword',
  searchList: '//article',
  searchName: '//a',
  searchResult: '//a',
};
for (const [code, expected, attempts] of [
  ['ECONNRESET', 'SOURCE_CONNECTION_ERROR', 2],
  ['UND_ERR_CONNECT_TIMEOUT', 'SOURCE_CONNECT_TIMEOUT', 2],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SOURCE_CERTIFICATE_ERROR', 1],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'SOURCE_CERTIFICATE_ERROR', 1],
  ['ERR_SSL_WRONG_VERSION_NUMBER', 'SOURCE_TLS_ERROR', 1],
  ['UND_ERR_HEADERS_TIMEOUT', 'SOURCE_TIMEOUT', 1],
]) {
  test(`local search preserves ${expected} and its retry policy (${code})`, async () => {
    let calls = 0;
    const engine = new RuleEngine({
      text: async () => {
        calls++;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(), { code }) });
      },
    });
    await assert.rejects(engine.search(rule, '番剧'), { code: expected });
    assert.equal(calls, attempts);
  });
}
test('local search retries a dropped POST once and keeps its request and owner', async () => {
  const calls = [];
  const engine = new RuleEngine({
    text: async (url, options) => {
      calls.push({ url, ...options });
      if (calls.length === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return { text: '<article><a href="/one">番剧</a></article>' };
    },
  });
  assert.deepEqual(await engine.search({ ...rule, usePost: true }, 'a b'), [
    { name: '番剧', url: 'https://example.com/one' },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body, 'q=a+b');
  assert.equal(calls[1].url, calls[0].url);
});
test('cancelling local search prevents a retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const engine = new RuleEngine({
    text: async () => {
      calls++;
      controller.abort();
      throw Object.assign(new Error(), { code: 'ECONNRESET' });
    },
  });
  await assert.rejects(engine.search(rule, '番剧', { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls, 1);
});
test('idle Chromium is retired while owner cookie jars remain available for a fresh browser', async () => {
  let closed = 0;
  const resolver = new BrowserResolver({}, { idleTimeout: 50 });
  resolver.browser = {
    close: async () => {
      closed++;
    },
  };
  resolver.egress = {
    close: async () => {
      closed++;
    },
  };
  resolver.ruleSessions.set(rule, 'owner', { cookies: [], origins: [] }, 'Fixture UA');
  resolver.scheduleIdle();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(closed, 2);
  assert.equal(resolver.browser, null);
  assert.equal(resolver.ruleSessions.get(rule, 'owner').userAgent, 'Fixture UA');
  await resolver.close();
});

test('a queued browser request acquires a released slot without exceeding concurrency', async () => {
  const resolver = new BrowserResolver({}, { maxConcurrency: 1 });
  const first = new AbortController(),
    second = new AbortController();
  await resolver.acquire(first);
  let acquired = false;
  const pending = resolver.acquire(second).then(() => {
    acquired = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acquired, false);
  assert.equal(resolver.active.size, 1);
  resolver.active.delete(first);
  await pending;
  assert.equal(resolver.active.size, 1);
  assert.ok(resolver.active.has(second));
  await resolver.close();
});

test('cancelling a queued browser request does not consume a slot or cancel active work', async () => {
  const resolver = new BrowserResolver({}, { maxConcurrency: 1 });
  const first = new AbortController(),
    second = new AbortController();
  await resolver.acquire(first);
  const pending = assert.rejects(resolver.acquire(second), { name: 'AbortError' });
  second.abort();
  await pending;
  assert.equal(resolver.active.size, 1);
  assert.equal(first.signal.aborted, false);
  assert.equal(resolver.active.has(second), false);
  await resolver.close();
});
