import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../index.js';
import { createHttpClient } from '../http.js';
import { tarHeader } from '../download-archive.js';

const movie = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const hlsAsset = Buffer.from('INITseg1seg2');
const hlsKey = Buffer.from('0123456789abcdef');
const imageSegment = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.alloc(105),
  Buffer.from([0x47, 0x40]),
  Buffer.alloc(186),
  Buffer.from([0x47, 0x41]),
  Buffer.alloc(186),
]);

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function diskFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await diskFiles(path)));
    else files.push({ path, size: (await stat(path)).size });
  }
  return files;
}

async function eventually(read, accepts, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(40);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function fixture(t, { downloadOptions, session = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-downloads-'));
  const received = [];
  const state = {
    offline: false,
    slowConnections: 0,
    slowCompletes: false,
    resolvingConnections: 0,
    watchReady: false,
  };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    received.push({ path, headers: req.headers });
    if (state.offline) return res.writeHead(503).end('upstream unavailable');
    if (path === '/resolving') {
      state.resolvingConnections++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html>loading');
      res.once('close', () => state.resolvingConnections--);
      return;
    }
    if (path === '/watch' && state.watchReady)
      return res.end(`<html><video src="http://${req.headers.host}/movie.mp4"></video></html>`);
    if (path === '/session') return res.end('<html>dynamic player</html>');
    if (path === '/broken.mp4') return res.writeHead(502).end('broken upstream');
    if (path === '/fake.mp4') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html>not a video</html>');
    }
    if (path === '/image.mp4') {
      res.setHeader('content-type', 'image/png');
      return res.end(imageSegment);
    }
    if (path === '/image-segments.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n/image-segment.png\n' +
          '#EXTINF:5,\n/image-segment.jpg\n#EXT-X-ENDLIST\n',
      );
    }
    if (/^\/image-segment\.(?:png|jpg)$/.test(path)) {
      res.writeHead(200, {
        'content-type': path.endsWith('.png') ? 'image/png' : 'image/jpeg',
        'content-length': imageSegment.length,
      });
      res.write(imageSegment.subarray(0, 4));
      return setTimeout(() => res.end(imageSegment.subarray(4)), 15);
    }
    if (path === '/invalid-segment.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      const asset = new URL(req.url, 'http://fixture').searchParams.get('asset');
      return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\n${asset}\n#EXT-X-ENDLIST\n`);
    }
    if (path.startsWith('/invalid-segment.')) {
      const suffix = path.split('.').at(-1);
      res.setHeader(
        'content-type',
        { html: 'text/html', json: 'application/json', svg: 'image/svg+xml' }[suffix] ||
          'image/png',
      );
      return res.end(
        suffix === 'json'
          ? '{"error":"not a segment"}'
          : suffix === 'svg'
            ? '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
            : '<html>upstream error</html>',
      );
    }
    if (path === '/movie.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': movie.length });
      res.write(movie.subarray(0, 10));
      return setTimeout(() => res.end(movie.subarray(10)), 15);
    }
    if (path === '/slow.mp4') {
      if (state.slowCompletes) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': movie.length });
        return res.end(movie);
      }
      state.slowConnections++;
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write(Buffer.alloc(256, 1));
      const timer = setInterval(() => res.write(Buffer.alloc(256, 2)), 20);
      res.once('close', () => {
        clearInterval(timer);
        state.slowConnections--;
      });
      return;
    }
    if (path.startsWith('/quota-')) {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write(Buffer.alloc(384, path === '/quota-a.mp4' ? 1 : 2));
      return setTimeout(() => res.end(Buffer.alloc(384, 3)), 80);
    }
    if (path === '/master.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,URI="audio"\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=5000,AUDIO="audio"\nvariant\n',
      );
    }
    if (path === '/variant') {
      res.setHeader('content-type', 'application/octet-stream');
      return res.end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n' +
          '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x00000000000000000000000000000000\n' +
          '#EXT-X-MAP:URI="asset",BYTERANGE="4@0"\n' +
          '#EXTINF:5,\n#EXT-X-BYTERANGE:4@4\nasset\n' +
          '#EXTINF:5,\n#EXT-X-BYTERANGE:4\nasset\n#EXT-X-ENDLIST\n',
      );
    }
    if (path === '/audio') {
      res.setHeader('content-type', 'application/octet-stream');
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\naudio.aac\n#EXT-X-ENDLIST\n');
    }
    if (path === '/live.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nasset\n');
    }
    if (path === '/key' || path === '/asset' || path === '/audio.aac') {
      res.setHeader('content-type', 'application/octet-stream');
      return res.end(path === '/key' ? hlsKey : path === '/asset' ? hlsAsset : 'audio-bytes');
    }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const rule = {
    name: 'Download fixture',
    baseURL: upstreamUrl,
    referer: `${upstreamUrl}/watch`,
  };
  let application;
  let server;
  let base;
  async function start() {
    const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
    application = await createApp({
      browserResolver: session
        ? {
            resolve: async () => ({
              type: 'video',
              url: `${upstreamUrl}/movie.mp4?token=upstream-secret`,
              headers: { authorization: 'Bearer auth-secret' },
              cookies: [
                {
                  name: 'session',
                  value: 'cookie-secret',
                  domain: '127.0.0.1',
                  path: '/',
                  expires: -1,
                  secure: false,
                },
              ],
              requestHeaders: [],
            }),
            close: async () => {},
          }
        : false,
      dataDir: directory,
      httpClient: http,
      seedRules: [rule],
      downloadOptions,
    });
    server = application.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await application?.close();
    if (server) await closeServer(server);
    server = null;
    application = null;
  }
  t.after(async () => {
    await stop();
    await closeServer(upstream);
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  async function json(path, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function resolve(path) {
    const response = await json('/api/resolve', { ruleName: rule.name, url: upstreamUrl + path });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async function submit(path, overrides = {}) {
    const resolved = await resolve(path);
    const body = {
      ruleName: rule.name,
      episodeUrl: upstreamUrl + path,
      title: '测试番剧',
      episodeName: '第 1 集',
      sourceUrl: `${upstreamUrl}/subject`,
      mediaUrl: resolved.url,
      ...overrides,
    };
    const response = await json('/api/downloads', body);
    assert.equal(response.status, 202, JSON.stringify(response.data));
    return { job: response.data, body };
  }
  async function list() {
    const response = await json('/api/downloads');
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  async function finished(id) {
    return eventually(
      async () => (await list()).items.find((item) => item.id === id),
      (job) => ['complete', 'error'].includes(job?.status),
      'download did not finish',
    );
  }
  return {
    directory,
    received,
    state,
    rule,
    upstreamUrl,
    json,
    resolve,
    submit,
    list,
    finished,
    fetch: (path, options) => fetch(new URL(path, base), options),
    restart: async () => {
      await stop();
      await start();
    },
  };
}

function playlistUris(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    if (!line.startsWith('#')) return [line.trim()];
    return [...line.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]);
  });
}

function untar(buffer) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
    assert.ok(Number.isFinite(size), 'archive entry has a valid size');
    files.set(name, buffer.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('tar headers encode ordinary sizes in octal and 10 GiB files in GNU base-256 with valid checksums', () => {
  for (const size of [12345, 10 * 1024 ** 3]) {
    const header = tarHeader('segment.bin', size);
    assert.equal(header.length, 512);
    assert.equal(header.subarray(0, 100).toString().replace(/\0.*$/, ''), 'segment.bin');
    assert.equal(header.subarray(257, 263).toString(), 'ustar\0');
    const sizeField = header.subarray(124, 136);
    if (size === 12345) {
      assert.match(sizeField.toString(), /^[0-7]{11}\0$/);
      assert.equal(parseInt(sizeField.toString(), 8), size);
    } else {
      assert.equal(sizeField[0], 0x80, 'GNU marker denotes a positive binary size');
      let decoded = BigInt(sizeField[0] & 0x7f);
      for (const byte of sizeField.subarray(1)) decoded = (decoded << 8n) | BigInt(byte);
      assert.equal(decoded, BigInt(size));
    }
    const checksum = parseInt(header.subarray(148, 156).toString(), 8);
    const checksumInput = Buffer.from(header);
    checksumInput.fill(32, 148, 156);
    assert.equal(
      checksum,
      checksumInput.reduce((sum, byte) => sum + byte, 0),
    );
  }
});

test('download API streams MP4, deduplicates jobs, supports Range and removes cached bytes', async (t) => {
  const f = await fixture(t);
  const empty = await f.list();
  assert.deepEqual(empty.items, []);
  assert.equal(empty.usedBytes, 0);
  assert.ok(empty.maxBytes > movie.length);
  const { job, body } = await f.submit('/movie.mp4');
  assert.ok(['queued', 'downloading', 'complete'].includes(job.status));
  const duplicate = await f.json('/api/downloads', body);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.data.id, job.id);
  const normalizedDuplicate = await f.json('/api/downloads', {
    ...body,
    ruleName: `  ${body.ruleName.toUpperCase()}  `,
    episodeUrl: `  ${body.episodeUrl}  `,
  });
  assert.equal(normalizedDuplicate.status, 202);
  assert.equal(normalizedDuplicate.data.id, job.id);
  const completed = await f.finished(job.id);
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal(completed.type, 'video');
  assert.match(completed.playbackUrl, /^\/api\/downloads\/.+\/files\//);
  assert.match(completed.downloadUrl, /^\/api\/downloads\/.+\/download$/);
  const snapshot = await f.list();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.usedBytes, movie.length);
  assert.equal(f.received.filter(({ path }) => path === '/movie.mp4').length, 1);
  f.state.offline = true;
  const whole = await f.fetch(completed.playbackUrl);
  assert.equal(whole.status, 200);
  assert.match(whole.headers.get('content-type'), /video\/mp4/);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), movie);
  const partial = await f.fetch(completed.playbackUrl, { headers: { Range: 'bytes=2-9' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 2-9/${movie.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), movie.subarray(2, 10));
  const attachment = await f.fetch(completed.downloadUrl);
  assert.equal(attachment.status, 200);
  assert.match(attachment.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), movie);
  assert.equal((await f.json(`/api/downloads/${job.id}`, undefined, 'DELETE')).status, 200);
  assert.equal((await f.list()).usedBytes, 0);
  assert.deepEqual((await f.list()).items, []);
  assert.equal((await f.fetch(completed.playbackUrl)).status, 404);
});

