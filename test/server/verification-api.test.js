import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../server/index.js';
import { createHttpClient } from '../../server/lib/http.js';

const screenshot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, { verificationOptions, image = false, challengeCount = 1 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-verification-api-'));
  const mediaRequests = [];
  const upstream = createServer((req, res) => {
    if (req.url === '/watch') {
      res.setHeader('content-type', 'text/html');
      res.end('<html><body>Complete the verification to play.</body></html>');
    } else if (req.url === '/stream/movie.mp4') {
      mediaRequests.push(req.headers);
      if (!req.headers.cookie?.includes('verification=server-secret')) {
        res.writeHead(403).end('missing verification session');
        return;
      }
      res.setHeader('content-type', 'video/mp4');
      res.end('verified-media');
    } else res.writeHead(404).end();
  });
  const origin = await listen(upstream);
  const tasks = [];
  const browserResolver = {
    async resolve(rule, url, { signal, onVerification }) {
      const events = [];
      const record =
        (type) =>
        async (...args) => {
          events.push({ type, args });
        };
      const locator = (selector) => ({
        first() {
          return this;
        },
        count: async () => 1,
        isVisible: async () => true,
        screenshot: async () => screenshot,
        boundingBox: async () => ({ x: 30, y: 40, width: 180, height: 60 }),
        fill: async (value) => events.push({ type: 'fill', selector, value }),
        click: async () => events.push({ type: 'locatorClick', selector }),
        press: record('locatorPress'),
      });
      const page = {
        url: () => url,
        viewportSize: () => ({ width: 960, height: 640 }),
        isClosed: () => false,
        screenshot: async () => screenshot,
        reload: record('reload'),
        locator,
        mouse: Object.fromEntries(
          ['click', 'move', 'down', 'up', 'wheel'].map((name) => [name, record(name)]),
        ),
        keyboard: {
          insertText: record('text'),
          type: record('text'),
          press: record('key'),
        },
      };
      const task = { events, signal, page, resumed: false };
      tasks.push(task);
      assert.equal(typeof onVerification, 'function');
      for (let attempt = 0; attempt < challengeCount; attempt++) {
        await onVerification({
          page,
          ruleName: rule.name,
          originalUrl: url,
          ...(image && {
            captcha: {
              image: '//img[@id="captcha"]',
              input: '//input[@id="answer"]',
              submit: '//button[@id="submit"]',
            },
          }),
        });
      }
      signal.throwIfAborted();
      task.resumed = true;
      return {
        type: 'video',
        url: `${origin}/stream/movie.mp4`,
        headers: { referer: url },
        cookies: [
          {
            name: 'verification',
            value: 'server-secret',
            domain: '127.0.0.1',
            path: '/stream',
            httpOnly: true,
            expires: -1,
          },
        ],
        requestHeaders: [],
      };
    },
    close: async () => {},
  };
  const application = await createApp({
    dataDir: directory,
    seedRules: [{ name: 'Verification fixture', baseURL: origin }],
    httpClient: createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' }),
    browserResolver,
    verificationOptions,
  });
  const server = createServer(application.app);
  const base = await listen(server);
  t.after(async () => {
    await application.close();
    await closeServer(server);
    await closeServer(upstream);
    await rm(directory, { recursive: true, force: true });
  });
  async function request(path, { cookie, body, method = body ? 'POST' : 'GET' } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie && { cookie }),
        ...(body && { 'content-type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
    const bodyText = await response.text();
    return {
      status: response.status,
      data: bodyText ? JSON.parse(bodyText) : null,
      headers: response.headers,
    };
  }
  async function start(cookie) {
    const result = await request('/api/resolve', {
      cookie,
      body: { ruleName: 'Verification fixture', url: `${origin}/watch` },
    });
    assert.equal(result.status, 202, JSON.stringify(result.data));
    assert.equal(result.data.type, 'verification');
    assert.equal(typeof result.data.verificationId, 'string');
    const ownerCookie = result.headers
      .getSetCookie()
      .find((value) => value.startsWith('kazumi-verification-owner='));
    return {
      ...result,
      cookie: ownerCookie?.split(';')[0] || cookie,
      ownerCookie,
      path: `/api/verification/${result.data.verificationId}`,
    };
  }
  async function completed(session) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await request(session.path, { cookie: session.cookie });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      if (result.data.status === 'completed') return result.data.result;
      assert.notEqual(result.data.status, 'failed', JSON.stringify(result.data));
      await delay(10);
    }
    assert.fail('verification did not finish after continuation');
  }
  return { request, start, completed, tasks, mediaRequests, base, origin };
}

