import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { resolveHhjx } from '../../server/modules/playback/adapters/hhjx.js';
import { MediaService } from '../../server/modules/playback/media.js';

const pageUrl = 'https://hhjx.hhplayer.com/?url=episode-2';
const bootstrap = {
  url: 'episode-2?token=a&next=b',
  t: 1791111334,
  key: 'parse-key',
  ts_key: 'playlist-key',
};
const headers = { 'user-agent': 'Fixture', referer: 'https://dmbus.cc/' };
const playerHtml = (data = bootstrap) =>
  `<script>globalThis.__hhjxExecuted = true; window.__HHJX_BOOTSTRAP__ = ${JSON.stringify(data)};</script>`;
const upstream = (data, requests = []) => ({
  allowPrivate: false,
  async json(url, options) {
    requests.push({ url, ...options });
    return typeof data === 'function' ? data(requests.length) : data;
  },
});

test('HHJX JSON resolver requests signed parsing without executing page scripts', async () => {
  const requests = [];
  const result = await resolveHhjx(
    upstream({ code: 200, url: 'http://groupvideo.photo.qq.com/movie.mp4' }, requests),
    playerHtml(),
    pageUrl,
    headers,
  );
  assert.equal(globalThis.__hhjxExecuted, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://hhjx.hhplayer.com/api/parse');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), {
    url: bootstrap.url,
    t: bootstrap.t,
    key: bootstrap.key,
    client_fallback: false,
  });
  assert.equal(requests[0].headers.referer, pageUrl);
  assert.equal(requests[0].headers.origin, 'https://hhjx.hhplayer.com');
  assert.equal(requests[0].headers['content-type'], 'application/json');
  assert.deepEqual(result, {
    type: 'video',
    url: 'https://groupvideo.photo.qq.com/movie.mp4',
    headers: { 'user-agent': 'Fixture' },
  });
  assert.equal(headers.referer, 'https://dmbus.cc/', 'input headers stay reusable');
});

test('HHJX bootstrap parsing stays confined to the exact provider hostname', async () => {
  const http = upstream(() => assert.fail('unrelated pages must not call the parser'));
  for (const url of [
    'https://example.com/',
    'https://hhjx.hhplayer.com.evil.example/',
    'https://evilhhjx.hhplayer.com/',
  ]) {
    assert.equal(await resolveHhjx(http, playerHtml(), url, headers), null);
  }
});

test('HHJX invalid bootstrap and parser failures produce actionable errors', async () => {
  for (const data of [
    {},
    { ...bootstrap, url: '' },
    { ...bootstrap, key: [] },
    { ...bootstrap, t: String(bootstrap.t) },
    { ...bootstrap, error: 'expired' },
  ]) {
    const http = upstream(() => assert.fail('invalid bootstrap must not call the parser'));
    await assert.rejects(resolveHhjx(http, playerHtml(data), pageUrl, headers), {
      status: 422,
      message: /播放器参数无效/,
    });
  }
  await assert.rejects(
    resolveHhjx(
      upstream({}),
      '<script>window.__HHJX_BOOTSTRAP__ = {broken};</script>',
      pageUrl,
      headers,
    ),
    { status: 422 },
  );
  for (const response of [{ code: 403 }, { code: 200, url: {} }, { code: 200, url: ' ' }]) {
    await assert.rejects(resolveHhjx(upstream(response), playerHtml(), pageUrl, headers), {
      status: 502,
      message: /未返回有效视频地址/,
    });
  }
});

test('HHJX validates final media URLs before signing a proxy request', async () => {
  for (const url of [
    'http://127.0.0.1/movie.mp4',
    'http://169.254.169.254/movie.mp4',
    'http://[::ffff:127.0.0.1]/movie.mp4',
    'file:///etc/passwd',
    'https://user:secret@cdn.example.com/movie.mp4',
  ]) {
    await assert.rejects(resolveHhjx(upstream({ code: 200, url }), playerHtml(), pageUrl, headers));
  }
});

test('HHJX Youku requests its server fallback once and preserves act 99', async () => {
  const requests = [];
  const result = await resolveHhjx(
    upstream(
      (attempt) =>
        attempt === 1
          ? { code: 200, url: 'https://youku.example.com/video', ext: 'youku' }
          : { code: 200, url: 'https://cdn.example.com/movie.mp4' },
      requests,
    ),
    playerHtml({ ...bootstrap, act: 99 }),
    pageUrl,
    headers,
  );
  assert.equal(result.type, 'video');
  assert.deepEqual(
    requests.map((request) => JSON.parse(request.body).client_fallback),
    [false, true],
  );
  assert.ok(requests.every((request) => JSON.parse(request.body).act === 99));
  await assert.rejects(
    resolveHhjx(
      upstream({ code: 200, url: 'https://youku.example.com/video', ext: 'youku' }),
      playerHtml(),
      pageUrl,
      headers,
    ),
    { status: 422, message: /仍需要来源网页解析/ },
  );
});