test('batch downloads resolve in the background, skip existing episodes and retry only failures', async (t) => {
  const f = await fixture(t, { downloadOptions: { concurrency: 1 } });
  const { job } = await f.submit('/movie.mp4');
  await f.finished(job.id);
  const body = {
    ruleName: `  ${f.rule.name.toUpperCase()}  `,
    title: '整季缓存',
    sourceUrl: `${f.upstreamUrl}/subject`,
    episodes: [
      { name: '第 1 集', url: `${f.upstreamUrl}/movie.mp4` },
      { name: '第 2 集', url: `${f.upstreamUrl}/master.m3u8` },
      { name: '重复集', url: `  ${f.upstreamUrl}/master.m3u8  ` },
      { name: '第 3 集', url: `${f.upstreamUrl}/watch` },
    ],
  };
  const batch = await f.json('/api/downloads/batch', body);
  assert.equal(batch.status, 202, JSON.stringify(batch.data));
  assert.equal(batch.data.added, 2);
  assert.equal(batch.data.skipped, 1);
  assert.equal(batch.data.items.length, 3);
  assert.equal(batch.data.items[0].id, job.id);
  const hls = await f.finished(batch.data.items[1].id);
  assert.equal(hls.status, 'complete', hls.error);
  assert.equal(hls.type, 'hls');
  const failed = await f.finished(batch.data.items[2].id);
  assert.equal(failed.status, 'error');
  assert.ok(failed.error);
  f.state.watchReady = true;
  const retried = await f.json('/api/downloads/batch', body);
  assert.equal(retried.status, 202, JSON.stringify(retried.data));
  assert.equal(retried.data.added, 1);
  assert.equal(retried.data.skipped, 2);
  assert.equal(retried.data.items[1].id, hls.id);
  assert.notEqual(retried.data.items[2].id, failed.id);
  const completed = await f.finished(retried.data.items[2].id);
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal(completed.title, '整季缓存');
  assert.equal(completed.episodeName, '第 3 集');
  assert.equal((await f.list()).items.length, 3);
  const index = JSON.parse(await readFile(join(f.directory, 'downloads/index.json'), 'utf8'));
  assert.ok(index.items.every((item) => !item.rule && !item.source));
});

