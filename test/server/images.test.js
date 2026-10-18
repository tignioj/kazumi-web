import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageCache } from '../../server/modules/images/cache.js';
import { createCoverResolver } from '../../server/modules/images/cover-resolver.js';
import { createApp } from '../../server/index.js';
import { createHttpClient, HttpError } from '../../server/lib/http.js';
import { bangumiImageMirrorUrl, imageSource } from '../../shared/images.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);
const image = 'https://lain.bgm.tv/pic/cover/l/fixture.jpg';

async function fixture(t, options = {}) {
  const { responseHeaders = {}, ...cacheOptions } = options;
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-images-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const http = {
    async request(url, options) {
      options.validateUrl?.(url);
      calls.push({ url, options });
      return {
        url,
        response: new Response(png, {
          headers: { 'content-type': 'image/png', ...responseHeaders },
        }),
      };
    },
    async close() {},
  };
  const cache = await new ImageCache({ directory, http, ...cacheOptions }).init();
  t.after(() => cache.close());
  return { cache, calls, http, directory };
}

async function imageFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.img'));
}

async function settled(cache) {
  await Promise.allSettled(cache.pending.values());
  await cache.writes;
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('cached cover waited for the upstream')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('concurrent image misses share one request and persist across restarts', async (t) => {
  const { cache, calls, directory, http } = await fixture(t);
  const loaded = await Promise.all(Array.from({ length: 12 }, () => cache.get(image)));
  assert.equal(calls.length, 1);
  assert.ok(loaded.every((result) => result.bytes.equals(png)));
  assert.equal(calls[0].options.headers.cookie, undefined);
  const reopened = await new ImageCache({ directory, http }).init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(image)).bytes, png);
  assert.equal(calls.length, 1);
  assert.equal((await imageFiles(directory)).length, 1);
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

test('mirror covers bypass Bangumi lookups and cannot redirect to another URL or source', async (t) => {
  const { cache, calls, http } = await fixture(t, {
    getNetworkSettings: () => ({ imageAcceleration: 'mirror', bangumiEch: true }),
    resolveUrl: () => assert.fail('mirror requests must not query Bangumi first'),
  });
  const placeholder = 'https://api.bgm.tv/v0/subjects/10440/image?type=large';
  assert.deepEqual((await cache.get(placeholder)).bytes, png);
  assert.equal(calls[0].url, bangumiImageMirrorUrl(placeholder));
  assert.equal(calls[0].options.ech, false);
  for (const target of [
    image,
    'https://wsrv.nl/?url=localhost',
    'https://wsrv.nl/other?url=lain.bgm.tv',
    'https://wsrv.nl.evil/?url=lain.bgm.tv',
    'http://wsrv.nl/?url=lain.bgm.tv',
    'https://user:pass@wsrv.nl/?url=lain.bgm.tv',
  ])
    assert.throws(() => calls[0].options.validateUrl(target), { status: 403 });
  await assert.rejects(cache.get(bangumiImageMirrorUrl(image)), { status: 403 });
  http.request = async () => ({
    url: 'https://wsrv.nl/?url=localhost',
    response: new Response(png, { headers: { 'content-type': 'image/png' } }),
  });
  await assert.rejects(cache.get(image), { status: 403 });
});

test('mode changes keep cached covers and use the new route without reusing mirror validators', async (t) => {
  let settings = { imageAcceleration: 'direct', bangumiEch: true };
  const { cache, calls, http, directory } = await fixture(t, {
    getNetworkSettings: () => settings,
    responseHeaders: { etag: '"direct"' },
  });
  await cache.get(image);
  assert.equal(calls[0].options.ech, false, 'API ECH must not enable image ECH');
  settings = { imageAcceleration: 'mirror', bangumiEch: false };
  await cache.get(image);
  assert.equal(calls.length, 1, 'switching modes preserves fresh cached covers');
  cache.entries.values().next().value.expires = 0;
  await cache.get(image, { waitForRefresh: true });
  assert.equal(calls[1].url, bangumiImageMirrorUrl(image));
  assert.equal(calls[1].options.headers['if-none-match'], undefined);
  settings = { imageAcceleration: 'ech', bangumiEch: false };
  cache.entries.values().next().value.expires = 0;
  await cache.get(image, { waitForRefresh: true });
  assert.equal(calls[2].url, image);
  assert.equal(calls[2].options.ech, true);
  assert.equal(calls[2].options.headers['if-none-match'], undefined);
  const reopened = await new ImageCache({
    directory,
    http,
    getNetworkSettings: () => settings,
  }).init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(image)).bytes, png);
  assert.equal(calls.length, 3);
});

