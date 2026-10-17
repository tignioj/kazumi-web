import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  codecTracks,
  playlistTracks,
  mp4Tracks,
  compatibility,
  probeMedia,
} from '../../src/features/player/media-probe.js';
import { playbackError, startPlayback } from '../../src/features/player/playback.js';

class Video extends EventTarget {
  error = null;
  canPlayType(mime) {
    return mime.includes('avc1') ? 'probably' : '';
  }
}

test('compatibility checks alternatives separately and leaves missing/partial codec data unknown', () => {
  const video = new Video();
  const variants = playlistTracks(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="hvc1.1.6.L93.B0"\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.64001f"\nb.m3u8',
  );
  assert.equal(compatibility({ variants }, video, 'native').status, 'supported');
  assert.equal(compatibility({ variants: [variants[0]] }, video, 'native').status, 'unsupported');
  assert.equal(compatibility({ variants: [variants[0], []] }, video, 'native').status, 'unknown');
  assert.equal(
    compatibility({ tracks: [{ codec: 'hvc1', mime: 'video/mp4', exact: false }] }, video, 'native')
      .status,
    'unknown',
  );
  assert.equal(compatibility({ tracks: [] }, video, 'native').status, 'unknown');
  const scope = { MediaSource: { isTypeSupported: () => false } };
  assert.equal(
    compatibility({ tracks: codecTracks('avc1.64001f') }, video, 'mse', scope).status,
    'unsupported',
  );
});

test('bounded MP4 sample-description parsing identifies the real fixture AVC configuration', async () => {
  const bytes = await readFile(new URL('../../test/fixtures/sample.mp4', import.meta.url));
  const tracks = mp4Tracks(bytes);
  assert.ok(
    tracks.some((track) => track.codec.startsWith('avc1.') && track.width > 0 && track.height > 0),
  );
  assert.deepEqual(mp4Tracks(new Uint8Array([0, 0, 0, 1, 109, 111, 111, 118])), []);
  assert.deepEqual(mp4Tracks(new TextEncoder().encode('avc1.640028 this is not an MP4')), []);
});

test('native preflight bounds media reads, cancels the stream and preserves proxy HTTP errors', async () => {
  let cancelled = false;
  let options;
  const info = await probeMedia(
    { type: 'video', url: '/api/media?payload=test' },
    new AbortController().signal,
    async (_, input) => {
      options = input;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(512 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'video/mp4' } },
      );
    },
  );
  assert.equal(options.headers.Range, 'bytes=0-262143');
  assert.equal(cancelled, true);
  assert.deepEqual(info.tracks, []);
  await assert.rejects(
    probeMedia(
      { type: 'video', url: '/api/media?payload=test' },
      undefined,
      async () => new Response(JSON.stringify({ error: '媒体地址已过期' }), { status: 403 }),
    ),
    { message: '媒体地址已过期', status: 403 },
  );
});

test('diagnostics distinguish access, expiry, timeout, missing media, codecs, corrupt media and decoding', () => {
  for (const [input, code] of [
    [{ request: { status: 403, message: '媒体地址已过期' } }, 'expired'],
    [{ hls: { type: 'networkError', response: { code: 403 } } }, 'access'],
    [{ hls: { type: 'networkError', response: { code: 404 } } }, 'missing'],
    [{ hls: { type: 'networkError', details: 'fragLoadTimeOut' } }, 'timeout'],
    [{ hls: { type: 'mediaError', details: 'manifestIncompatibleCodecsError' } }, 'codec'],
    [{ hls: { type: 'mediaError', details: 'fragParsingError' } }, 'format'],
    [{ hls: { type: 'mediaError', details: 'fragDecryptError' } }, 'encryption'],
    [{ media: { code: 3 } }, 'decode'],
    [{ media: { code: 4 } }, 'format'],
    [{ media: { code: 2 } }, 'network'],
  ])
    assert.equal(playbackError(input).code, code);
  assert.equal(
    playbackError({
      hls: {
        type: 'networkError',
        response: { code: 502, text: '{"error":"媒体服务器返回 HTTP 403"}' },
      },
    }).code,
    'access',
  );
});