test(
  'manual page verification resumes playback with server-only cookies',
  { timeout: 10000 },
  async (t) => {
    const app = await fixture(t);
    const session = await app.start();
    assert.match(session.ownerCookie, /HttpOnly/i);
    assert.match(session.ownerCookie, /SameSite=Strict/i);
    assert.equal(app.tasks[0].resumed, false);
    const waiting = await app.request(session.path, { cookie: session.cookie });
    assert.equal(waiting.status, 200);
    assert.equal(waiting.data.status, 'waiting');
    assert.match(waiting.headers.get('cache-control'), /no-store/);
    const challenge = waiting.data.challenge;
    assert.equal(challenge.mode, 'page');
    assert.equal(challenge.ruleName, 'Verification fixture');
    assert.equal(challenge.originalUrl, `${app.origin}/watch`);
    assert.equal(challenge.width, 960);
    assert.equal(challenge.height, 640);
    assert.match(challenge.image, /^data:image\/(?:png|jpeg);base64,/);
    for (const action of [
      { type: 'click', x: 120, y: 80 },
      { type: 'text', text: 'human answer' },
      { type: 'key', key: 'Enter' },
    ]) {
      const response = await app.request(`${session.path}/action`, {
        cookie: session.cookie,
        body: { challengeId: challenge.id, action },
      });
      assert.equal(response.status, 200, JSON.stringify(response.data));
    }
    assert.deepEqual(
      app.tasks[0].events.map(({ type }) => type),
      ['click', 'text', 'key'],
    );
    assert.equal(app.tasks[0].resumed, false, 'input must not discard the live verification page');
    const continued = await app.request(`${session.path}/action`, {
      cookie: session.cookie,
      body: { challengeId: challenge.id, action: { type: 'continue' } },
    });
    assert.equal(continued.status, 200, JSON.stringify(continued.data));
    const resolved = await app.completed(session);
    assert.equal(app.tasks[0].resumed, true);
    assert.equal(resolved.type, 'video');
    assert.equal(resolved.originalUrl, `${app.origin}/watch`);
    assert.ok(resolved.url.startsWith('/api/media?'));
    assert.ok(!JSON.stringify(resolved).includes('server-secret'));
    const payload = new URL(resolved.url, app.base).searchParams.get('payload');
    assert.ok(!Buffer.from(payload, 'base64url').toString().includes('server-secret'));
    const media = await fetch(`${app.base}${resolved.url}`);
    assert.equal(media.status, 200);
    assert.equal(await media.text(), 'verified-media');
    assert.equal(app.mediaRequests.at(-1).cookie, 'verification=server-secret');
  },
);

test(
  'verification owners cannot view, operate, or cancel each other and cancellation aborts work',
  { timeout: 10000 },
  async (t) => {
    const app = await fixture(t);
    const owner = await app.start();
    const other = await app.start();
    assert.notEqual(owner.cookie, other.cookie);
    const waiting = await app.request(owner.path, { cookie: owner.cookie });
    for (const cookie of [undefined, other.cookie]) {
      for (const options of [
        {},
        { method: 'DELETE' },
        { body: { challengeId: waiting.data.challenge.id, action: { type: 'continue' } } },
      ]) {
        const path = options.body ? `${owner.path}/action` : owner.path;
        const response = await app.request(path, { ...options, cookie });
        assert.equal(response.status, 404, JSON.stringify(response.data));
        assert.ok(!JSON.stringify(response.data).includes('data:image'));
      }
    }
    assert.equal(app.tasks[0].signal.aborted, false);
    const cancelled = await app.request(owner.path, { cookie: owner.cookie, method: 'DELETE' });
    assert.ok([200, 204].includes(cancelled.status), JSON.stringify(cancelled.data));
    assert.equal(app.tasks[0].signal.aborted, true);
    assert.equal(app.tasks[0].resumed, false);
    assert.equal((await app.request(owner.path, { cookie: owner.cookie })).status, 404);
    assert.equal((await app.request(other.path, { cookie: other.cookie })).data.status, 'waiting');
  },
);