test('API and image ECH use independent transports, including cover URL discovery', async (t) => {
  let settings = { enabled: false, bangumiEch: false, imageAcceleration: 'ech' };
  const requests = [];
  const http = createHttpClient({
    dnsOverHttpsUrl: '',
    getProxySettings: () => settings,
    resolver: async () => {
      throw Object.assign(new Error('direct transport selected'), { code: 'DIRECT_SELECTED' });
    },
    echTransport: {
      request: async (url) => {
        requests.push(String(url));
        return url.hostname === 'lain.bgm.tv'
          ? new Response(png, { headers: { 'content-type': 'image/png' } })
          : Response.json({ images: { large: image } });
      },
      close() {},
    },
  });
  const { cache } = await fixture(t, {
    http,
    maxBytes: 0,
    getNetworkSettings: () => settings,
    resolveUrl: createCoverResolver(http),
  });
  t.after(() => http.close());
  const placeholder = 'https://api.bgm.tv/v0/subjects/10440/image?type=large';
  assert.deepEqual((await cache.get(placeholder)).bytes, png);
  assert.deepEqual(requests, ['https://next.bgm.tv/p1/subjects/10440', image]);
  await assert.rejects(http.json('https://api.bgm.tv/v0/subjects/10440'), /DIRECT_SELECTED/);
  settings = { ...settings, bangumiEch: true, imageAcceleration: 'direct' };
  assert.deepEqual(await http.json('https://api.bgm.tv/v0/subjects/10440'), {
    images: { large: image },
  });
  await assert.rejects(cache.get(placeholder), /DIRECT_SELECTED/);
  await assert.rejects(cache.get(image), /DIRECT_SELECTED/);
  assert.equal(requests.length, 3, 'image direct requests must never use API ECH');
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

test('disk cache evicts the least recently used image when its byte budget is exceeded', async (t) => {
  let clock = Date.now();
  const { cache, calls, directory } = await fixture(t, {
    maxBytes: png.length * 2,
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
  assert.equal((await imageFiles(directory)).length, 2);
  await cache.get(a);
  assert.equal(calls.length, 3);
  await cache.get(b);
  assert.equal(calls.length, 4);
  assert.equal(cache.bytes, png.length * 2);
});

test('upstream cache headers control freshness, with a seven-day fallback', async (t) => {
  const day = 24 * 3600 * 1000;
  for (const [headers, lifetime, cacheable] of [
    [{}, 7 * day, true],
    [{ 'cache-control': 'public, max-age=120', age: '20' }, 100000, true],
    [{ 'cache-control': 'max-age="60"' }, 60000, true],
    [{ 'cache-control': 'max-age=0' }, 0, true],
    [{ 'cache-control': 'max-age=3600, no-cache' }, 0, true],
    [{ 'cache-control': 'no-store' }, 7 * day, false],
  ]) {
    await t.test(JSON.stringify(headers), async (t) => {
      const clock = Date.now();
      const { cache, directory } = await fixture(t, { responseHeaders: headers, now: () => clock });
      const result = await cache.get(image);
      assert.equal(result.expires, clock + lifetime);
      assert.equal(result.cacheable, cacheable);
      assert.equal((await imageFiles(directory)).length, cacheable ? 1 : 0);
    });
  }
});

test('expired covers return immediately, deduplicate refreshes and replace bytes in the background', async (t) => {
  let clock = Date.now();
  const { cache, http, calls } = await fixture(t, {
    now: () => clock,
    responseHeaders: { 'cache-control': 'max-age=1', etag: '"old"' },
  });
  await cache.get(image);
  clock += 1001;
  const gate = Promise.withResolvers();
  let waiting;
  const replacement = Buffer.concat([png, Buffer.from('updated')]);
  http.request = async (url, options) => {
    calls.push({ url, options });
    await gate.promise;
    return {
      url,
      response: new Response(replacement, {
        headers: { 'content-type': 'image/png', 'cache-control': 'max-age=120', etag: '"new"' },
      }),
    };
  };
  try {
    const stale = await promptly(Promise.all(Array.from({ length: 12 }, () => cache.get(image))));
    assert.ok(stale.every((result) => result.bytes.equals(png)));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers['if-none-match'], '"old"');
    assert.equal(cache.pending.size, 1);
    waiting = cache.get(image, { waitForRefresh: true });
  } finally {
    gate.resolve();
  }
  assert.deepEqual((await waiting).bytes, replacement);
  await settled(cache);
  assert.deepEqual((await cache.get(image)).bytes, replacement);
  assert.equal(calls.length, 2);
  assert.equal(cache.bytes, replacement.length);
});

test('304 refreshes reuse bytes and preserve upstream validators and freshness across restarts', async (t) => {
  let clock = Date.now();
  const lastModified = 'Mon, 12 Oct 2026 00:00:00 GMT';
  const { cache, http, directory } = await fixture(t, {
    now: () => clock,
    responseHeaders: {
      'cache-control': 'max-age=60',
      etag: '"upstream"',
      'last-modified': lastModified,
    },
  });
  await cache.get(image);
  await cache.close();
  clock += 61000;
  const reopened = await new ImageCache({ directory, http, now: () => clock }).init();
  t.after(() => reopened.close());
  let checks = 0;
  http.request = async (url, options) => {
    checks++;
    assert.equal(options.headers['if-none-match'], '"upstream"');
    assert.equal(options.headers['if-modified-since'], lastModified);
    assert.equal(
      options.headersForUrl('https://lain.bgm.tv/pic/another.jpg')['if-none-match'],
      undefined,
    );
    return { url, response: new Response(null, { status: 304 }) };
  };
  assert.deepEqual((await reopened.get(image)).bytes, png);
  await settled(reopened);
  assert.equal((await reopened.get(image)).expires, clock + 60000);
  assert.equal(checks, 1);
  assert.equal(reopened.bytes, png.length);
  await reopened.close();
  const again = await new ImageCache({ directory, http, now: () => clock }).init();
  t.after(() => again.close());
  await again.get(image);
  assert.equal(checks, 1);
});

test('failed background refreshes keep stale covers available, including after restart', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let clock = Date.now();
  const { cache, http, directory } = await fixture(t, {
    now: () => clock,
    responseHeaders: { 'cache-control': 'max-age=0' },
  });
  await cache.get(image);
  http.request = async () => {
    throw new Error('offline');
  };
  assert.deepEqual((await cache.get(image, { waitForRefresh: true })).bytes, png);
  await settled(cache);
  assert.deepEqual((await cache.get(image)).bytes, png);
  assert.equal(cache.pending.size, 0);
  await cache.close();
  const reopened = await new ImageCache({ directory, http, now: () => clock }).init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(image)).bytes, png);
  await settled(reopened);
  assert.equal(reopened.entries.size, 1);
});

