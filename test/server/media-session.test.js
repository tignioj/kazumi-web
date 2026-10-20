import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { createHttpClient, HttpError } from '../../server/lib/http.js';
import { MediaService } from '../../server/modules/playback/media.js';
import {
  cookiesForUrl,
  headersForSession,
  MediaSessionStore,
} from '../../server/modules/playback/session-store.js';

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
    coreCalls = [];
  const http = {
    allowPrivate: false,
    async request(url, options) {
      requests.push({ url, ...options });
      if (error) throw error;
      return { url, response: new Response(html) };
    },
  };
  const core = {
    async resolve(...args) {
      coreCalls.push(args);
      return result;
    },
  };
  const service = new MediaService(http, 'session-test', { resolver: core });
  return { service, http, requests, coreCalls, core };
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
  const { service, coreCalls, requests } = fixture();
  const controller = new AbortController();
  const result = await service.resolve(rule, '/play/2', { signal: controller.signal });
  assert.equal(result.type, 'video');
  assert.equal(result.originalUrl, 'https://source.example/play/2');
  assert.deepEqual(coreCalls, [[rule, result.originalUrl, { signal: controller.signal }]]);
  assert.equal(requests.length, 0, 'Node does not fetch or parse source HTML');
  const data = payload(result);
  assert.equal(typeof data.sessionId, 'string');
  assert.equal(data.headers, undefined);
  assert.doesNotMatch(JSON.stringify(data), /secret|cookie|authorization/);
  assert.equal(service.sessions.get(data.sessionId).headers.authorization, 'Bearer secret');
  assert.ok(data.expires > Date.now() / 1000 + 5 * 3600);
  service.close();
  assert.throws(() => service.sessions.get(data.sessionId), { status: 403 });
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
        headers: {
          'user-agent': 'Fixture',
          range: 'bytes=0-1',
          'if-range': '"probe"',
          'if-none-match': '"probe"',
          'if-modified-since': 'Tue, 20 Oct 2026 12:00:00 GMT',
        },
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
  assert.equal(direct['if-range'], undefined);
  assert.equal(direct['if-none-match'], undefined);
  assert.equal(direct['if-modified-since'], undefined);
  assert.equal(direct.cookie, 'cdn=cdn-secret');
  assert.equal(
    headersForSession(session, 'https://keys.example/other').authorization,
    'Bearer key',
  );
  const unknown = headersForSession(session, 'https://elsewhere.example/segment.ts');
  assert.deepEqual(unknown, { 'user-agent': 'Fixture' });
});

test('cached video ranges revalidate from headers without waiting for an upstream body', async () => {
  const { service, http } = fixture();
  const resolved = await service.resolve(rule, '/play');
  const requests = [];
  let canceled = 0;
  http.request = async (url, options) => {
    requests.push(options);
    return {
      url,
      response: new Response(new ReadableStream({ cancel: () => canceled++ }), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 2-9/10',
          'content-length': '8',
          etag: '"same-video"',
          'last-modified': 'Tue, 20 Oct 2026 12:00:00 GMT',
        },
      }),
    };
  };
  const server = await serve(service);
  try {
    const response = await fetch(server.base + resolved.url, {
      headers: { range: 'bytes=2-', 'if-none-match': '"old", W/"same-video"' },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('etag'), '"same-video"');
    assert.equal(response.headers.get('last-modified'), 'Tue, 20 Oct 2026 12:00:00 GMT');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=60');
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), '');
    assert.equal(canceled, 1);
    assert.equal(requests.length, 1);
    for (const headers of [
      requests[0].headers,
      requests[0].headersForUrl('https://elsewhere.example/video.mp4'),
    ]) {
      assert.equal(headers.range, 'bytes=2-');
      assert.equal(headers['if-none-match'], '"old", W/"same-video"');
    }
    assert.equal(
      requests[0].headersForUrl('https://elsewhere.example/video.mp4').authorization,
      undefined,
    );
  } finally {
    await server.close();
    service.close();
  }
});