test('batch validation rejects invalid episodes before enqueueing and respects the shared quota', async (t) => {
  const f = await fixture(t, { downloadOptions: { maxBytes: movie.length } });
  const body = {
    ruleName: f.rule.name,
    episodes: [{ name: '第 1 集', url: `${f.upstreamUrl}/movie.mp4` }],
  };
  for (const episodes of [
    undefined,
    [],
    [null],
    [...body.episodes, {}],
    Array(201).fill(body.episodes[0]),
  ]) {
    const invalid = await f.json('/api/downloads/batch', { ...body, episodes });
    assert.equal(invalid.status, 400, JSON.stringify(invalid.data));
    assert.equal((await f.list()).items.length, 0);
  }
  const first = await f.json('/api/downloads/batch', body);
  assert.equal(first.status, 202, JSON.stringify(first.data));
  assert.equal((await f.finished(first.data.items[0].id)).status, 'complete');
  const duplicate = await f.json('/api/downloads/batch', body);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.data.added, 0);
  assert.equal(duplicate.data.skipped, 1);
  const full = await f.json('/api/downloads/batch', {
    ...body,
    episodes: [...body.episodes, { name: '第 2 集', url: `${f.upstreamUrl}/master.m3u8` }],
  });
  assert.equal(full.status, 507);
  assert.equal((await f.list()).items.length, 1);
});