test('native errors appear immediately, then refine from HTTP preflight; disposed checks cannot update UI', async () => {
  const video = new Video();
  let complete;
  const errors = [],
    infos = [];
  const stop = startPlayback(
    video,
    { type: 'video', url: '/api/media?payload=test' },
    {
      onError: (value) => errors.push(value),
      onInfo: (value) => infos.push(value),
      fetcher: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  );
  video.error = { code: 4 };
  video.dispatchEvent(new Event('error'));
  await new Promise(setImmediate);
  assert.equal(errors.at(-1).code, 'format');
  complete(new Response('{"error":"媒体地址已过期"}', { status: 403 }));
  await new Promise(setImmediate);
  assert.equal(errors.at(-1).code, 'expired');
  video.error = null;
  video.dispatchEvent(new Event('playing'));
  assert.equal(errors.at(-1), null);
  assert.equal(infos.at(-1).status, 'playable');
  stop();
  const before = errors.length + infos.length;
  video.dispatchEvent(new Event('playing'));
  video.dispatchEvent(new Event('error'));
  assert.equal(errors.length + infos.length, before);
});

test('hls.js is preferred over native HLS hints and preserves codec/error diagnostics', () => {
  class FakeHls {
    static Events = { MANIFEST_LOADED: 'manifest', BUFFER_CODECS: 'codecs', ERROR: 'error' };
    static isSupported() {
      return true;
    }
    constructor() {
      FakeHls.instance = this;
      this.listeners = new Map();
    }
    on(event, listener) {
      this.listeners.set(event, listener);
    }
    emit(event, data) {
      this.listeners.get(event)?.(event, data);
    }
    loadSource(url) {
      this.url = url;
    }
    attachMedia(video) {
      this.video = video;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const infos = [],
    errors = [];
  const video = new Video();
  // Chromium can report "maybe" even when its native HLS path rejects DM84.
  video.canPlayType = () => 'maybe';
  const stop = startPlayback(
    video,
    { type: 'hls', url: '/api/media?payload=test' },
    {
      HlsClass: FakeHls,
      scope: { MediaSource: { isTypeSupported: (mime) => mime.includes('avc1') } },
      onInfo: (info) => infos.push(info),
      onError: (error) => errors.push(error),
    },
  );
  const hls = FakeHls.instance;
  assert.equal(infos.at(-1).mode, 'mse');
  assert.equal(hls.url, '/api/media?payload=test');
  assert.equal(hls.video, video);
  assert.equal(video.src, undefined, 'native playback must not race the MSE player');
  hls.emit('manifest', { levels: [{ videoCodec: 'avc1.64001f' }] });
  assert.equal(infos.at(-1).status, 'supported');
  hls.emit('codecs', { tracks: { video: { codec: 'hvc1.1.6.L93.B0', container: 'video/mp4' } } });
  assert.equal(infos.at(-1).status, 'unsupported');
  hls.emit('error', { fatal: false, type: 'networkError' });
  assert.equal(errors.length, 0);
  hls.emit('error', { fatal: true, type: 'networkError', response: { code: 403 } });
  assert.equal(errors.at(-1).code, 'access');
  stop();
  assert.equal(hls.destroyed, true);
});

test('native HLS remains available without MSE, and browsers without either get an HLS error', async () => {
  for (const nativeSupport of ['probably', 'maybe', '']) {
    const video = new Video();
    video.canPlayType = () => nativeSupport;
    const infos = [],
      errors = [];
    let probes = 0;
    const stop = startPlayback(
      video,
      { type: 'hls', url: '/api/media?payload=native' },
      {
        HlsClass: { isSupported: () => false },
        onInfo: (info) => infos.push(info),
        onError: (error) => errors.push(error),
        fetcher: async () => {
          probes++;
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:CODECS="avc1.64001f"\nvariant');
        },
      },
    );
    await new Promise(setImmediate);
    if (nativeSupport) {
      assert.equal(video.src, '/api/media?payload=native');
      assert.equal(infos.at(-1).mode, 'native');
      assert.equal(errors.length, 0);
      assert.equal(probes, 1);
    } else {
      assert.equal(video.src, undefined);
      assert.equal(errors.at(-1).code, 'hls');
      assert.equal(probes, 0);
    }
    stop();
  }
});

test('late preflight results cannot change the next episode, and browser capability hints never block playback', async () => {
  const video = new Video();
  const infos = [],
    errors = [];
  let complete;
  const stop = startPlayback(
    video,
    { type: 'video', url: '/api/media?payload=old' },
    {
      onInfo: (info) => infos.push(info),
      onError: (error) => errors.push(error),
      fetcher: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  );
  stop();
  const before = infos.length;
  complete(
    new Response(new Uint8Array(), {
      headers: { 'content-type': 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
    }),
  );
  await new Promise(setImmediate);
  assert.equal(infos.length, before);
  const stopCurrent = startPlayback(
    video,
    { type: 'video', url: '/api/media?payload=current' },
    {
      onInfo: (info) => infos.push(info),
      onError: (error) => errors.push(error),
      fetcher: async () =>
        new Response(new Uint8Array(), {
          headers: { 'content-type': 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
        }),
    },
  );
  await new Promise(setImmediate);
  assert.equal(infos.at(-1).status, 'unsupported');
  assert.equal(video.src, '/api/media?payload=current');
  video.dispatchEvent(new Event('canplay'));
  assert.equal(infos.at(-1).status, 'playable');
  assert.deepEqual(errors, []);
  stopCurrent();
});
