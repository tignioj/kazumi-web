import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageCache } from '../images.js';
import { createApp } from '../index.js';
import { createHttpClient, HttpError } from '../http.js';
import { bangumiImageUrl, imageSource } from '../../shared/images.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
const image = 'https://lain.bgm.tv/pic/cover/l/fixture.jpg';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const http = {
    async request(url, options) {
      options.validateUrl?.(url);
      calls.push({ url, options });
      return { url, response: new Response(png, { headers: { 'content-type': 'image/png' } }) };
    },
    async close() {},
  };
  const cache = await new ImageCache({ directory, http, ...options }).init();
  t.after(() => cache.close());
  return { cache, calls, http, directory };
}

test('all Bangumi image URL forms use the same-origin endpoint, with no open proxy', () => {
  assert.equal(
    bangumiImageUrl('http://lain.bgm.tv/pic/a.jpg#fragment'),
    'https://lain.bgm.tv/pic/a.jpg',
  );
  assert.match(imageSource('//lain.bgm.tv/pic/a.jpg'), /^\/api\/image\?url=https%3A/);
  assert.match(
    imageSource('https://api.bgm.tv/v0/characters/7/image?type=large'),
    /^\/api\/image\?/,
  );
  for (const url of [
    'https://example.com/a.png',
    'http://localhost/a',
    'https://lain.bgm.tv.evil/a',
    'https://api.bgm.tv/v0/subjects/7',
    'https://user:pass@lain.bgm.tv/a',
    'https://lain.bgm.tv:8080/a',
    'data:image/png;base64,abc',
    '/api/image?url=already',
  ]) {
    assert.equal(bangumiImageUrl(url), null);
    assert.equal(imageSource(url), url);
  }
});

test('concurrent image misses share one request and persist across restarts', async (t) => {
  const { cache, calls, directory, http } = await fixture(t);
  const loaded = await Promise.all(Array.from({ length: 12 }, () => cache.get(image)));
  assert.equal(calls.length, 1);
  assert.ok(loaded.every((result) => result.bytes.equals(png)));
  assert.equal(calls[0].options.headers.cookie, undefined);
  const reopened = await new ImageCache({ directory, http }).init();
  assert.deepEqual((await reopened.get(image)).bytes, png);
  assert.equal(calls.length, 1);
  assert.equal((await readdir(directory)).length, 1);
});

test('archive cover URLs are resolved only on cache misses, including after restart', async (t) => {
  let lookups = 0;
  const resolveUrl = async () => {
    lookups++;
    return image;
  };
  const { cache, calls, directory, http } = await fixture(t, { resolveUrl });
  const placeholder = 'https://api.bgm.tv/v0/subjects/10440/image?type=large';
  await cache.get(placeholder);
  await cache.get(placeholder);
  const reopened = await new ImageCache({ directory, http, resolveUrl }).init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(placeholder)).bytes, png);
  assert.equal(lookups, 1);
  assert.deepEqual(
    calls.map((call) => call.url),
    [image],
  );
});

test('a full poster grid queues image misses while bounding upstream concurrency', async (t) => {
  const { cache, http } = await fixture(t);
  let active = 0,
    peak = 0,
    count = 0;
  http.request = async (url) => {
    peak = Math.max(peak, ++active);
    count++;
    await new Promise(setImmediate);
    active--;
    return { url, response: new Response(png, { headers: { 'content-type': 'image/png' } }) };
  };
  const images = await Promise.all(
    Array.from({ length: 24 }, (_, index) => cache.get(`${image}?grid=${index}`)),
  );
  assert.equal(images.length, 24);
  assert.equal(count, 24);
  assert.ok(peak <= 8);
  assert.equal(cache.active, 0);
});

