import test from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitVerification,
  ensureVerificationSession,
  getVerificationRequest,
  readResponse,
  subscribeVerification,
  verificationFailure,
} from '../../src/lib/verification.js';

test('verification session initialization shares pending requests and retries after a failure', async (t) => {
  let reject;
  const pending = new Promise((resolve, rejectRequest) => {
    reject = rejectRequest;
  });
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/verification-session');
    assert.equal(options.credentials, 'same-origin');
    attempts++;
    return attempts === 1 ? pending : Promise.resolve(Response.json({ ok: true }));
  });
  const first = ensureVerificationSession();
  const simultaneous = ensureVerificationSession();
  assert.equal(first, simultaneous);
  const failures = [assert.rejects(first, /offline/), assert.rejects(simultaneous, /offline/)];
  reject(new Error('offline'));
  await Promise.all(failures);
  const retry = ensureVerificationSession();
  assert.equal(ensureVerificationSession(), retry);
  assert.deepEqual(await retry, { ok: true });
  assert.equal(ensureVerificationSession(), retry);
  assert.equal(attempts, 2);
});

test('verification requests keep FIFO order, finish once and notify subscribers on cancellation', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  });
  const seen = [];
  const unsubscribe = subscribeVerification((request) => seen.push(request?.id || null));
  t.after(unsubscribe);
  const first = awaitVerification({ verificationId: 'first', expiresAt: 100 });
  const controller = new AbortController();
  const second = awaitVerification({ verificationId: 'second' }, controller.signal);
  const request = getVerificationRequest();
  assert.equal(request.id, 'first');
  request.finish(null, { roads: [] });
  request.finish(new Error('duplicate completion'));
  assert.deepEqual(await first, { roads: [] });
  assert.equal(getVerificationRequest().id, 'second');
  const cancelled = assert.rejects(second, { name: 'AbortError' });
  controller.abort();
  await cancelled;
  assert.equal(getVerificationRequest(), null);
  assert.equal(seen.at(-1), null);
  assert.ok(seen.includes('second'));
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/api/verification/first', '/api/verification/second'],
  );
  for (const { options } of calls) {
    assert.equal(options.method, 'DELETE');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.keepalive, true);
  }
});

test('invalid or already cancelled verification requests never enter the pending queue', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return Response.json({ ok: true });
  });
  await assert.rejects(awaitVerification({ verificationId: '' }), /有效的会话/);
  assert.deepEqual(calls, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(awaitVerification({ verificationId: 'cancelled' }, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(getVerificationRequest(), null);
  assert.deepEqual(calls, ['/api/verification/cancelled']);
});

test('verification response errors preserve expired-session status and readable diagnostics', async () => {
  await assert.rejects(readResponse(new Response('<html>error</html>')), {
    message: '验证服务返回了无法识别的内容，请重新发起请求。',
  });
  for (const status of [404, 410])
    await assert.rejects(readResponse(Response.json({}, { status })), {
      message: '验证会话已过期，请重新搜索或解析。',
      status,
    });
  await assert.rejects(readResponse(Response.json({ error: '验证任务已取消' }, { status: 409 })), {
    message: '验证任务已取消',
    status: 409,
  });
});

test('verification transport and failed-state errors retain only their explicit trace', async () => {
  const trace = { stage: 'search', steps: [{ selector: '//article', count: 0 }] };
  for (const traced of [false, true]) {
    const data = {
      status: 'failed',
      error: '验证后解析失败',
      ...(traced ? { trace } : {}),
      privateData: 'must not reach the caller',
    };
    await assert.rejects(readResponse(Response.json(data, { status: 422 })), (error) => {
      assert.equal(error.message, data.error);
      assert.equal(error.status, 422);
      assert.deepEqual(error.trace, traced ? trace : undefined);
      assert.equal(Object.hasOwn(error, 'trace'), traced);
      assert.equal(Object.hasOwn(error, 'privateData'), false);
      return true;
    });
    const error = verificationFailure(data);
    assert.equal(error.message, data.error);
    assert.deepEqual(error.trace, traced ? trace : undefined);
    assert.equal(Object.hasOwn(error, 'trace'), traced);
    assert.equal(Object.hasOwn(error, 'privateData'), false);
    assert.equal(Object.hasOwn(error, 'status'), false);
  }
  assert.equal(verificationFailure({}).message, '验证未完成，请重新搜索或解析。');
});
