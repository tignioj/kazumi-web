import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { legacyIframeMedia } from '../../server/modules/playback/legacy-parser.js';
import { extractMedia, MediaService } from '../../server/modules/playback/media.js';
import { filterHlsAds } from '../../server/modules/playback/hls-ad-filter.js';

test('legacy iframe extraction is opt-in and preserves signed media query encoding', async () => {
  const url = 'https://cdn.example/movie.m3u8?token=a%2Fb%2Bc&part=1';
  const frame = `https://parser.example/?video=${encodeURIComponent(url)}`;
  const html = `<iframe src="${frame.replaceAll('&', '&amp;')}"></iframe>`;
  assert.equal(extractMedia(html, 'https://site.example/watch').type, 'iframe');
  assert.deepEqual(extractMedia(html, 'https://site.example/watch', { useLegacyParser: true }), {
    url,
    type: 'hls',
    legacy: true,
  });
  const http = {
    allowPrivate: false,
    async request(input) {
      assert.equal(input, 'https://site.example/watch', 'a broken parser need not be loaded');
      return { url: input, response: new Response(html) };
    },
  };
  const media = new MediaService(http, 'compat');
  const result = await media.resolve(
    { baseURL: 'https://site.example', useLegacyParser: true },
    '/watch',
  );
  const signed = new URL(result.url, 'https://local');
  assert.equal(
    media.verify(signed.searchParams.get('payload'), signed.searchParams.get('signature')).url,
    url,
  );
  assert.equal(
    media.verify(signed.searchParams.get('payload'), signed.searchParams.get('signature')).headers
      .referer,
    undefined,
    'legacy media keeps the original empty-Referer semantics',
  );
  assert.equal(
    legacyIframeMedia(`https://googleads.example/?url=${encodeURIComponent(url)}`),
    null,
  );
  assert.equal(legacyIframeMedia('https://parser.example/?url=javascript:alert(1)'), null);
  assert.equal(
    legacyIframeMedia(
      `https://parser.example/?url=${encodeURIComponent('https://wrapper.example/?url=movie.mp4')}`,
    ),
    null,
  );
  media.close();
});

test('HLS filtering matches original duration heuristics and retains unmodified ordinary playlists', () => {
  const playlist =
    '#EXTM3U\n#EXT-X-TARGETDURATION:120\n' +
    '#EXTINF:12,\nad.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:120,\nmain.ts\n' +
    '#EXT-X-DISCONTINUITY\n#EXTINF:8,\ntail.ts\n#EXT-X-ENDLIST\n';
  const result = filterHlsAds(playlist);
  assert.match(result, /main.ts/);
  assert.doesNotMatch(result, /ad.ts|tail.ts/);
  const ordinary = '#EXTM3U\n#EXTINF:20,\none.ts\n#EXTINF:20,\ntwo.ts\n#EXT-X-ENDLIST\n';
  assert.equal(filterHlsAds(ordinary), ordinary);
  const equal = ordinary.replace('#EXTINF:20,\ntwo', '#EXT-X-DISCONTINUITY\n#EXTINF:20,\ntwo');
  assert.equal(filterHlsAds(equal), equal, 'equally long groups are content');
});

test('removing ads preserves AES-128 decryption and implicit byte-range offsets', () => {
  const playlist =
    '#EXTM3U\n#EXT-X-TARGETDURATION:100\n#EXT-X-MEDIA-SEQUENCE:50\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="main.key"\n' +
    '#EXTINF:100,\n#EXT-X-BYTERANGE:16@0\nall.ts\n' +
    '#EXT-X-DISCONTINUITY\n#EXTINF:5,\n#EXT-X-BYTERANGE:16\nall.ts\n' +
    '#EXT-X-DISCONTINUITY\n#EXTINF:100,\n#EXT-X-BYTERANGE:16\nall.ts\n#EXT-X-ENDLIST\n';
  const result = filterHlsAds(playlist);
  assert.match(result, /#EXT-X-BYTERANGE:16@32/);
  assert.doesNotMatch(result, /#EXT-X-BYTERANGE:16@16/);
  const ivs = [...result.matchAll(/IV=0x([a-f0-9]+)/g)].map((match) =>
    Buffer.from(match[1], 'hex'),
  );
  const key = Buffer.alloc(16, 7);
  for (const [index, sequence] of [50, 52].entries()) {
    const originalIV = Buffer.alloc(16);
    originalIV.writeUInt32BE(sequence, 12);
    const cipher = createCipheriv('aes-128-cbc', key, originalIV);
    const encrypted = Buffer.concat([cipher.update('content after filtering'), cipher.final()]);
    const decipher = createDecipheriv('aes-128-cbc', key, ivs[index]);
    assert.equal(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(),
      'content after filtering',
    );
  }
});