test('clearing a batch cancels active resolution and queued episodes without recreating jobs', async (t) => {
  const f = await fixture(t, { downloadOptions: { concurrency: 1 } });
  const batch = await f.json('/api/downloads/batch', {
    ruleName: f.rule.name,
    episodes: [
      { name: '正在解析', url: `${f.upstreamUrl}/resolving` },
      { name: '等待解析', url: `${f.upstreamUrl}/movie.mp4` },
    ],
  });
  assert.equal(batch.status, 202, JSON.stringify(batch.data));
  await eventually(
    () => f.state.resolvingConnections,
    (count) => count === 1,
    'resolution did not start',
  );
  const jobs = (await f.list()).items;
  assert.equal(jobs.find((job) => job.episodeName === '正在解析').type, 'pending');
  assert.equal(jobs.find((job) => job.episodeName === '等待解析').status, 'queued');
  assert.equal((await f.json('/api/downloads', undefined, 'DELETE')).status, 200);
  await eventually(
    () => f.state.resolvingConnections,
    (count) => count === 0,
    'resolution was not cancelled',
  );
  assert.deepEqual((await f.list()).items, []);
  assert.equal(f.received.filter(({ path }) => path === '/movie.mp4').length, 0);
});

test('interrupted batch resolutions remain visible as retryable errors after restart', async (t) => {
  const f = await fixture(t, { downloadOptions: { concurrency: 1 } });
  const batch = await f.json('/api/downloads/batch', {
    ruleName: f.rule.name,
    episodes: [
      { name: '正在解析', url: `${f.upstreamUrl}/resolving` },
      { name: '等待解析', url: `${f.upstreamUrl}/movie.mp4` },
    ],
  });
  assert.equal(batch.status, 202, JSON.stringify(batch.data));
  await eventually(
    () => f.state.resolvingConnections,
    (count) => count === 1,
    'resolution did not start',
  );
  await f.restart();
  const jobs = (await f.list()).items;
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.status === 'error' && job.error));
  assert.equal((await f.list()).usedBytes, 0);
});

