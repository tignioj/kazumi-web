import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { registerResolveRoute } from '../../server/modules/playback/routes.js';
import { MediaService } from '../../server/modules/playback/media.js';
import { createResolutionLogger } from '../../server/modules/playback/diagnostics.js';
import { createInteractive } from '../../server/modules/verification/interactive.js';
import { VerificationTasks } from '../../server/modules/verification/tasks.js';
import { registerVerificationRoutes } from '../../server/modules/verification/routes.js';
import { handleError } from '../../server/middleware/errors.js';
import { HttpError } from '../../server/lib/http.js';

async function fixture(t, { request, browserResolver, cached } = {}) {
  const app = express();
  const verification = new VerificationTasks({ timeoutMs: 3000 });
  const rule = { name: '测试源', baseURL: 'https://site.example', useLegacyParser: true };
  const media = new MediaService({ allowPrivate: false, request }, 'diagnostics', {
    browserResolver,
  });
  app.use(express.json());
  registerVerificationRoutes(app, { verification });
  registerResolveRoute(app, {
    media,
    store: { get: () => rule },
    downloads: { findComplete: () => cached },
    interactive: createInteractive(verification),
  });
  app.use(handleError);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    verification.close();
    media.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    verification,
    resolve: (stream = true) =>
      fetch(`${base}/api/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(stream ? { accept: 'application/x-ndjson' } : {}),
        },
        body: JSON.stringify({ ruleName: rule.name, url: '/watch?token=page-secret' }),
      }),
  };
}

async function* events(response) {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      yield JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
}

test(
  'static resolution streams real rule and page progress before media is ready, with redacted URLs',
  { timeout: 5000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const f = await fixture(t, {
      request: async (url) => {
        await gate.promise;
        return {
          url,
          response: new Response(
            '<iframe src="https://parser.example/?url=https%3A%2F%2Fcdn.example%2Fmovie.mp4%3Ftoken%3Dmedia-secret"></iframe>',
            { headers: { 'content-type': 'text/html' } },
          ),
        };
      },
    });
    const response = await f.resolve();
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const iterator = events(response);
    const first = (await iterator.next()).value;
    assert.equal(first.type, 'diagnostic');
    assert.equal(first.diagnostic.scope, '规则');
    gate.resolve();
    const received = [first];
    for await (const event of iterator) received.push(event);
    const diagnostics = received
      .filter((event) => event.type === 'diagnostic')
      .map((event) => event.diagnostic);
    assert.ok(
      diagnostics.every((event) => Number.isFinite(event.time) && event.phase === 'resolve'),
    );
    const text = JSON.stringify(diagnostics);
    assert.match(text, /开始加载/);
    assert.match(text, /页面读取完成/);
    assert.match(text, /旧版 iframe 规则匹配成功/);
    assert.match(text, /已创建同源媒体代理/);
    assert.doesNotMatch(text, /page-secret|media-secret/);
    const complete = received.at(-1);
    assert.equal(complete.type, 'complete');
    assert.equal(complete.result.type, 'video');
    assert.match(complete.result.url, /^\/api\/media\?/);
  },
);

test('static failure and browser fallback retain progress before a terminal error', async (t) => {
  const f = await fixture(t, {
    request: async () => {
      throw new HttpError('来源返回 HTTP 502', 502);
    },
    browserResolver: {
      async resolve(rule, url, options) {
        createResolutionLogger(options)('解析脚本', '扫描 iframe 视频元素');
        throw new HttpError('未找到可播放视频', 422);
      },
    },
  });
  const received = [];
  for await (const event of events(await f.resolve())) received.push(event);
  assert.match(JSON.stringify(received), /静态提取或验证失败/);
  assert.match(JSON.stringify(received), /扫描 iframe 视频元素/);
  assert.deepEqual(received.at(-1), { type: 'error', error: '未找到可播放视频' });
});

test(
  'resolution diagnostics continue across manual verification on the same stream',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, {
      request: async (url) => ({ url, response: new Response('<p>Dynamic player</p>') }),
      browserResolver: {
        async resolve(rule, url, options) {
          const log = createResolutionLogger(options);
          log('规则验证', '等待人工验证');
          await options.onVerification({
            ruleName: rule.name,
            originalUrl: url,
            snapshot: async () => ({ status: 'completed' }),
          });
          log('规则验证', '人工验证完成');
          return {
            type: 'video',
            url: 'https://cdn.example/movie.mp4',
            headers: {},
            cookies: [],
            requestHeaders: [],
          };
        },
      },
    });
    const response = await f.resolve();
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const received = [];
    for await (const event of events(response)) {
      received.push(event);
      if (event.type === 'verification') {
        const state = await fetch(`${f.base}/api/verification/${event.verificationId}`, {
          headers: { cookie },
        });
        assert.equal(state.status, 200);
      }
    }
    assert.match(JSON.stringify(received), /等待人工验证/);
    assert.match(JSON.stringify(received), /人工验证完成/);
    assert.equal(received.at(-1).type, 'complete');
  },
);

test(
  'disconnecting the resolution stream aborts pending source requests',
  { timeout: 5000 },
  async (t) => {
    const aborted = Promise.withResolvers();
    const f = await fixture(t, {
      request: (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const response = await f.resolve();
    const task = [...f.verification.tasks.values()][0];
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await aborted.promise;
    await task.done;
    assert.equal(f.verification.tasks.size, 0);
  },
);

test('cached resolution preserves JSON clients and explains the cache hit to streaming clients', async (t) => {
  const f = await fixture(t, {
    cached: { type: 'video', playbackUrl: '/api/downloads/cached/media', id: 'cached' },
  });
  const json = await f.resolve(false);
  assert.match(json.headers.get('content-type'), /application\/json/);
  assert.equal((await json.json()).cached, true);
  const received = [];
  for await (const event of events(await f.resolve())) received.push(event);
  assert.match(received[0].diagnostic.message, /命中已完成的视频缓存/);
  assert.equal(received.at(-1).result.cached, true);
});
