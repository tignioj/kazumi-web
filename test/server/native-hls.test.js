import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaService } from '../../server/modules/playback/media.js';
import {
  NativeHlsService,
  registerNativeHlsRoutes,
} from '../../server/modules/playback/native-hls.js';
import { createHttpClient } from '../../server/lib/http.js';

const run = promisify(execFile);
const ffmpeg = resolve('bin/kazumi-ffmpeg');
const ffprobe = resolve('bin/kazumi-ffprobe');
const available = await access(ffmpeg).then(
  () => true,
  () => false,
);
const nativeTest = (name, fn) =>
  test(name, { skip: available ? false : 'Run npm run build:hls first' }, fn);
const cacheId = '00000000-0000-4000-8000-000000000001';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-native-hls-'));
  const clips = [
    ['main0', 4, 10],
    ['short', 2, 14],
    ['main2', 4, 16],
    ['ad', 2, 0],
    ['resume', 4, 14],
  ];
  for (const [name, duration, offset] of clips)
    await run(ffmpeg, [
      '-v',
      'error',
      '-nostdin',
      '-i',
      resolve('test/fixtures/media/sample.mp4'),
      '-t',
      String(duration),
      '-c',
      'copy',
      '-mpegts_copyts',
      '1',
      '-muxdelay',
      '0',
      '-output_ts_offset',
      String(offset),
      '-f',
      'mpegts',
      join(directory, `${name}.ts`),
    ]);
  const playlist = (names) =>
    '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' +
    names
      .map(([name, duration]) => `#EXT-X-DISCONTINUITY\n#EXTINF:${duration},\n${name}.ts\n`)
      .join('') +
    '#EXT-X-ENDLIST\n';
  const continuous = playlist([
    ['main0', 4],
    ['short', 2],
    ['main2', 4],
  ]);
  const ads = playlist([
    ['main0', 4],
    ['ad', 2],
    ['resume', 4],
  ]);
  const received = [];
  let gate, release;
  const upstream = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname.slice(1);
    received.push({ name, headers: req.headers });
    if (req.headers.authorization !== 'Bearer native-fixture') return res.writeHead(403).end();
    if (name === 'main2.ts' && gate) await gate;
    if (res.destroyed) return;
    if (name.endsWith('.m3u8')) {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end(name === 'ads.m3u8' ? ads : continuous);
    }
    try {
      res.setHeader('content-type', 'video/mp2t');
      res.end(await readFile(join(directory, name)));
    } catch {
      res.writeHead(404).end();
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
  const media = new MediaService(http, 'native-hls-test');
  const downloads = {
    ready(id) {
      assert.equal(id, cacheId);
      return { type: 'hls', adBlocker: true, mainFile: 'index.m3u8' };
    },
  };
  const nativeHls = new NativeHlsService({ media, downloads, ffmpeg, ffprobe });
  const app = express();
  app.get('/api/media', (req, res, next) => media.proxy(req, res).catch(next));
  app.get(`/api/downloads/${cacheId}/files/:name`, async (req, res) => {
    if (req.params.name === 'index.m3u8')
      return res.type('application/vnd.apple.mpegurl').send(continuous);
    res.type('video/mp2t').send(await readFile(join(directory, req.params.name)));
  });
  registerNativeHlsRoutes(app, { nativeHls });
  app.use((error, req, res, next) => {
    if (res.destroyed) return;
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const source = (name = 'continuous', adBlocker = true) =>
    media.proxyUrl(
      `${origin}/${name}.m3u8`,
      { authorization: 'Bearer native-fixture' },
      Math.floor(Date.now() / 1000) + 3600,
      'hls',
      undefined,
      adBlocker,
    );
  const request = (action, path, options, start = 0) =>
    fetch(
      `${base}/api/native-media/${action}?${new URLSearchParams({ source: path, start: String(start) })}`,
      options,
    );
  t.after(async () => {
    release?.();
    nativeHls.close();
    media.close();
    await http.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
    await rm(directory, { recursive: true, force: true });
  });
  const count = async (input, flag) => {
    const result = await run(ffprobe, [
      '-v',
      'error',
      ...(flag !== undefined
        ? [
            '-protocol_whitelist',
            'http,tcp,crypto',
            '-allowed_extensions',
            'ALL',
            '-allowed_segment_extensions',
            'ALL',
            '-extension_picky',
            '0',
            '-hls_ad_filter',
            String(flag),
          ]
        : []),
      '-count_packets',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_packets',
      '-of',
      'json',
      input,
    ]);
    return Number(JSON.parse(result.stdout).streams[0].nb_read_packets);
  };
  return {
    base,
    source,
    request,
    received,
    nativeHls,
    directory,
    count,
    blockTail() {
      gate = new Promise((r) => {
        release = r;
      });
      return () => {
        release();
        gate = null;
      };
    },
  };
}

nativeTest(
  'streamed output matches the real upstream PTS filter and preserves short continuous content',
  async (t) => {
    const f = await fixture(t);
    for (const name of ['continuous', 'ads']) {
      const source = f.source(name);
      const unfiltered = await f.count(f.base + source, 0);
      const expected = await f.count(f.base + source, 1);
      if (name === 'continuous')
        assert.equal(expected, unfiltered, 'short same-timeline groups are content');
      else
        assert.ok(
          expected < unfiltered,
          'upstream skips packets whose timestamps return to the ad timeline',
        );
      const info = await (await f.request('info', source)).json();
      assert.equal(info.duration, 10);
      const result = await f.request('stream', source);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type'), /video\/mp4/);
      const path = join(f.directory, `${name}.mp4`);
      await writeFile(path, Buffer.from(await result.arrayBuffer()));
      assert.equal(
        await f.count(path),
        expected,
        'transport never implements its own packet decisions',
      );
    }
    assert.ok(f.received.length > 0);
    assert.ok(f.received.every(({ headers }) => headers.authorization === 'Bearer native-fixture'));
  },
);

nativeTest(
  'first media arrives before the final source segment is available and abort releases the process',
  async (t) => {
    const f = await fixture(t);
    const release = f.blockTail();
    const controller = new AbortController();
    const result = await f.request('stream', f.source(), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    assert.equal(result.status, 200);
    const reader = result.body.getReader();
    const chunk = await reader.read();
    assert.ok(
      chunk.value.length > 0,
      'playback starts while the end of the episode is still blocked',
    );
    controller.abort();
    release();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && f.nativeHls.children.size; i++) await delay(20);
    assert.equal(f.nativeHls.children.size, 0);
  },
);

nativeTest('cached HLS uses the same native playback path without upstream requests', async (t) => {
  const f = await fixture(t);
  const result = await f.request('stream', `/api/downloads/${cacheId}/files/index.m3u8`);
  assert.equal(result.status, 200);
  assert.ok((await result.arrayBuffer()).byteLength > 0);
  assert.equal(f.received.length, 0);
});

nativeTest(
  'native seek preserves packet timestamps and rejects unsafe or expired inputs',
  async (t) => {
    const f = await fixture(t);
    const result = await f.request('stream', f.source(), undefined, 7);
    assert.equal(result.status, 200);
    const path = join(f.directory, 'seek.mp4');
    await writeFile(path, Buffer.from(await result.arrayBuffer()));
    const probe = await run(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=start_time',
      '-of',
      'json',
      path,
    ]);
    assert.ok(Number(JSON.parse(probe.stdout).format.start_time) > 0);
    for (const source of [
      'https://evil.invalid/video.m3u8',
      '/etc/passwd',
      '/api/media?payload=bad&signature=bad',
      f.source('continuous', false),
    ]) {
      const response = await f.request('info', source);
      assert.ok([400, 403].includes(response.status), await response.text());
    }
    const missing = new NativeHlsService({
      media: {},
      downloads: {},
      ffmpeg: '/missing-kazumi-ffmpeg',
    });
    const process = missing.start('/missing-kazumi-ffmpeg', []);
    await assert.rejects(process.done, { status: 503 });
    missing.close();
  },
);