test('completed cache survives restart and resolves with its source rule removed and upstream offline', async (t) => {
  const f = await fixture(t);
  const { job } = await f.submit('/movie.mp4');
  const completed = await f.finished(job.id);
  assert.equal(completed.status, 'complete', completed.error);
  await f.json(`/api/rules/${encodeURIComponent(f.rule.name)}`, undefined, 'DELETE');
  f.state.offline = true;
  const requestsBefore = f.received.length;
  await f.restart();
  const snapshot = await f.list();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].status, 'complete');
  assert.equal(snapshot.usedBytes, movie.length);
  assert.deepEqual((await f.json('/api/rules')).data.rules, []);
  const resolved = await f.resolve('/movie.mp4');
  assert.equal(resolved.cached, true);
  assert.equal(resolved.downloadId, job.id);
  assert.equal(resolved.type, 'video');
  assert.equal(resolved.originalUrl, `${f.upstreamUrl}/movie.mp4`);
  const response = await f.fetch(resolved.url);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), movie);
  assert.equal(f.received.length, requestsBefore);
});

test('HLS cache includes extensionless playlists, alternate audio, keys, maps and shared byte ranges', async (t) => {
  const f = await fixture(t);
  const { job } = await f.submit('/master.m3u8');
  const completed = await f.finished(job.id);
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal(completed.type, 'hls');
  assert.equal(f.received.filter(({ path }) => path === '/asset').length, 1);
  const beforeOffline = f.received.length;
  f.state.offline = true;
  const resources = new Map();
  async function readResource(path) {
    if (resources.has(path)) return;
    const response = await f.fetch(path);
    assert.equal(response.status, 200, path);
    const bytes = Buffer.from(await response.arrayBuffer());
    resources.set(path, bytes);
    if (!bytes.toString().startsWith('#EXTM3U')) return;
    for (const uri of playlistUris(bytes.toString())) {
      assert.doesNotMatch(uri, /^(?:https?:|\/)|payload=|signature=/);
      assert.ok(!uri.includes('..'), 'playlist references stay inside the download');
      await readResource(new URL(uri, `http://local${path}`).pathname);
    }
  }
  await readResource(completed.playbackUrl);
  assert.equal(resources.size, 6);
  assert.ok([...resources.values()].some((bytes) => bytes.equals(hlsAsset)));
  assert.ok([...resources.values()].some((bytes) => bytes.equals(hlsKey)));
  const variant = [...resources].find(([, bytes]) => bytes.includes('#EXT-X-BYTERANGE:'));
  assert.ok(variant);
  const variantText = variant[1].toString();
  assert.match(variantText, /BYTERANGE="4@0"/);
  assert.match(variantText, /#EXT-X-BYTERANGE:4@4/);
  assert.match(variantText, /#EXT-X-BYTERANGE:4\n/);
  const assetUri = variantText.split('\n').find((line) => line && !line.startsWith('#'));
  const assetPath = new URL(assetUri, `http://local${variant[0]}`).pathname;
  const segment = await f.fetch(assetPath, { headers: { Range: 'bytes=4-7' } });
  assert.equal(segment.status, 206);
  assert.equal(await segment.text(), 'seg1');
  const snapshot = await f.list();
  assert.equal(
    snapshot.usedBytes,
    [...resources.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  );
  const exported = await f.fetch(completed.downloadUrl);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment;.*\.tar\.gz/);
  const archive = untar(gunzipSync(Buffer.from(await exported.arrayBuffer())));
  for (const [path, bytes] of resources) {
    const filename = path.split('/').at(-1);
    const archived = [...archive].find(([name]) => name.split('/').at(-1) === filename);
    assert.ok(archived, `${filename} appears in the archive`);
    assert.deepEqual(archived[1], bytes);
  }
  assert.equal(f.received.length, beforeOffline);
});

test('HLS cache preserves image-prefixed segments served with image MIME types for offline playback and export', async (t) => {
  const f = await fixture(t);
  const { job } = await f.submit('/image-segments.m3u8');
  const completed = await f.finished(job.id);
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal(completed.completedFiles, 3);
  await f.restart();
  const beforeOffline = f.received.length;
  f.state.offline = true;
  const playlist = await (await f.fetch(completed.playbackUrl)).text();
  const segments = playlistUris(playlist);
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    const path = new URL(segment, `http://local${completed.playbackUrl}`).pathname;
    const response = await f.fetch(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageSegment);
    const partial = await f.fetch(path, { headers: { Range: 'bytes=113-300' } });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), imageSegment.subarray(113, 301));
  }
  const snapshot = await f.list();
  assert.equal(snapshot.usedBytes, imageSegment.length * 2 + Buffer.byteLength(playlist));
  const exported = await f.fetch(completed.downloadUrl);
  const files = untar(gunzipSync(Buffer.from(await exported.arrayBuffer())));
  assert.equal(files.size, 3);
  assert.equal([...files.values()].filter((bytes) => bytes.equals(imageSegment)).length, 2);
  assert.equal(f.received.length, beforeOffline);
});