test('HHJX HLS rewrite requires valid provider parameters and retains HLS kind', async () => {
  const response = {
    code: 200,
    url: 'https://cdn.example.com/video/m3u8?token=one',
    ext: 'hls_rewrite',
  };
  const result = await resolveHhjx(upstream(response), playerHtml(), pageUrl, headers);
  assert.equal(result.type, 'hls');
  const playlist = new URL(result.url);
  assert.equal(playlist.origin, 'https://hhjx.hhplayer.com');
  assert.equal(playlist.pathname, '/getts');
  assert.deepEqual(Object.fromEntries(playlist.searchParams), {
    url: response.url,
    t: String(bootstrap.t),
    key: bootstrap.ts_key,
  });
  assert.equal(result.headers.referer, undefined);
  for (const [data, result] of [
    [{ ...bootstrap, ts_key: '' }, response],
    [bootstrap, { ...response, url: 'https://cdn.example.com/movie.mp4' }],
    [bootstrap, { ...response, ext: 'unknown-browser-resolver' }],
  ]) {
    await assert.rejects(resolveHhjx(upstream(result), playerHtml(data), pageUrl, headers), {
      status: 422,
    });
  }
});

test('resolved HHJX media and nested HLS stay on the local proxy without source Referer', async (t) => {
  const mediaRequests = [];
  let parseResult = { code: 200, url: 'https://groupvideo.photo.qq.com/movie.mp4' };
  const http = {
    ...upstream(() => parseResult),
    async request(url, options = {}) {
      if (url === 'https://dmbus.cc/play/2')
        return { url, response: new Response(`<iframe src="${pageUrl}"></iframe>`) };
      if (url === pageUrl) return { url, response: new Response(playerHtml()) };
      mediaRequests.push({ url, ...options });
      if (new URL(url).pathname === '/getts')
        return {
          url,
          response: new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000\n/variant'),
        };
      if (url === 'https://hhjx.hhplayer.com/variant')
        return {
          url,
          response: new Response(
            '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key"\n#EXTINF:5,\nhttps://cdn.example.com/segment.ts',
          ),
        };
      return {
        url,
        response: new Response('2345', {
          status: options.headers.range ? 206 : 200,
          headers: {
            'content-type': url.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
            'content-range': 'bytes 2-5/10',
            'accept-ranges': 'bytes',
          },
        }),
      };
    },
  };
  const service = new MediaService(http, 'hhjx-test-secret');
  const app = express();
  app.get('/api/media', (req, res, next) => service.proxy(req, res).catch(next));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const rule = { baseURL: 'https://dmbus.cc/', referer: headers.referer };
  try {
    await t.test('MP4 retains Range and signed headers drop the provider Referer', async () => {
      const result = await service.resolve(rule, '/play/2');
      assert.equal(result.type, 'video');
      assert.equal(result.originalUrl, 'https://dmbus.cc/play/2');
      const signed = new URL(result.url, base).searchParams;
      const payload = service.verify(signed.get('payload'), signed.get('signature'));
      assert.equal(payload.headers.referer, undefined);
      const response = await fetch(`${base}${result.url}`, { headers: { range: 'bytes=2-5' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
      assert.equal(await response.text(), '2345');
      assert.equal(mediaRequests.at(-1).headers.range, 'bytes=2-5');
    });
    await t.test('extensionless getts, variant, key and segment are all proxied', async () => {
      parseResult = { code: 200, url: 'https://cdn.example.com/master.m3u8', ext: 'hls_rewrite' };
      const result = await service.resolve(rule, '/play/2');
      assert.equal(result.type, 'hls');
      const response = await fetch(`${base}${result.url}`);
      assert.match(response.headers.get('content-type'), /mpegurl/);
      const master = await response.text();
      const variantPath = master.split('\n').find((line) => line.startsWith('/api/media?'));
      assert.ok(variantPath);
      const variant = await (await fetch(`${base}${variantPath}`)).text();
      const keyPath = /URI="([^"]+)"/.exec(variant)?.[1];
      const segmentPath = variant.split('\n').find((line) => line.startsWith('/api/media?'));
      assert.ok(keyPath?.startsWith('/api/media?'));
      assert.ok(segmentPath);
      assert.equal(await (await fetch(`${base}${keyPath}`)).text(), '2345');
      assert.equal(await (await fetch(`${base}${segmentPath}`)).text(), '2345');
    });
    assert.ok(mediaRequests.length >= 5);
    assert.ok(mediaRequests.every((request) => request.headers.referer === undefined));
    assert.ok(mediaRequests.every((request) => request.headers.origin === undefined));
    assert.ok(mediaRequests.every((request) => request.headers['content-type'] === undefined));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
