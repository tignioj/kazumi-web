import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { BrowserResolver } from '../browser-resolver.js';
import { createHttpClient } from '../http.js';

const browserInstalled = await chromium
  .launch({ headless: true, args: ['--disable-background-networking'] })
  .then(
    async (browser) => {
      await browser.close();
      return true;
    },
    () => false,
  );
const browserTest = (name, fn) =>
  test(
    name,
    {
      skip:
        !browserInstalled &&
        'run npx playwright install chromium to enable browser integration tests',
    },
    fn,
  );
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom'),
  Buffer.alloc(4084),
]);
const segment = Buffer.alloc(376, 0x47);

async function fixture(t, handler, options = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const client = createHttpClient({ allowPrivate: true, timeout: 3000 });
  const resolver = new BrowserResolver(client, { timeout: 5000, settleTime: 150, ...options });
  t.after(async () => {
    await resolver.close();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { resolver, baseURL, requests, rule: { baseURL } };
}

function html(response, text) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(text);
}

browserTest(
  'browser resolver runs nested frames and verifies extensionless HLS with cookies and captured headers',
  async (t) => {
    const keyRequests = [];
    const keyServer = http.createServer((request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-headers', 'authorization');
      if (request.method === 'OPTIONS') return response.writeHead(204).end();
      keyRequests.push(request.headers);
      if (request.headers.authorization !== 'Bearer key-secret')
        return response.writeHead(403).end();
      response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(Buffer.alloc(16, 7));
    });
    keyServer.listen(0, '127.0.0.1');
    await once(keyServer, 'listening');
    const keyUrl = `http://127.0.0.1:${keyServer.address().port}/unlock?id=1`;
    t.after(() => {
      keyServer.closeAllConnections();
      keyServer.close();
    });
    const { resolver, baseURL, requests, rule } = await fixture(t, (request, response) => {
      if (request.url === '/watch')
        return html(
          response,
          `<script>setTimeout(() => { const f = document.createElement('iframe'); f.src = '/embed'; document.body.append(f); }, 20)</script>`,
        );
      if (request.url === '/embed') {
        response.setHeader('set-cookie', 'media_session=secret; Path=/media; HttpOnly');
        return html(
          response,
          `<div class="ad"><video src="/teaser.mp4"></video></div><video id="main" style="width:800px;height:450px"></video><script>
        fetch('/ads/promo.mp4');
        setTimeout(async () => {
          await (await fetch(${JSON.stringify(keyUrl)}, {headers: {authorization: 'Bearer key-secret'}})).arrayBuffer();
          const text = await (await fetch('/media/master', {headers: {authorization: 'Bearer test-secret'}})).text();
          document.querySelector('#main').src = URL.createObjectURL(new Blob([text]));
        }, 80);
      </script>`,
        );
      }
      if (['/ads/promo.mp4', '/teaser.mp4'].includes(request.url))
        return response.writeHead(200, { 'content-type': 'video/mp4' }).end(mp4);
      if (request.url.startsWith('/media/')) {
        if (
          !request.headers.cookie?.includes('media_session=secret') ||
          request.headers.authorization !== 'Bearer test-secret' ||
          !request.headers.referer?.endsWith('/embed')
        )
          return response.writeHead(403).end('missing session');
        if (request.url === '/media/master')
          return response
            .writeHead(200, { 'content-type': 'text/plain' })
            .end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nchild\n');
        if (request.url === '/media/child')
          return response
            .writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
            .end(
              `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}"\n#EXTINF:5,\nfirst.ts\n#EXT-X-ENDLIST\n`,
            );
        if (request.url === '/media/first.ts')
          return response.writeHead(206, { 'content-type': 'video/mp2t' }).end(segment);
      }
      response.writeHead(404).end();
    });
    const result = await resolver.resolve(rule, `${baseURL}/watch`);
    assert.equal(result.type, 'hls');
    assert.equal(result.url, `${baseURL}/media/master`);
    assert.equal(result.headers.authorization, 'Bearer test-secret');
    assert.equal(result.headers.referer, `${baseURL}/embed`);
    assert.equal(
      result.headers.cookie,
      undefined,
      'cookies are kept in the server-side cookie jar',
    );
    assert.ok(result.cookies.some((cookie) => cookie.name === 'media_session' && cookie.httpOnly));
    assert.ok(result.requestHeaders.some((entry) => entry.url === result.url));
    assert.ok(
      result.requestHeaders.some(
        (entry) => entry.url === keyUrl && entry.headers.authorization === 'Bearer key-secret',
      ),
    );
    assert.ok(
      keyRequests.length >= 2,
      'the browser and server both request the cross-origin extensionless key',
    );
    assert.ok(
      keyRequests.every((headers) => !headers.cookie),
      'path-scoped media cookies do not leak to the key endpoint',
    );
    assert.ok(
      requests.some(
        (entry) => entry.path === '/media/first.ts' && entry.headers.range === 'bytes=0-4095',
      ),
    );
    assert.equal(resolver.browser.contexts().length, 0, 'all source pages close after resolution');
  },
);

browserTest(
  'browser resolver triggers a known play control and catches an extensionless dynamic video source',
  async (t) => {
    const { resolver, baseURL, rule } = await fixture(t, (request, response) => {
      if (request.url === '/watch') return html(response, `<iframe src="/player"></iframe>`);
      if (request.url === '/player')
        return html(
          response,
          `<video style="width:800px;height:450px"></video><button aria-label="Play" onclick="document.querySelector('video').src='/stream'">Play</button>`,
        );
      if (request.url === '/stream')
        return response
          .writeHead(request.headers.range ? 206 : 200, {
            'content-type': 'application/octet-stream',
            'accept-ranges': 'bytes',
            'content-range': `bytes 0-${mp4.length - 1}/${mp4.length}`,
          })
          .end(mp4);
      response.writeHead(404).end();
    });
    const result = await resolver.resolve(rule, `${baseURL}/watch`);
    assert.equal(result.type, 'video');
    assert.equal(result.url, `${baseURL}/stream`);
    assert.equal(result.headers.referer, `${baseURL}/player`);
  },
);

browserTest(
  'decoded playback fallback shares the source session and keeps the original parser running',
  async (t) => {
    const { resolver, baseURL, rule, requests } = await fixture(t, (request, response) => {
      if (request.url === '/watch') {
        response.setHeader('set-cookie', 'source_session=ready; Path=/; HttpOnly');
        return html(
          response,
          `<video></video><script>
          setTimeout(() => { document.querySelector('video').src='/movie.mp4'; }, 2200);
        </script>`,
        );
      }
      if (request.url === '/parser-input') {
        assert.match(request.headers.cookie, /source_session=ready/);
        return html(response, '<p>This HTTP source is an input to the original parser.</p>');
      }
      if (request.url === '/movie.mp4')
        return response.writeHead(206, { 'content-type': 'video/mp4' }).end(mp4);
      response.writeHead(404).end();
    });
    const result = await resolver.resolve(rule, `${baseURL}/watch`, {
      playbackUrl: `${baseURL}/parser-input`,
    });
    assert.equal(result.url, `${baseURL}/movie.mp4`);
    assert.ok(requests.some((request) => request.path === '/parser-input'));
    assert.equal(resolver.browser.contexts().length, 0);
  },
);

browserTest(
  'browser resolver cancellation releases context and concurrency without killing the reusable browser',
  async (t) => {
    let loaded;
    const opened = new Promise((resolve) => {
      loaded = resolve;
    });
    const { resolver, baseURL, rule } = await fixture(
      t,
      (request, response) => {
        if (request.url === '/idle') {
          loaded();
          return html(response, '<p>No player</p>');
        }
        if (request.url === '/watch') return html(response, `<video src="/video.mp4"></video>`);
        if (request.url === '/video.mp4')
          return response.writeHead(206, { 'content-type': 'video/mp4' }).end(mp4);
        response.writeHead(404).end();
      },
      { maxConcurrency: 1 },
    );
    const controller = new AbortController();
    const pending = resolver.resolve(rule, `${baseURL}/idle`, { signal: controller.signal });
    const rejected = assert.rejects(pending, { status: 499, message: /取消/ });
    await opened;
    const browser = resolver.browser;
    await assert.rejects(resolver.resolve(rule, `${baseURL}/idle`), {
      status: 503,
      message: /繁忙/,
    });
    controller.abort();
    await rejected;
    assert.equal(browser.contexts().length, 0);
    const result = await resolver.resolve(rule, `${baseURL}/watch`);
    assert.equal(result.type, 'video');
    assert.equal(resolver.browser, browser);
  },
);

browserTest(
  'browser resolver times out with an actionable error and closes source context',
  async (t) => {
    const { resolver, baseURL, rule } = await fixture(
      t,
      (_request, response) => html(response, '<p>No player</p>'),
      { timeout: 1400 },
    );
    await assert.rejects(resolver.resolve(rule, baseURL), {
      status: 504,
      message: /超时.*未找到可播放视频/,
    });
    assert.equal(resolver.active.size, 0);
    assert.equal(resolver.browser.contexts().length, 0);
  },
);

test('candidate verification rejects HTML claiming to be video and cancels the response stream', async () => {
  let cancelled = false;
  const resolver = new BrowserResolver({
    allowPrivate: false,
    async request() {
      return {
        url: 'https://cdn.example/movie.mp4',
        response: new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from('<html>Access denied</html>'.padEnd(4096, ' ')));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'video/mp4' } },
        ),
      };
    },
  });
  await assert.rejects(
    resolver.validate(
      { url: 'https://cdn.example/movie.mp4', type: 'video' },
      { url: 'https://cdn.example/movie.mp4', headers: {}, cookies: [] },
      AbortSignal.timeout(1000),
    ),
    { status: 422, message: /没有返回可识别/ },
  );
  assert.equal(cancelled, true);
});