test(
  'invalid input and stale challenge IDs never reach the browser',
  { timeout: 10000 },
  async (t) => {
    const app = await fixture(t);
    const session = await app.start();
    const waiting = await app.request(session.path, { cookie: session.cookie });
    const challengeId = waiting.data.challenge.id;
    for (const action of [
      { type: 'click', x: -1, y: 10 },
      { type: 'click', x: 960, y: 10 },
      { type: 'drag', points: Array.from({ length: 65 }, () => ({ x: 10, y: 10 })) },
      { type: 'text', text: 'x'.repeat(10001) },
      { type: 'key', key: 'Control+L' },
      { type: 'evaluate', expression: 'alert(1)' },
      { type: 'answer', text: 'no image challenge' },
    ]) {
      const response = await app.request(`${session.path}/action`, {
        cookie: session.cookie,
        body: { challengeId, action },
      });
      assert.equal(response.status, 400, JSON.stringify({ action, result: response.data }));
    }
    const stale = await app.request(`${session.path}/action`, {
      cookie: session.cookie,
      body: { challengeId: 'stale-challenge', action: { type: 'continue' } },
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.deepEqual(app.tasks[0].events, []);
    assert.equal(app.tasks[0].resumed, false);
    assert.equal(
      (await app.request(session.path, { cookie: session.cookie })).data.status,
      'waiting',
    );
  },
);

test(
  'image verification fills and submits only the configured CAPTCHA controls',
  { timeout: 10000 },
  async (t) => {
    const app = await fixture(t, { image: true });
    const session = await app.start();
    const waiting = await app.request(session.path, { cookie: session.cookie });
    assert.equal(waiting.data.challenge.mode, 'image');
    const answer = await app.request(`${session.path}/action`, {
      cookie: session.cookie,
      body: { challengeId: waiting.data.challenge.id, action: { type: 'answer', text: '1234' } },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    assert.deepEqual(app.tasks[0].events, [
      { type: 'fill', selector: 'xpath=//input[@id="answer"]', value: '1234' },
      { type: 'locatorClick', selector: 'xpath=//button[@id="submit"]' },
    ]);
    assert.equal((await app.completed(session)).type, 'video');
  },
);

test(
  'a repeated challenge keeps the original task and rejects actions from its previous screen',
  { timeout: 10000 },
  async (t) => {
    const app = await fixture(t, { challengeCount: 2 });
    const session = await app.start();
    const first = await app.request(session.path, { cookie: session.cookie });
    const body = { challengeId: first.data.challenge.id, action: { type: 'continue' } };
    assert.equal(
      (await app.request(`${session.path}/action`, { cookie: session.cookie, body })).status,
      200,
    );
    const second = await app.request(session.path, { cookie: session.cookie });
    assert.equal(second.data.status, 'waiting');
    assert.notEqual(second.data.challenge.id, first.data.challenge.id);
    assert.equal(app.tasks.length, 1, 'the same resolver and browser page must survive a retry');
    assert.equal(app.tasks[0].resumed, false);
    assert.equal(
      (await app.request(`${session.path}/action`, { cookie: session.cookie, body })).status,
      409,
    );
    const continued = await app.request(`${session.path}/action`, {
      cookie: session.cookie,
      body: { challengeId: second.data.challenge.id, action: { type: 'continue' } },
    });
    assert.equal(continued.status, 200);
    assert.equal((await app.completed(session)).type, 'video');
  },
);

test(
  'expired verification releases its browser work and task capacity',
  { timeout: 10000 },
  async (t) => {
    const app = await fixture(t, { verificationOptions: { ttlMs: 150, maxTasks: 1 } });
    const session = await app.start();
    const busy = await app.request('/api/resolve', {
      cookie: session.cookie,
      body: { ruleName: 'Verification fixture', url: `${app.origin}/watch` },
    });
    assert.equal(busy.status, 429);
    assert.equal(app.tasks.length, 1);
    await delay(200);
    const expired = await app.request(session.path, { cookie: session.cookie });
    assert.ok([404, 410].includes(expired.status), JSON.stringify(expired.data));
    assert.equal(app.tasks[0].signal.aborted, true);
    assert.equal(app.tasks[0].resumed, false);
    const replacement = await app.start(session.cookie);
    assert.notEqual(replacement.data.verificationId, session.data.verificationId);
    assert.equal(app.tasks.length, 2);
  },
);