test('video cache validators honor ETag precedence, dates, HEAD and upstream 304', async () => {
  const { service, http } = fixture();
  const resolved = await service.resolve(rule, '/play');
  let status = 206;
  http.request = async (url) => ({
    url,
    response: new Response(status === 304 ? null : '2345', {
      status,
      headers: {
        etag: 'W/"current"',
        'last-modified': 'Tue, 20 Oct 2026 12:00:00 GMT',
        ...(status === 206 && {
          'content-type': 'video/mp4',
          'content-range': 'bytes 2-5/10',
          'content-length': '4',
        }),
      },
    }),
  });
  const server = await serve(service);
  try {
    const cases = [
      { headers: { 'if-none-match': '"current"' }, expected: 304 },
      { headers: { 'if-none-match': '*' }, expected: 304 },
      { headers: { 'if-modified-since': 'Tue, 20 Oct 2026 12:00:00 GMT' }, expected: 304 },
      { headers: { 'if-modified-since': 'Tue, 20 Oct 2026 13:00:00 GMT' }, expected: 304 },
      { headers: { 'if-modified-since': 'Tue, 20 Oct 2026 11:00:00 GMT' }, expected: 206 },
      { headers: { 'if-modified-since': 'invalid' }, expected: 206 },
      {
        headers: {
          'if-none-match': '"previous"',
          'if-modified-since': 'Tue, 20 Oct 2026 13:00:00 GMT',
        },
        expected: 206,
      },
      { headers: { 'if-none-match': 'W/"current"' }, method: 'HEAD', expected: 304 },
      { headers: { 'if-none-match': '"previous"' }, upstream: 304, expected: 304 },
      { headers: { 'if-none-match': '*' }, upstream: 403, expected: 502 },
    ];
    for (const check of cases) {
      status = check.upstream || 206;
      const response = await fetch(server.base + resolved.url, {
        method: check.method || 'GET',
        headers: { range: 'bytes=2-5', ...check.headers },
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, check.expected, JSON.stringify(check));
      if (check.expected === 206) {
        assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(await response.text(), '2345');
      } else {
        if (check.expected === 304) assert.equal(await response.text(), '');
        else await response.body.cancel();
      }
    }
  } finally {
    await server.close();
    service.close();
  }
});

test('a rejected conditional video range is rechecked without cache conditions before replying', async () => {
  const { service, http } = fixture();
  const resolved = await service.resolve(rule, '/play');
  let attempts = [],
    canceled = 0,
    changed = false,
    unsatisfiable = false;
  http.request = async (url, options) => {
    attempts.push(options);
    if (attempts.length === 1 || unsatisfiable)
      return {
        url,
        response: new Response('rejected', {
          status: 416,
          headers: {
            'content-type': unsatisfiable ? 'video/mp4' : 'text/html',
            'content-range': 'bytes */10',
          },
        }),
      };
    return {
      url,
      response: new Response(changed ? '2345' : new ReadableStream({ cancel: () => canceled++ }), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 2-5/10',
          'content-length': '4',
          etag: changed ? '"new"' : '"current"',
        },
      }),
    };
  };
  const server = await serve(service);
  try {
    const headers = {
      range: 'bytes=2-5',
      'if-none-match': '"current"',
      'if-modified-since': 'Tue, 20 Oct 2026 12:00:00 GMT',
    };
    const request = () =>
      fetch(server.base + resolved.url, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
    const matched = await request();
    assert.equal(matched.status, 304);
    assert.equal(await matched.text(), '');
    assert.equal(canceled, 1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].headers['if-none-match'], '"current"');
    for (const retried of [
      attempts[1].headers,
      attempts[1].headersForUrl('https://elsewhere.example/movie.mp4'),
    ]) {
      assert.equal(retried.range, 'bytes=2-5');
      assert.equal(retried['if-none-match'], undefined);
      assert.equal(retried['if-modified-since'], undefined);
    }
    assert.equal(attempts[1].headers.cookie, 'cdn=cdn-secret');
    assert.equal(
      attempts[1].headersForUrl('https://elsewhere.example/movie.mp4').cookie,
      undefined,
    );

    attempts = [];
    changed = true;
    const modified = await request();
    assert.equal(modified.status, 206);
    assert.equal(modified.headers.get('etag'), '"new"');
    assert.equal(await modified.text(), '2345');

    attempts = [];
    unsatisfiable = true;
    const invalid = await request();
    assert.equal(invalid.status, 416);
    assert.equal(attempts.length, 2, 'an invalid range cannot loop or become a false 304');
    await invalid.body.cancel();
  } finally {
    await server.close();
    service.close();
  }
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