test('thirty days of inactivity and the 5000-image default bound retained files', async (t) => {
  let clock = Date.now();
  const day = 24 * 3600 * 1000;
  const { cache, http, directory } = await fixture(t, { now: () => clock });
  assert.equal(cache.maxEntries, 5000);
  await cache.get(`${image}?used`);
  await cache.get(`${image}?unused`);
  clock += 29 * day;
  await cache.get(`${image}?used`);
  await settled(cache);
  clock += 2 * day;
  const reopened = await new ImageCache({ directory, http, now: () => clock }).init();
  t.after(() => reopened.close());
  assert.equal(reopened.entries.size, 1);
  assert.equal((await imageFiles(directory)).length, 1);
  assert.equal(reopened.bytes, png.length);
  const bounded = await fixture(t, { maxEntries: 2 });
  await bounded.cache.get(`${image}?a`);
  await bounded.cache.get(`${image}?b`);
  await bounded.cache.get(`${image}?a`);
  await bounded.cache.get(`${image}?c`);
  assert.equal(bounded.cache.entries.size, 2);
  await bounded.cache.get(`${image}?a`);
  assert.equal(bounded.calls.length, 3);
  await bounded.cache.get(`${image}?b`);
  assert.equal(bounded.calls.length, 4);
});

test('legacy files without metadata remain visible while their headers are fetched', async (t) => {
  const { cache, http, directory } = await fixture(t);
  await cache.get(image);
  await cache.close();
  const [name] = await imageFiles(directory);
  await unlink(join(directory, `${name}.json`));
  const reopened = await new ImageCache({ directory, http }).init();
  t.after(() => reopened.close());
  const gate = Promise.withResolvers();
  http.request = async (url, options) => {
    assert.equal(options.headers['if-none-match'], undefined);
    await gate.promise;
    return { url, response: new Response(png, { headers: { 'content-type': 'image/png' } }) };
  };
  try {
    assert.deepEqual((await promptly(reopened.get(image))).bytes, png);
  } finally {
    gate.resolve();
  }
  await settled(reopened);
  assert.equal(reopened.entries.values().next().value.expires > Date.now(), true);
});

