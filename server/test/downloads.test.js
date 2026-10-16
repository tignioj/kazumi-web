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
  const state = { offline: false, slowConnections: 0, slowCompletes: false };
  const upstream = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    received.push({ path, headers: req.headers });
    if (state.offline) return res.writeHead(503).end('upstream unavailable');
    if (path === '/session') return res.end('<html>dynamic player</html>');
    if (path === '/broken.mp4') return res.writeHead(502).end('broken upstream');
    if (path === '/fake.mp4') {
      res.setHeader('content-type', 'text/html');
      return res.end('<html>not a video</html>');
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
  for (const path of ['/broken.mp4', '/fake.mp4', '/live.m3u8']) {
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
