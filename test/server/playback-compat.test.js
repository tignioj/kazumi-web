import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyIframeMedia } from '../../server/modules/playback/legacy-parser.js';
import { extractMedia, MediaService } from '../../server/modules/playback/media.js';

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
    media.sessions.get(
      media.verify(signed.searchParams.get('payload'), signed.searchParams.get('signature'))
        .sessionId,
    ).headers.referer,
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
