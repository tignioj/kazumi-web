import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { createHttpClient, HttpError } from '../http.js';
import { MediaService } from '../media.js';
import { cookiesForUrl, headersForSession, MediaSessionStore } from '../media-session.js';

const rule = { baseURL: 'https://source.example/', referer: 'https://source.example/' };
const cookie = (name, domain, extra = {}) => ({
  name,
  value: `${name}-secret`,
  domain,
  path: '/',
  secure: true,
  expires: -1,
  ...extra,
});
const candidate = (extra = {}) => ({
  type: 'video',
  url: 'https://cdn.example/movie.mp4',
  headers: {
    'user-agent': 'Fixture',
    referer: 'https://player.example/',
    authorization: 'Bearer secret',
  },
  cookies: [cookie('cdn', 'cdn.example')],
  requestHeaders: [],
  ...extra,
});
function fixture({ html = '<html>dynamic player</html>', error, result = candidate() } = {}) {
  const requests = [],
    browserCalls = [];
  const http = {
    allowPrivate: false,
    async request(url, options) {
      requests.push({ url, ...options });
      if (error) throw error;
      return { url, response: new Response(html) };
    },
  };
  const browserResolver = {
    async resolve(...args) {
      browserCalls.push(args);
      return result;
    },
  };
  const service = new MediaService(http, 'session-test', { browserResolver });
  return { service, http, requests, browserCalls, browserResolver };
}
function payload(result) {
  return JSON.parse(
    Buffer.from(new URL(result.url, 'http://local').searchParams.get('payload'), 'base64url'),
  );
}
async function serve(service) {
  const app = express();
  app.get('/api/media', (req, res, next) => service.proxy(req, res).catch(next));
  app.use((error, req, res, next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('browser fallback creates a server session without putting credentials in the signed URL', async () => {
  const { service, browserCalls, requests } = fixture();
  const controller = new AbortController();
  const result = await service.resolve(rule, '/play/2', { signal: controller.signal });
  assert.equal(result.type, 'video');
  assert.equal(result.originalUrl, 'https://source.example/play/2');
  assert.deepEqual(browserCalls, [[rule, result.originalUrl, { signal: controller.signal }]]);
  assert.equal(requests[0].signal, controller.signal);
  const data = payload(result);
  assert.equal(typeof data.sessionId, 'string');
  assert.equal(data.headers, undefined);
  assert.doesNotMatch(JSON.stringify(data), /secret|cookie|authorization/);
  assert.equal(service.sessions.get(data.sessionId).headers.authorization, 'Bearer secret');
  assert.ok(data.expires > Date.now() / 1000 + 5 * 3600);
  service.close();
  assert.throws(() => service.sessions.get(data.sessionId), { status: 403 });
});

test('static success avoids the browser and keeps the existing proxy payload format', async () => {
  const { service, browserCalls } = fixture({ html: '<video src="/movie.mp4"></video>' });
  const result = await service.resolve(rule, '/play');
  assert.equal(result.type, 'video');
  assert.equal(browserCalls.length, 0);
  assert.equal(payload(result).headers.referer, rule.referer);
  assert.equal(payload(result).sessionId, undefined);
});

test('static media that requires a browser cookie session falls back after a bounded preflight', async () => {
  const { service, browserResolver, browserCalls } = fixture({
    html: '<video src="/movie.mp4"></video>',
  });
  let probed;
  browserResolver.validate = async (media, session, signal) => {
    probed = { media, session, signal };
    throw new HttpError('动态解析的视频验证失败：上游返回 HTTP 403', 502);
  };
  const result = await service.resolve(rule, '/play');
  assert.deepEqual(probed.media, { type: 'video', url: 'https://source.example/movie.mp4' });
  assert.equal(probed.session.headers.referer, rule.referer);
  assert.deepEqual(probed.session.cookies, []);
  assert.equal(probed.signal.aborted, false);
  assert.equal(browserCalls.length, 1);
  assert.equal(browserCalls[0][1], 'https://source.example/play');
  assert.ok(payload(result).sessionId);
});

test('successful static media preflight keeps the browser closed and respects detected HLS type', async () => {
  const { service, browserResolver, browserCalls } = fixture({
    html: '<video src="/stream.mp4"></video>',
  });
  browserResolver.validate = async () => 'hls';
  const result = await service.resolve(rule, '/play');
  assert.equal(result.type, 'hls');
  assert.equal(payload(result).kind, 'hls');
  assert.equal(payload(result).sessionId, undefined);
  assert.equal(browserCalls.length, 0);
});

test('preflight network refusals and caller cancellation never start a browser', async () => {
  const blocked = fixture({ html: '<video src="/movie.mp4"></video>' });
  blocked.browserResolver.validate = async () => {
    throw new HttpError('域名解析到私有或保留网络地址', 403);
  };
  await assert.rejects(blocked.service.resolve(rule, '/play'), { status: 403 });
  assert.equal(blocked.browserCalls.length, 0);
  const cancelled = fixture({ html: '<video src="/movie.mp4"></video>' });
  const controller = new AbortController();
  const reason = new HttpError('解析已取消', 499);
  cancelled.browserResolver.validate = async (media, session, signal) => {
    controller.abort(reason);
    signal.throwIfAborted();
  };
  await assert.rejects(
    cancelled.service.resolve(rule, '/play', { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(cancelled.browserCalls.length, 0);
});

test('unresolved nested pages invoke the browser with the original page', async () => {
  const { service, browserCalls } = fixture({
    html: '<iframe src="https://player.example/embed"></iframe>',
  });
  await service.resolve(rule, '/play');
  assert.equal(browserCalls[0][1], 'https://source.example/play');
});

test('retryable upstream and adapter errors reach the browser, disabled browser keeps legacy behavior', async () => {
  for (const error of [
    new HttpError('upstream failure', 502),
    new HttpError('adapter failed', 422),
  ]) {
    const { service, browserCalls } = fixture({ error });
    await service.resolve(rule, '/play');
    assert.equal(browserCalls.length, 1);
  }
  const { http } = fixture();
  assert.equal((await new MediaService(http, 'legacy').resolve(rule, '/play')).type, 'iframe');
  const broken = fixture({ error: new HttpError('upstream failure', 502) });
  await assert.rejects(new MediaService(broken.http).resolve(rule, '/play'), { status: 502 });
});

test('private-network refusals, invalid browser media and cancellation cannot become iframe fallback', async () => {
  const blocked = fixture({ error: new HttpError('域名解析到私有或保留网络地址', 403) });
  await assert.rejects(blocked.service.resolve(rule, '/play'), { status: 403 });
  assert.equal(blocked.browserCalls.length, 0);
  const preflight = fixture();
  await assert.rejects(preflight.service.resolve(rule, 'http://127.0.0.1/play'), { status: 403 });
  assert.equal(preflight.requests.length, 0);
  for (const url of [
    'http://127.0.0.1/movie.mp4',
    'file:///etc/passwd',
    'https://u:p@cdn.example/movie.mp4',
  ]) {
    const { service } = fixture({ result: candidate({ url }) });
    await assert.rejects(service.resolve(rule, '/play'));
    assert.equal(service.sessions.sessions.size, 0);
  }
  const cancelled = fixture();
  await assert.rejects(cancelled.service.resolve(rule, '/play', { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  assert.equal(cancelled.browserCalls.length, 0);
  const interrupted = fixture();
  const controller = new AbortController();
  const reason = new HttpError('用户已经退出播放页', 499);
  interrupted.http.request = async () => {
    controller.abort(reason);
    throw new HttpError('wrapped upstream cancellation', 502);
  };
  await assert.rejects(
    interrupted.service.resolve(rule, '/play', { signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(interrupted.browserCalls.length, 0);
  const failed = fixture();
  failed.browserResolver.resolve = async () => {
    throw new HttpError('动态解析超时', 504);
  };
  await assert.rejects(failed.service.resolve(rule, '/play'), { status: 504 });
});

test('cookie selection follows domain, path boundary, secure flag and expiration', () => {
  const now = 2_000_000;
  const cookies = [
    cookie('host', 'cdn.example'),
    cookie('domain', '.example'),
    cookie('path', 'cdn.example', { path: '/video' }),
    cookie('expired', 'cdn.example', { expires: now / 1000 - 1 }),
    cookie('lookalike', 'evilcdn.example'),
    cookie('inject', 'cdn.example', { value: 'x; leak=1' }),
  ];
  assert.equal(
    cookiesForUrl(cookies, 'https://cdn.example/video/1', now),
    'path=path-secret; host=host-secret; domain=domain-secret',
  );
  assert.equal(
    cookiesForUrl(cookies, 'https://cdn.example/videos', now),
    'host=host-secret; domain=domain-secret',
  );
  assert.equal(
    cookiesForUrl(cookies, 'https://child.cdn.example/video/1', now),
    'domain=domain-secret',
  );
  assert.equal(cookiesForUrl(cookies, 'http://cdn.example/video/1', now), '');
  assert.equal(cookiesForUrl(cookies, 'https://example.evil/video/1', now), '');
});

test('captured headers preserve no-Referer requests and isolate credentials by origin', () => {
  const session = candidate({
    requestHeaders: [
      {
        url: 'https://cdn.example/no-ref.mp4',
        headers: { 'user-agent': 'Fixture', range: 'bytes=0-1' },
      },
      {
        url: 'https://keys.example/key',
        headers: { 'user-agent': 'Fixture', authorization: 'Bearer key' },
      },
    ],
  });
  const direct = headersForSession(session, 'https://cdn.example/no-ref.mp4');
  assert.equal(direct.referer, undefined);
  assert.equal(direct.range, undefined);
  assert.equal(direct.cookie, 'cdn=cdn-secret');
  assert.equal(
    headersForSession(session, 'https://keys.example/other').authorization,
    'Bearer key',
  );
  const unknown = headersForSession(session, 'https://elsewhere.example/segment.ts');
  assert.deepEqual(unknown, { 'user-agent': 'Fixture' });
});

test('session store evicts old entries, expires sessions and releases all state on close', () => {
  let now = 5_000;
  const store = new MediaSessionStore({ maxSessions: 2, ttlMs: 2_000, now: () => now });
  const first = store.create(candidate());
  const second = store.create(candidate());
  const third = store.create(candidate());
  assert.throws(() => store.get(first.sessionId), { status: 403 });
  assert.equal(store.get(second.sessionId).url, candidate().url);
  now += 2_000;
  assert.throws(() => store.get(third.sessionId), { status: 403 });
  assert.equal(store.sessions.size, 0);
  store.create(candidate());
  store.close();
  assert.equal(store.sessions.size, 0);
});

test('dynamic HLS children and keys retain the session while each host receives scoped credentials', async () => {
  const { service, http } = fixture({
    result: candidate({
      type: 'hls',
      url: 'https://cdn.example/master.m3u8',
      cookies: [cookie('cdn', 'cdn.example'), cookie('key', 'keys.example', { path: '/key' })],
      requestHeaders: [
        {
          url: 'https://keys.example/key',
          headers: { authorization: 'Bearer key-token', 'user-agent': 'Fixture' },
        },
      ],
    }),
  });
  const resolved = await service.resolve(rule, '/play');
  const original = payload(resolved);
  const requests = [];
  http.request = async (url, options) => {
    requests.push({ url, headers: options.headers });
    if (url.endsWith('/master.m3u8'))
      return {
        url,
        response: new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8'),
      };
    if (url.endsWith('/variant.m3u8'))
      return {
        url,
        response: new Response(
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key"\n#EXTINF:5,\nhttps://unknown.example/segment.ts',
        ),
      };
    return {
      url,
      response: new Response('data', { headers: { 'content-type': 'application/octet-stream' } }),
    };
  };
  const server = await serve(service);
  try {
    const master = await (await fetch(server.base + resolved.url)).text();
    const variantUrl = master.split('\n').find((line) => line.startsWith('/api/media'));
    const variant = await (await fetch(server.base + variantUrl)).text();
    const keyUrl = /URI="([^"]+)"/.exec(variant)[1];
    const segmentUrl = variant.split('\n').find((line) => line.startsWith('/api/media'));
    for (const url of [variantUrl, keyUrl, segmentUrl]) {
      const data = payload({ url });
      assert.equal(data.sessionId, original.sessionId);
      assert.equal(data.headers, undefined);
    }
    await fetch(server.base + keyUrl);
    await fetch(server.base + segmentUrl);
    assert.equal(requests[0].headers.cookie, 'cdn=cdn-secret');
    assert.equal(requests[1].headers.authorization, 'Bearer secret');
    assert.equal(requests[2].headers.cookie, 'key=key-secret');
    assert.equal(requests[2].headers.authorization, 'Bearer key-token');
    assert.equal(requests[3].headers.cookie, undefined);
    assert.equal(requests[3].headers.authorization, undefined);
  } finally {
    await server.close();
    service.close();
  }
});

test('dynamic media proxy preserves Range/206 and rejects expired sessions before requesting upstream', async () => {
  const { service, http } = fixture();
  const resolved = await service.resolve(rule, '/play');
  const requests = [];
  http.request = async (url, options) => {
    requests.push(options);
    return {
      url,
      response: new Response('2345', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 2-5/10',
          'accept-ranges': 'bytes',
        },
      }),
    };
  };
  const server = await serve(service);
  try {
    const response = await fetch(server.base + resolved.url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');
    assert.equal(requests[0].headers.range, 'bytes=2-5');
    assert.equal(requests[0].headers.cookie, 'cdn=cdn-secret');
    service.close();
    assert.equal((await fetch(server.base + resolved.url)).status, 403);
    assert.equal(requests.length, 1);
  } finally {
    await server.close();
  }
});

test('malicious HLS child URLs cannot escape existing proxy URL validation', async () => {
  const { service, http } = fixture({
    result: candidate({ type: 'hls', url: 'https://cdn.example/master.m3u8' }),
  });
  const resolved = await service.resolve(rule, '/play');
  http.request = async (url) => ({
    url,
    response: new Response('#EXTM3U\n#EXTINF:5,\nhttp://169.254.169.254/secret'),
  });
  const server = await serve(service);
  try {
    const response = await fetch(server.base + resolved.url);
    assert.equal(response.status, 403);
  } finally {
    await server.close();
    service.close();
  }
});

test('redirected dynamic media recalculates cookie paths and keeps the requested Range', async () => {
  const received = [];
  const upstream = createServer((req, res) => {
    received.push({ path: req.url, cookie: req.headers.cookie, range: req.headers.range });
    if (req.url === '/scope/start.mp4') {
      res.writeHead(302, { location: '/outside/movie.mp4' }).end();
      return;
    }
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 2-5/10' });
    res.end('2345');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const url = `http://127.0.0.1:${upstream.address().port}/scope/start.mp4`;
  const { service } = fixture({
    result: candidate({
      url,
      cookies: [cookie('scope', '127.0.0.1', { path: '/scope', secure: false })],
    }),
  });
  service.http.allowPrivate = true;
  const resolved = await service.resolve(rule, '/play');
  const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
  service.http = http;
  const server = await serve(service);
  try {
    const response = await fetch(server.base + resolved.url, { headers: { range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '2345');
    assert.deepEqual(received, [
      { path: '/scope/start.mp4', cookie: 'scope=scope-secret', range: 'bytes=2-5' },
      { path: '/outside/movie.mp4', cookie: undefined, range: 'bytes=2-5' },
    ]);
  } finally {
    await server.close();
    await http.close();
    await new Promise((resolve) => upstream.close(resolve));
    service.close();
  }
});