test('HLS cache still rejects HTML, JSON, SVG and image-labeled error pages', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['html', 'json', 'svg', 'png']) {
    const { job } = await f.submit(`/invalid-segment.m3u8?asset=invalid-segment.${suffix}`);
    const failed = await f.finished(job.id);
    assert.equal(failed.status, 'error', suffix);
    assert.match(failed.error, /网页或其他非视频内容/);
    assert.equal(failed.bytes, 0);
    assert.equal(failed.completedFiles, 0);
    assert.equal(failed.playbackUrl, null);
  }
  assert.equal((await f.list()).usedBytes, 0);
  assert.deepEqual(
    (await diskFiles(f.directory)).filter((file) => !file.path.endsWith('.json')),
    [],
  );
});

test('download reuses a server-side media session without exposing or persisting its credentials', async (t) => {
  const f = await fixture(t, { session: true });
  const { job } = await f.submit('/session');
  const completed = await f.finished(job.id);
  assert.equal(completed.status, 'complete', completed.error);
  const mediaRequest = f.received.find(({ path }) => path === '/movie.mp4');
  assert.equal(mediaRequest.headers.authorization, 'Bearer auth-secret');
  assert.equal(mediaRequest.headers.cookie, 'session=cookie-secret');
  const snapshot = await f.list();
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /auth-secret|cookie-secret|upstream-secret|payload|signature|sessionId/,
  );
  for (const file of await diskFiles(f.directory)) {
    if (file.path.endsWith('.json'))
      assert.doesNotMatch(
        await readFile(file.path, 'utf8'),
        /auth-secret|cookie-secret|upstream-secret|payload|signature|sessionId/,
      );
  }
  await f.restart();
  f.state.offline = true;
  const response = await f.fetch(completed.playbackUrl);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), movie);
});

test('invalid media signatures, unsafe file names and failed or live streams cannot become completed cache', async (t) => {
  const f = await fixture(t);
  const resolved = await f.resolve('/movie.mp4');
  const valid = {
    ruleName: f.rule.name,
    episodeUrl: `${f.upstreamUrl}/movie.mp4`,
    title: '测试番剧',
    episodeName: '第 1 集',
    mediaUrl: resolved.url,
  };
  const tampered = new URL(resolved.url, 'http://local');
  tampered.searchParams.set('signature', '0'.repeat(64));
  for (const mediaUrl of [
    tampered.pathname + tampered.search,
    `${f.upstreamUrl}/movie.mp4`,
    '/api/media?payload=bad&signature=bad',
  ]) {
    const response = await f.json('/api/downloads', { ...valid, mediaUrl });
    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
  }
  assert.equal(f.received.length, 0);
  for (const path of ['/broken.mp4', '/fake.mp4', '/image.mp4', '/live.m3u8']) {
    const { job } = await f.submit(path);
    const completed = await f.finished(job.id);
    assert.equal(completed.status, 'error', path);
    assert.ok(completed.error, 'failure has a useful message');
    assert.ok(!completed.playbackUrl);
  }
  assert.equal((await f.list()).usedBytes, 0);
  const { job } = await f.submit('/movie.mp4');
  const completed = await f.finished(job.id);
  assert.equal(completed.status, 'complete', completed.error);
  for (const filename of ['..%2Frules.json', '%2Fetc%2Fpasswd', 'missing.mp4']) {
    const response = await f.fetch(`/api/downloads/${job.id}/files/${filename}`);
    assert.ok(response.status >= 400 && response.status < 500, filename);
  }
});

