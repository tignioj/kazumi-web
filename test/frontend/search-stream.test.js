import test from 'node:test';
import assert from 'node:assert/strict';
import { readSearchStream } from '../../src/lib/search-stream.js';
import { api } from '../../src/lib/api.js';
import { getVerificationRequest } from '../../src/lib/verification.js';

const group = { ruleName: '测试源', items: [{ name: '动画 🎬', url: 'opaque/1' }] };
const encode = (event) => new TextEncoder().encode(`${JSON.stringify(event)}\n`);
function stream() {
  let controller,
    cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(value) {
        controller = value;
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  );
  return {
    response,
    send: (event) => controller.enqueue(encode(event)),
    bytes: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
    cancelled: () => cancelled,
  };
}

test(
  'API negotiates streaming and publishes split UTF-8 results before the response completes',
  { timeout: 5000 },
  async (t) => {
    const s = stream();
    const seen = [];
    const published = Promise.withResolvers();
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url === '/api/verification-session') return Response.json({ ok: true });
      assert.equal(url, '/api/rules/search');
      assert.equal(options.headers.Accept, 'application/x-ndjson');
      assert.equal(options.onResult, undefined);
      return s.response;
    });
    const result = api('/rules/search', {
      method: 'POST',
      body: JSON.stringify({ keyword: '动画' }),
      onResult(value) {
        seen.push(value);
        published.resolve();
      },
    });
    for (const byte of encode({ type: 'result', result: group })) s.bytes(Uint8Array.of(byte));
    await published.promise;
    assert.deepEqual(seen, [group]);
    const final = {
      results: [group, { ruleName: '慢源', items: [], error: '搜索超时' }],
      timedOut: true,
    };
    s.send({ type: 'complete', result: final });
    assert.deepEqual(await result, final);
    assert.equal(s.cancelled(), true);
  },
);

test('a dropped or failed search leaves published results available to the caller', async () => {
  for (const failure of ['disconnect', 'error']) {
    const s = stream();
    const seen = [];
    const result = readSearchStream(s.response, { onResult: (value) => seen.push(value) });
    s.send({ type: 'result', result: group });
    if (failure === 'error') s.send({ type: 'error', error: '服务已关闭' });
    else s.close();
    await assert.rejects(result, failure === 'error' ? /服务已关闭/ : /已保留收到的结果/);
    assert.deepEqual(seen, [group]);
  }
});

test('stopping a search cancels its reader without clearing published results', async () => {
  const s = stream();
  const controller = new AbortController();
  const seen = [];
  const published = Promise.withResolvers();
  const result = readSearchStream(s.response, {
    signal: controller.signal,
    onResult(value) {
      seen.push(value);
      published.resolve();
    },
  });
  s.send({ type: 'result', result: group });
  await published.promise;
  const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.deepEqual(seen, [group]);
  assert.equal(s.cancelled(), true);
});

test(
  'captcha dialogs do not block streamed source updates and are disposed when the stream completes',
  { timeout: 5000 },
  async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      return Response.json({ ok: true });
    });
    const s = stream();
    const published = Promise.withResolvers();
    const result = readSearchStream(s.response, { onResult: () => published.resolve() });
    s.send({
      type: 'verification',
      verificationId: 'stream-captcha',
      expiresAt: Date.now() + 60000,
    });
    s.send({ type: 'result', result: group });
    await published.promise;
    assert.equal(getVerificationRequest().id, 'stream-captcha');
    s.send({ type: 'complete', result: { results: [group] } });
    assert.deepEqual(await result, { results: [group] });
    assert.equal(getVerificationRequest(), null);
    assert.deepEqual(calls, ['/api/verification/stream-captcha']);
  },
);

test(
  'cancelling a captcha closes the streaming search and keeps its previous results',
  { timeout: 5000 },
  async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
    const s = stream();
    const seen = [];
    const published = Promise.withResolvers();
    const result = readSearchStream(s.response, {
      onResult(value) {
        seen.push(value);
        published.resolve();
      },
    });
    s.send({ type: 'verification', verificationId: 'cancel-captcha' });
    s.send({ type: 'result', result: group });
    await published.promise;
    const rejected = assert.rejects(result, /已取消验证/);
    getVerificationRequest().finish(new Error('已取消验证'));
    await rejected;
    assert.equal(getVerificationRequest(), null);
    assert.deepEqual(seen, [group]);
    assert.equal(s.cancelled(), true);
  },
);
