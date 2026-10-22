import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../src/lib/api.js';
import {
  getVerificationRequest,
  subscribeVerification,
  verificationFailure,
} from '../../src/lib/verification.js';

test('API requests preserve JSON headers, caller options and cancellation signals', async (t) => {
  const controller = new AbortController();
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json({ rules: [] }));
  assert.deepEqual(
    await api('/rules', {
      method: 'GET',
      headers: { 'X-Request': 'fixture' },
      signal: controller.signal,
    }),
    { rules: [] },
  );
  const [url, options] = fetcher.mock.calls[0].arguments;
  assert.equal(url, '/api/rules');
  assert.equal(options.method, 'GET');
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(options.headers, {
    'Content-Type': 'application/json',
    'X-Request': 'fixture',
  });
});

test('API errors retain server messages, HTTP fallbacks and malformed-response diagnostics', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/invalid-json') return new Response('<html>error</html>');
    if (url === '/api/unavailable') return Response.json({}, { status: 503 });
    return Response.json({ error: '来源不可用' }, { status: 422 });
  });
  await assert.rejects(api('/source'), { message: '来源不可用' });
  await assert.rejects(api('/unavailable'), { message: '请求失败（503）' });
  await assert.rejects(api('/invalid-json'), {
    message: '服务返回了无法识别的内容，请稍后重试。',
  });
});

test('API JSON errors attach only the optional parse trace and preserve ordinary errors', async (t) => {
  const trace = { stage: 'search', steps: [{ selector: '//article', count: 0 }] };
  t.mock.method(globalThis, 'fetch', async (url) =>
    Response.json(
      {
        error: '规则解析失败',
        ...(url.endsWith('/traced') ? { trace } : {}),
        privateData: 'must not reach the caller',
      },
      { status: 422 },
    ),
  );
  for (const path of ['/traced', '/ordinary']) {
    await assert.rejects(api(path), (error) => {
      assert.equal(error.message, '规则解析失败');
      assert.deepEqual(error.trace, path === '/traced' ? trace : undefined);
      assert.equal(Object.hasOwn(error, 'trace'), path === '/traced');
      assert.equal(Object.hasOwn(error, 'privateData'), false);
      return true;
    });
  }
});

test('API 202 verification failures reach the caller with the failed-state parse trace', async (t) => {
  const trace = { stage: 'chapters', steps: [{ selector: '//ul', count: 0 }] };
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/verification-session') return Response.json({ ok: true });
    if (url === '/api/rules/test')
      return Response.json(
        { type: 'verification', verificationId: 'traced-api-failure' },
        { status: 202 },
      );
    return Response.json({ ok: true });
  });
  let unsubscribe;
  const queued = new Promise((resolve) => {
    unsubscribe = subscribeVerification((request) => request && resolve(request));
  });
  t.after(() => {
    unsubscribe();
    getVerificationRequest()?.finish(new Error('test cleanup'));
  });
  const result = api('/rules/test', { method: 'POST' });
  const rejected = assert.rejects(result, { message: '验证后解析失败', trace });
  const request = await queued;
  request.finish(verificationFailure({ status: 'failed', error: '验证后解析失败', trace }));
  await rejected;
  assert.equal(getVerificationRequest(), null);
});

test(
  'verification responses wait for the shared request queue and resume with its result',
  { timeout: 5000 },
  async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/verification-session') return Response.json({ ok: true });
      if (url === '/api/resolve')
        return Response.json(
          { type: 'verification', verificationId: 'api-fixture', expiresAt: Date.now() + 60000 },
          { status: 202 },
        );
      assert.equal(url, '/api/verification/api-fixture');
      assert.equal(options.method, 'DELETE');
      return Response.json({ ok: true });
    });
    let unsubscribe;
    const queued = new Promise((resolve) => {
      unsubscribe = subscribeVerification((request) => {
        if (request) resolve(request);
      });
    });
    t.after(() => {
      unsubscribe();
      getVerificationRequest()?.finish(new Error('test cleanup'));
    });
    const result = api('/resolve', {
      method: 'POST',
      body: JSON.stringify({ ruleName: 'fixture', url: 'https://example.com/episode' }),
    });
    result.catch(() => {});
    const request = await queued;
    assert.equal(request.id, 'api-fixture');
    assert.equal(getVerificationRequest(), request);
    const resolved = { type: 'video', url: '/api/media?fixture' };
    request.finish(null, resolved);
    assert.deepEqual(await result, resolved);
    assert.equal(getVerificationRequest(), null);
    assert.equal(calls.filter((call) => call.url === '/api/resolve').length, 1);
    assert.equal(calls.filter((call) => call.options?.method === 'DELETE').length, 1);
  },
);

test('cancelled source requests stop before sending a search, chapter or resolve request', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    assert.equal(url, '/api/verification-session');
    return Response.json({ ok: true });
  });
  const controller = new AbortController();
  controller.abort();
  for (const path of ['/rules/search', '/rules/chapters', '/resolve', '/rules/test'])
    await assert.rejects(api(path, { method: 'POST', signal: controller.signal }), {
      name: 'AbortError',
    });
  assert.ok(calls.every((url) => url === '/api/verification-session'));
  assert.equal(getVerificationRequest(), null);
});
