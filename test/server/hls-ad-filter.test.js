import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterHlsAds } from '../../server/modules/playback/hls-ad-filter.js';

const playlistUrl = 'https://cdn.example/episode/index.m3u8';
const playlist = (...groups) =>
  '#EXTM3U\n#EXT-X-TARGETDURATION:100\n' +
  groups
    .map((group) => group.map(([duration, uri]) => `#EXTINF:${duration},\n${uri}\n`).join(''))
    .join('#EXT-X-DISCONTINUITY\n') +
  '#EXT-X-ENDLIST\n';

test('DM84 episode retains all 359 segments and its full 23:59 duration', async () => {
  // Captured EXTINF/discontinuity layout; all media URLs are synthetic.
  const raw = await readFile(
    new URL('./fixtures/dm84-discontinuities.m3u8', import.meta.url),
    'utf8',
  );
  const filtered = filterHlsAds(raw, playlistUrl);
  assert.equal((filtered.match(/^#EXTINF:/gm) || []).length, 359);
  const seconds = [...filtered.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  assert.ok(Math.abs(seconds - 1439.087) < 0.001, `duration was ${seconds}`);
  assert.equal(filtered, raw, 'same-source discontinuities must not remove content or metadata');
});

test('short content survives alongside a separate ad directory', () => {
  const raw = playlist(
    [[100, '/content/start.ts']],
    [[5, '/ads/spot.ts']],
    [[4, '/content/transition.ts']],
    [[20, '/content/scene.ts']],
    [[100, '/content/end.ts']],
  );
  const filtered = filterHlsAds(raw, playlistUrl);
  assert.doesNotMatch(filtered, /\/ads\//);
  assert.match(filtered, /transition\.ts/);
  assert.match(filtered, /scene\.ts/);
  assert.equal((filtered.match(/^#EXTINF:/gm) || []).length, 4);
});

test('relative and absolute segment URLs with different signatures share a content directory', () => {
  const raw = playlist(
    [[5, './intro.ts?token=one']],
    [[100, 'https://cdn.example/episode/main.ts?token=two']],
    [[4, '../episode/ending.ts?token=three#fragment']],
  );
  assert.equal(filterHlsAds(raw, playlistUrl), raw);
});

test('a short group containing content and another source is retained as a whole', () => {
  const raw = playlist(
    [[100, '/content/main.ts']],
    [
      [3, '/other/one.ts'],
      [3, '/content/two.ts'],
    ],
  );
  assert.equal(filterHlsAds(raw, playlistUrl), raw);
});

test('removing a separate preroll preserves original implicit AES IVs and byte offsets', () => {
  const raw =
    '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-MEDIA-SEQUENCE:50\n' +
    '#EXT-X-TARGETDURATION:100\n#EXTINF:5,\n/ads/spot.ts\n#EXT-X-DISCONTINUITY\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="key"\n' +
    '#EXTINF:100,\n#EXT-X-BYTERANGE:100@20\n/content/main.ts\n' +
    '#EXTINF:100,\n#EXT-X-BYTERANGE:100\n/content/main.ts\n#EXT-X-ENDLIST\n';
  const filtered = filterHlsAds(raw, playlistUrl);
  assert.doesNotMatch(filtered, /\/ads\//);
  assert.match(filtered, /#EXT-X-MEDIA-SEQUENCE:51/);
  assert.match(filtered, /#EXT-X-DISCONTINUITY-SEQUENCE:1/);
  assert.match(filtered, /IV=0x00000000000000000000000000000033/);
  assert.match(filtered, /IV=0x00000000000000000000000000000034/);
  assert.match(filtered, /#EXT-X-BYTERANGE:100@120/);
});