test('deleting active jobs and clearing the cache cancels upstream requests and removes partial data', async (t) => {
  const f = await fixture(t, { downloadOptions: { concurrency: 1 } });
  const baseline = new Set((await diskFiles(f.directory)).map((file) => file.path));
  const { job: active } = await f.submit('/slow.mp4');
  await eventually(
    () => f.list(),
    (snapshot) => snapshot.usedBytes > 0,
    'partial bytes were not tracked',
  );
  await eventually(
    async () => f.state.slowConnections,
    (count) => count === 1,
    'stream did not open',
  );
  const { job: queued } = await f.submit('/movie.mp4');
  assert.equal(queued.status, 'queued');
  const removed = await f.json(`/api/downloads/${active.id}`, undefined, 'DELETE');
  assert.equal(removed.status, 200);
  await eventually(
    async () => f.state.slowConnections,
    (count) => count === 0,
    'deleted stream remained connected',
  );
  const completed = await f.finished(queued.id);
  assert.equal(completed.status, 'complete', completed.error);
  const { job: second } = await f.submit('/slow.mp4');
  await eventually(
    () => f.list(),
    (snapshot) => snapshot.usedBytes > movie.length,
    'second stream did not start',
  );
  const cleared = await f.json('/api/downloads', undefined, 'DELETE');
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.data, { ok: true });
  await eventually(
    async () => f.state.slowConnections,
    (count) => count === 0,
    'cleared stream remained connected',
  );
  const snapshot = await f.list();
  assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.usedBytes, 0);
  assert.equal((await f.fetch(completed.playbackUrl)).status, 404);
  assert.equal((await f.fetch(`/api/downloads/${second.id}/download`)).status, 404);
  const leftovers = (await diskFiles(f.directory)).filter(
    (file) => !baseline.has(file.path) && !file.path.endsWith('.json'),
  );
  assert.deepEqual(leftovers, []);
});

test('batch deletion validates every ID, removes selected caches and preserves other sources across restart', async (t) => {
  const f = await fixture(t);
  const { job: first } = await f.submit('/movie.mp4');
  const { job: second } = await f.submit('/master.m3u8', { episodeName: '第 2 集' });
  const { job: otherSource } = await f.submit('/movie.mp4', {
    ruleName: 'Other source',
    episodeUrl: `${f.upstreamUrl}/other-source`,
  });
  const { job: otherShow } = await f.submit('/movie.mp4', {
    title: '另一部番剧',
    sourceUrl: `${f.upstreamUrl}/other-subject`,
    episodeUrl: `${f.upstreamUrl}/other-show`,
  });
  const completed = await Promise.all(
    [first, second, otherSource, otherShow].map((job) => f.finished(job.id)),
  );
  assert.ok(completed.every((job) => job.status === 'complete'));
  const before = await f.list();
  for (const ids of [
    undefined,
    null,
    'all',
    [],
    [first.id, '../index.json'],
    [first.id, null],
    Array(201).fill(first.id),
  ]) {
    const invalid = await f.json('/api/downloads/batch', { ids }, 'DELETE');
    assert.equal(invalid.status, 400, JSON.stringify(ids));
    assert.deepEqual(await f.list(), before, 'invalid requests do not delete any cached videos');
  }
  const ids = [first.id, second.id, first.id, '00000000-0000-0000-0000-000000000000'];
  const removed = await f.json('/api/downloads/batch', { ids }, 'DELETE');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { ok: true });
  const remaining = await f.list();
  assert.deepEqual(
    new Set(remaining.items.map((job) => job.id)),
    new Set([otherSource.id, otherShow.id]),
  );
  assert.equal(remaining.usedBytes, completed[2].bytes + completed[3].bytes);
  for (const job of completed.slice(0, 2)) {
    assert.equal((await f.fetch(job.playbackUrl)).status, 404);
    await assert.rejects(stat(join(f.directory, 'downloads', job.id)), { code: 'ENOENT' });
  }
  for (const job of completed.slice(2)) assert.equal((await f.fetch(job.playbackUrl)).status, 200);
  assert.equal(
    (await f.json('/api/downloads/batch', { ids }, 'DELETE')).status,
    200,
    'retries tolerate already removed jobs',
  );
  await f.restart();
  assert.deepEqual(await f.list(), remaining);
});