test('browser startup errors identify missing Chromium and close the egress proxy', async () => {
  let closed = 0;
  const resolver = new BrowserResolver(
    { allowPrivate: false },
    {
      egressFactory: async () => ({
        url: 'http://127.0.0.1:1234',
        close: async () => {
          closed++;
        },
      }),
      browserFactory: async () => {
        throw new Error("Executable doesn't exist. Please install browsers");
      },
    },
  );
  await assert.rejects(
    resolver.resolve({ baseURL: 'https://example.com' }, 'https://example.com/watch'),
    { status: 503, message: /浏览器未安装/ },
  );
  assert.equal(closed, 1);
  assert.equal(resolver.active.size, 0);
});

test('already cancelled requests and private source URLs never start Chromium', async () => {
  const resolver = new BrowserResolver(
    { allowPrivate: false },
    {
      egressFactory: () => assert.fail('browser must not start'),
    },
  );
  await assert.rejects(
    resolver.resolve({ baseURL: 'http://127.0.0.1' }, 'http://127.0.0.1/watch'),
    { status: 403 },
  );
  await assert.rejects(
    resolver.resolve({ baseURL: 'https://example.com' }, 'https://example.com/watch', {
      playbackUrl: 'http://127.0.0.1/decoded',
    }),
    { status: 403 },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    resolver.resolve({ baseURL: 'https://example.com' }, 'https://example.com/watch', {
      signal: controller.signal,
    }),
    { status: 499 },
  );
});