test('changed resolved cover URLs do not reuse validators from the previous image', async (t) => {
  let target = image;
  const { cache, http } = await fixture(t, {
    resolveUrl: async () => target,
    responseHeaders: { 'cache-control': 'max-age=0', etag: '"old"' },
  });
  const placeholder = 'https://api.bgm.tv/v0/subjects/10440/image?type=large';
  await cache.get(placeholder);
  target = `${image}?new`;
  http.request = async (url, options) => {
    assert.equal(url, target);
    assert.equal(options.headers['if-none-match'], undefined);
    return {
      url,
      response: new Response(png, {
        headers: { 'content-type': 'image/png', 'cache-control': 'max-age=60' },
      }),
    };
  };
  await cache.get(placeholder);
  await settled(cache);
  assert.equal(cache.entries.values().next().value.target, target);
});

test('disabled disk caching still proxies images; corrupt cache entries are replaced', async (t) => {
  const disabled = await fixture(t, { maxBytes: 0 });
  await disabled.cache.get(image);
  await disabled.cache.get(image);
  assert.equal(disabled.calls.length, 2);
  assert.deepEqual(await readdir(disabled.directory), []);
  const { cache, calls, directory } = await fixture(t);
  await cache.get(image);
  const [file] = await imageFiles(directory);
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
  assert.match(first.headers.get('cache-control'), /stale-while-revalidate=2592000/);
  assert.ok(Number(first.headers.get('x-image-expires')) > Date.now());
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);
  const cached = await fetch(url, { headers: { 'if-none-match': first.headers.get('etag') } });
  assert.equal(cached.status, 304);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(png.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(calls.length, 1);
  for (const mode of ['mirror', 'ech', 'direct']) {
    const saved = await fetch(`${base}/api/network-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        bangumiEch: mode !== 'ech',
        imageAcceleration: mode,
      }),
    });
    assert.equal(saved.status, 200);
    const original = `${image}?mode=${mode}`;
    const loaded = await fetch(base + imageSource(original));
    assert.equal(loaded.status, 200);
    assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), png);
    assert.equal(calls.at(-1).url, mode === 'mirror' ? bangumiImageMirrorUrl(original) : original);
    assert.equal(calls.at(-1).options.ech, mode === 'ech');
  }
  const blocked = await fetch(`${base}/api/image?url=http://127.0.0.1/private`);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
});