test('batch deletion cancels active and queued group tasks before the next group episode starts', async (t) => {
  const f = await fixture(t, { downloadOptions: { concurrency: 1 } });
  const { job: active } = await f.submit('/slow.mp4');
  await eventually(
    () => f.list(),
    (snapshot) => snapshot.usedBytes > 0,
    'active download did not start',
  );
  const { job: queued } = await f.submit('/master.m3u8', { episodeName: '第 2 集' });
  assert.equal(queued.status, 'queued');
  const { job: other } = await f.submit('/movie.mp4', {
    title: '另一部番剧',
    sourceUrl: `${f.upstreamUrl}/other-subject`,
  });
  assert.equal(other.status, 'queued');
  const playlistReads = f.received.filter((request) => request.path === '/master.m3u8').length;
  const removed = await f.json('/api/downloads/batch', { ids: [active.id, queued.id] }, 'DELETE');
  assert.equal(removed.status, 200);
  await eventually(
    async () => f.state.slowConnections,
    (count) => count === 0,
    'deleted stream remained connected',
  );
  const completed = await f.finished(other.id);
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal(
    f.received.filter((request) => request.path === '/master.m3u8').length,
    playlistReads,
    'queued group episode never starts downloading',
  );
  const remaining = await f.list();
  assert.deepEqual(
    remaining.items.map((job) => job.id),
    [other.id],
  );
  assert.equal(remaining.usedBytes, completed.bytes);
  for (const job of [active, queued])
    await assert.rejects(stat(join(f.directory, 'downloads', job.id)), { code: 'ENOENT' });
  await f.restart();
  assert.deepEqual(await f.list(), remaining);
});

test('concurrent chunked downloads enforce the shared quota and clean failed partial files', async (t) => {
  const f = await fixture(t, { downloadOptions: { maxBytes: 1024, concurrency: 2 } });
  const submissions = await Promise.all([f.submit('/quota-a.mp4'), f.submit('/quota-b.mp4')]);
  const jobs = await Promise.all(submissions.map(({ job }) => f.finished(job.id)));
  assert.ok(
    jobs.some((job) => job.status === 'error'),
    'at least one download exceeds the shared quota',
  );
  const snapshot = await f.list();
  assert.equal(snapshot.maxBytes, 1024);
  assert.ok(snapshot.usedBytes <= snapshot.maxBytes);
  let storedBytes = 0;
  for (const job of jobs.filter((job) => job.status === 'complete')) {
    const response = await f.fetch(job.playbackUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, 768);
    storedBytes += bytes.length;
  }
  assert.equal(snapshot.usedBytes, storedBytes);
  const mediaFiles = (await diskFiles(f.directory)).filter((file) => !file.path.endsWith('.json'));
  assert.equal(
    mediaFiles.reduce((sum, file) => sum + file.size, 0),
    storedBytes,
  );
  await f.json('/api/downloads', undefined, 'DELETE');
  assert.equal((await f.list()).usedBytes, 0);
});

test('restart removes interrupted partial bytes and a fresh signed request retries the failed task', async (t) => {
  const f = await fixture(t);
  const { job } = await f.submit('/slow.mp4');
  await eventually(
    () => f.list(),
    (snapshot) => snapshot.usedBytes > 0,
    'interrupted download did not write partial bytes',
  );
  await f.restart();
  await eventually(
    async () => f.state.slowConnections,
    (count) => count === 0,
    'restart left the original upstream request active',
  );
  const restarted = await f.list();
  const interrupted = restarted.items.find((item) => item.id === job.id);
  assert.equal(interrupted?.status, 'error');
  assert.ok(interrupted.error);
  assert.ok(!interrupted.playbackUrl);
  assert.equal(restarted.usedBytes, 0);
  assert.deepEqual(
    (await diskFiles(f.directory)).filter((file) => !file.path.endsWith('.json')),
    [],
  );
  f.state.slowCompletes = true;
  const retried = await f.submit('/slow.mp4');
  const completed = await f.finished(retried.job.id);
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal((await f.list()).usedBytes, movie.length);
  const response = await f.fetch(completed.playbackUrl);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), movie);
});
