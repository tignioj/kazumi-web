import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { HttpError } from '../../server/lib/http.js';
import { handleError } from '../../server/middleware/errors.js';
import { createInteractive } from '../../server/modules/verification/interactive.js';
import { VerificationTasks } from '../../server/modules/verification/tasks.js';
import { registerVerificationRoutes } from '../../server/modules/verification/routes.js';

const trace = { stage: 'search', steps: [{ selector: '//article', count: 0 }] };
const message = '规则解析未完成';

async function fixture(t) {
  const verification = new VerificationTasks({ timeoutMs: 5000, ttlMs: 30000 });
  const interactive = createInteractive(verification);
  const app = express();
  app.use(express.json());
  registerVerificationRoutes(app, { verification });
  app.post('/api/trace-fixture', async (req, res) => {
    await interactive(
      req,
      res,
      async ({ onVerification, onDiagnostic }) => {
        if (req.body.publish) onDiagnostic({ message: '开始解析' });
        if (req.body.verify)
          await onVerification({
            ruleName: 'Trace fixture',
            originalUrl: 'https://fixture.example/search',
            page: {
              url: () => 'https://fixture.example/search',
              viewportSize: () => ({ width: 100, height: 100 }),
              screenshot: async () => Buffer.from('fixture'),
            },
          });
        const error = req.body.internal
          ? new Error('private internal error')
          : new HttpError(message, 409);
        if (req.body.trace) error.trace = trace;
        error.privateData = 'must not be sent';
        throw error;
      },
      { stream: req.body.stream, diagnostics: true, errorMessage: '操作失败，请重试' },
    );
  });
  app.use(handleError);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    verification.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (path, { cookie, body, method = body ? 'POST' : 'GET' } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const owner = (response) => response.headers.getSetCookie()[0]?.split(';')[0];
  const resume = async (id, cookie) => {
    const response = await request(`/api/verification/${id}`, { cookie });
    assert.equal(response.status, 200);
    const waiting = await response.json();
    assert.equal(waiting.status, 'waiting');
    const task = verification.tasks.get(id);
    const action = await request(`/api/verification/${id}/action`, {
      cookie,
      body: { challengeId: waiting.challenge.id, action: { type: 'continue' } },
    });
    assert.equal(action.status, 200);
    await action.json();
    await task.done;
  };
  return { request, owner, resume };
}

test('JSON failures preserve status and message and expose only an explicitly attached trace', async (t) => {
  const app = await fixture(t);
  for (const traced of [false, true]) {
    const response = await app.request('/api/trace-fixture', { body: { trace: traced } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: message,
      ...(traced ? { trace } : {}),
    });
  }
  t.mock.method(console, 'error', () => {});
  const internal = await app.request('/api/trace-fixture', {
    body: { internal: true, trace: true },
  });
  assert.equal(internal.status, 500);
  assert.deepEqual(await internal.json(), { error: '服务器处理请求失败', trace });
});

test('an open NDJSON stream retains trace on errors without exposing unrelated error fields', async (t) => {
  const app = await fixture(t);
  for (const traced of [false, true]) {
    const response = await app.request('/api/trace-fixture', {
      body: { stream: true, publish: true, trace: traced },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events[0].type, 'diagnostic');
    assert.deepEqual(events[1], { type: 'error', error: message, ...(traced ? { trace } : {}) });
  }
  const response = await app.request('/api/trace-fixture', {
    body: { stream: true, publish: true, internal: true, trace: true },
  });
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1), { type: 'error', error: '操作失败，请重试', trace });
});

test('published verification failures preserve trace only for their owner, including later snapshots', async (t) => {
  const app = await fixture(t);
  const otherOwner = app.owner(await app.request('/api/verification-session'));
  for (const traced of [false, true]) {
    const response = await app.request('/api/trace-fixture', {
      body: { verify: true, trace: traced },
    });
    assert.equal(response.status, 202);
    const cookie = app.owner(response);
    const pending = await response.json();
    assert.equal(pending.type, 'verification');
    assert.equal(Object.hasOwn(pending, 'trace'), false);
    const path = `/api/verification/${pending.verificationId}`;
    await app.resume(pending.verificationId, cookie);
    for (let read = 0; read < 2; read++) {
      const state = await app.request(path, { cookie });
      assert.equal(state.status, 200);
      const data = await state.json();
      assert.deepEqual(data, {
        status: 'failed',
        expiresAt: pending.expiresAt,
        error: message,
        ...(traced ? { trace } : {}),
      });
    }
    for (const deniedCookie of [undefined, otherOwner]) {
      for (const method of ['GET', 'DELETE']) {
        const denied = await app.request(path, { cookie: deniedCookie, method });
        assert.equal(denied.status, 404);
        assert.deepEqual(await denied.json(), { error: '验证会话不存在或已过期，请重试' });
      }
    }
  }
});

test('streaming verification failures preserve a task trace when reconstructing the terminal error', async (t) => {
  const app = await fixture(t);
  for (const traced of [false, true]) {
    const response = await app.request('/api/trace-fixture', {
      body: { stream: true, verify: true, trace: traced },
    });
    assert.equal(response.status, 200);
    const cookie = app.owner(response);
    const events = [];
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === 'verification') await app.resume(event.verificationId, cookie);
      }
    }
    pending += decoder.decode();
    assert.equal(pending, '');
    assert.equal(events[0].type, 'verification');
    assert.deepEqual(events[1], { type: 'error', error: message, ...(traced ? { trace } : {}) });
  }
});