test('expired images refetch and disk cache evicts the least recently used image', async (t) => {
  let clock = Date.now();
  const { cache, calls, directory } = await fixture(t, {
    maxBytes: png.length * 2,
    ttl: 1000,
    now: () => clock,
  });
  const a = `${image}?a`,
    b = `${image}?b`,
    c = `${image}?c`;
  await cache.get(a);
  await cache.get(b);
  await cache.get(a);
  await cache.get(c);
  assert.equal(calls.length, 3);
  assert.equal(cache.bytes, png.length * 2);
  assert.equal((await readdir(directory)).length, 2);
  await cache.get(a);
  assert.equal(calls.length, 3);
  await cache.get(b);
  assert.equal(calls.length, 4);
  clock += 1001;
  await cache.get(b);
  assert.equal(calls.length, 5);
  assert.equal(cache.bytes, png.length);
});

test('disabled disk caching still proxies images; corrupt cache entries are replaced', async (t) => {
  const disabled = await fixture(t, { maxBytes: 0 });
  await disabled.cache.get(image);
  await disabled.cache.get(image);
  assert.equal(disabled.calls.length, 2);
  assert.deepEqual(await readdir(disabled.directory), []);
  const { cache, calls, directory } = await fixture(t);
  await cache.get(image);
  const [file] = await readdir(directory);
  await writeFile(join(directory, file), '<html>corrupt</html>');
  assert.deepEqual((await cache.get(image)).bytes, png);
  assert.equal(calls.length, 2);
});

test('image proxy rejects foreign URLs, unsafe redirects, HTML/SVG, spoofed images and oversized bodies', async (t) => {
  const { cache, calls, http } = await fixture(t);
  for (const url of ['http://127.0.0.1/x', 'https://example.com/a.jpg', undefined, [image]])
    await assert.rejects(cache.get(url), { status: 403 });
  assert.equal(calls.length, 0);
  http.request = async (url, options) => {
    assert.throws(() => options.validateUrl('https://example.com/redirected.jpg'), { status: 403 });
    assert.throws(() => options.validateUrl('http://lain.bgm.tv/pic/a.jpg'), { status: 403 });
    return {
      url,
      response: new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    };
  };
  await assert.rejects(cache.get(image), { status: 502 });
  http.request = async (url) => ({
    url,
    response: new Response('<html>not an image</html>', {
      headers: { 'content-type': 'image/png' },
    }),
  });
  await assert.rejects(cache.get(image), /图片内容无效/);
  for (const declared of [true, false]) {
    http.request = async (url) => ({
      url,
      response: new Response(Buffer.alloc(5 * 1024 ** 2 + 1), {
        headers: {
          'content-type': 'image/png',
          ...(declared && { 'content-length': String(5 * 1024 ** 2 + 1) }),
        },
      }),
    });
    await assert.rejects(cache.get(image), /超过 5 MiB/);
  }
  assert.equal(cache.entries.size, 0);
});

test('HTTP redirect validation runs before requesting the redirect destination', async (t) => {
  const paths = [];
  const upstream = createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/start') res.writeHead(302, { location: '/forbidden' }).end();
    else res.end('must not be requested');
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
  t.after(async () => {
    await http.close();
    upstream.close();
  });
  await assert.rejects(
    http.request(`http://127.0.0.1:${upstream.address().port}/start`, {
      validateUrl(url) {
        if (new URL(url).pathname !== '/start') throw new HttpError('forbidden', 403);
      },
    }),
    { status: 403 },
  );
  assert.deepEqual(paths, ['/start']);
});

test('real image route returns cache headers, ETag/304, HEAD and no-store errors', async (t) => {
  const { http, calls } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-image-route-'));
  const application = await createApp({
    dataDir: directory,
    seedRules: [],
    browserResolver: false,
    httpClient: http,
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base + imageSource(image);
  const first = await fetch(url);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(first.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(first.headers.get('cache-control'), /public, max-age=\d+/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);
  const cached = await fetch(url, { headers: { 'if-none-match': first.headers.get('etag') } });
  assert.equal(cached.status, 304);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(png.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(calls.length, 1);
  const blocked = await fetch(`${base}/api/image?url=http://127.0.0.1/private`);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
});
