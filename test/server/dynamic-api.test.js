import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/index.js';
import { createHttpClient } from '../../server/lib/http.js';
import { BrowserResolver } from '../../server/modules/playback/browser-resolver.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test(
  'dynamic playback works through real browser, API and session proxy with seek support',
  { timeout: 30000 },
  async (t) => {
    const movie = await readFile(new URL('../fixtures/media/sample.mp4', import.meta.url));
    const requests = [];
    const upstream = createServer((req, res) => {
      if (req.url === '/watch') {
        res.setHeader('content-type', 'text/html');
        // Both the iframe and its media URL exist only after JavaScript runs.
        res.end(`<script>fetch('/session').then(() => {
        const frame = document.createElement('iframe'); frame.src = '/embed';
        document.body.append(frame);
      });</script>`);
      } else if (req.url === '/static-watch') {
        res.setHeader('content-type', 'text/html');
        res.setHeader(
          'set-cookie',
          'playback=private-cookie; Path=/stream; HttpOnly; SameSite=Lax',
        );
        res.end('<video src="/stream/file" controls></video>');
      } else if (req.url === '/broken-wrapper') {
        res.setHeader('content-type', 'text/html');
        res.end(
          `<script>var player_aaaa={"encrypt":1,"url":"${encodeURIComponent(`${origin}/watch`)}","from":"X_1"}</script><p>解析出错!</p>`,
        );
      } else if (req.url === '/session') {
        res.setHeader(
          'set-cookie',
          'playback=private-cookie; Path=/stream; HttpOnly; SameSite=Lax',
        );
        res.end('ok');
      } else if (req.url === '/embed') {
        res.setHeader('content-type', 'text/html');
        res.end(`<video controls></video><script>
        document.querySelector('video').src = atob('${Buffer.from('/stream/file').toString('base64')}');
      </script>`);
      } else if (req.url === '/stream/file') {
        requests.push(req.headers);
        if (
          !req.headers.cookie?.includes('playback=private-cookie') ||
          !['/embed', '/static-watch'].some((path) => req.headers.referer?.endsWith(path))
        ) {
          res.writeHead(403).end('missing playback session');
          return;
        }
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(Number(match[2]), movie.length - 1) : movie.length - 1;
        res.setHeader('content-type', 'video/mp4');
        res.setHeader('accept-ranges', 'bytes');
        if (match) {
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${start}-${end}/${movie.length}`);
        }
        res.setHeader('content-length', end - start + 1);
        res.end(movie.subarray(start, end + 1));
      } else res.writeHead(404).end();
    });
    const origin = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), 'kazumi-dynamic-api-'));
    const http = createHttpClient({ allowPrivate: true });
    const resolver = new BrowserResolver(http, { timeout: 10000 });
    const application = await createApp({
      httpClient: http,
      browserResolver: resolver,
      dataDir: directory,
      seedRules: [{ name: 'Dynamic fixture', baseURL: origin }],
    });
    const server = createServer(application.app);
    const base = await listen(server);
    t.after(async () => {
      await application.close();
      await closeServer(server);
      await closeServer(upstream);
      await rm(directory, { recursive: true, force: true });
    });
    for (const path of ['/watch', '/static-watch', '/broken-wrapper']) {
      await t.test(
        path === '/watch'
          ? 'runtime iframe and media URL'
          : path === '/static-watch'
            ? 'static URL with a browser-only cookie session'
            : 'decoded playback page with a broken source wrapper',
        async () => {
          const response = await fetch(`${base}/api/resolve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ruleName: 'Dynamic fixture', url: `${origin}${path}` }),
          });
          const resolved = await response.json();
          assert.equal(response.status, 200, JSON.stringify(resolved));
          assert.equal(resolved.type, 'video');
          assert.equal(resolved.originalUrl, `${origin}${path}`);
          assert.ok(resolved.url.startsWith('/api/media?'));
          const payload = new URL(resolved.url, base).searchParams.get('payload');
          assert.ok(!Buffer.from(payload, 'base64url').toString().includes('private-cookie'));
          const media = await fetch(`${base}${resolved.url}`, {
            headers: { range: 'bytes=40-79' },
          });
          assert.equal(media.status, 206);
          assert.equal(media.headers.get('content-range'), `bytes 40-79/${movie.length}`);
          assert.deepEqual(Buffer.from(await media.arrayBuffer()), movie.subarray(40, 80));
          assert.ok(requests.at(-1).cookie.includes('playback=private-cookie'));
          assert.ok(
            requests.at(-1).referer.endsWith(path === '/static-watch' ? '/static-watch' : '/embed'),
          );
        },
      );
    }
  },
);

test('leaving the playback page cancels the server resolver task', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-resolve-cancel-'));
  let started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  let cancelled;
  const cancellation = new Promise((resolve) => {
    cancelled = resolve;
  });
  const application = await createApp({
    dataDir: directory,
    seedRules: [{ name: 'Cancel fixture', baseURL: 'https://fixture.example' }],
    httpClient: {
      allowPrivate: false,
      request: async (url) => ({ url, response: new Response('<html></html>') }),
      close: async () => {},
    },
    browserResolver: {
      resolve(rule, url, { signal }) {
        started();
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      close: async () => {},
    },
  });
  const server = createServer(application.app);
  const base = await listen(server);
  t.after(async () => {
    await application.close();
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  const controller = new AbortController();
  const pending = fetch(`${base}/api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ ruleName: 'Cancel fixture', url: '/watch' }),
  });
  await start;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await cancellation;
});
