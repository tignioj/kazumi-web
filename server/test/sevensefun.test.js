import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSevenSefun } from '../sevensefun.js';
import { MediaService } from '../media.js';

const origin = 'https://www.7sefun.top';
const pageUrl = `${origin}/vodplay/38247-2-2.html`;
const token = 'ali_OOrDsKUxu65jo8WC';
const headers = { referer: `${origin}/`, 'user-agent': 'Kazumi fixture' };
const entryUrl = `${origin}/addons/dp/player/index.php?key=0&id=38247&uid=0&from=ndx&url=${token}`;
const artPath = `/addons/dp/player/art.php?key=0&from=ndx&id=38247&uid=0&url=${token}&jump=`;

function episodeHtml(overrides = {}) {
  const data = {
    encrypt: 2,
    from: 'ndx',
    id: '38247',
    vod_data: { vod_name: '尼古喵喵', description: 'A brace } in a quoted value' },
    url: Buffer.from(
      [...token].map((character) => `%${character.charCodeAt(0).toString(16)}`).join(''),
    ).toString('base64'),
    ...overrides,
  };
  return `<script>var player_aaaa=${JSON.stringify(data)}</script>`;
}

function fakeHttp(text = `<script>window.location.href="${artPath}";</script>`, url = entryUrl) {
  const calls = [];
  return {
    calls,
    async text(input, options) {
      calls.push({ input, options });
      return { text, url };
    },
  };
}

test('7sefun ndx decodes the opaque token and follows its public player entry', async () => {
  const http = fakeHttp();
  const result = await resolveSevenSefun(http, episodeHtml(), pageUrl, headers);
  assert.deepEqual(result, { url: `${origin}${artPath}`, headers });
  assert.deepEqual(http.calls, [{ input: entryUrl, options: { headers, maxBytes: 1024 * 1024 } }]);
  assert.strictEqual(result.headers, headers);
  assert.equal(new URL(http.calls[0].input).searchParams.get('url'), token);
});

test('7sefun B line resolves through the media service to a signed local MP4 proxy', async () => {
  const movieUrl =
    'https://media.example.com/FAMILYCLOUD/episode02.mp4?Signature=signed&Expires=9999999999';
  const pages = new Map([
    [pageUrl, episodeHtml()],
    [entryUrl, `<script>window.location.href="${artPath}";</script>`],
    [
      `${origin}${artPath}`,
      `<script>var config={"api":"/index.php/danmu","url":"${movieUrl}","ads":{"vod":"https://ads.example.com/ad.mp4"}};</script>`,
    ],
  ]);
  const requests = [];
  const http = {
    async request(url, options) {
      requests.push(url);
      assert.deepEqual(options.headers, headers);
      assert.ok(pages.has(url), `Unexpected upstream request: ${url}`);
      return {
        url,
        response: new Response(pages.get(url), { headers: { 'content-type': 'text/html' } }),
      };
    },
    async text(url, options) {
      const result = await this.request(url, options);
      return { url: result.url, text: await result.response.text() };
    },
  };
  const media = new MediaService(http, 'fixture-secret');
  const resolved = await media.resolve(
    { baseURL: origin, userAgent: headers['user-agent'], referer: headers.referer },
    pageUrl,
  );
  assert.equal(resolved.type, 'video');
  assert.equal(resolved.originalUrl, pageUrl);
  assert.deepEqual(requests, [pageUrl, entryUrl, `${origin}${artPath}`]);
  const localUrl = new URL(resolved.url, 'http://mac.lan:3000');
  assert.equal(localUrl.pathname, '/api/media');
  const payload = media.verify(
    localUrl.searchParams.get('payload'),
    localUrl.searchParams.get('signature'),
  );
  assert.equal(payload.url, movieUrl);
  assert.equal(payload.kind, 'video');
  assert.deepEqual(payload.headers, headers);
});

test('7sefun accepts literal single-quoted redirects and plain or percent encoded tokens', async () => {
  for (const encrypt of [0, 1]) {
    const http = fakeHttp(`<script> window.location.href = '${artPath}'; </script>`);
    const result = await resolveSevenSefun(
      http,
      episodeHtml({ encrypt, url: encrypt === 1 ? token.replace('_', '%5F') : token }),
      pageUrl,
      headers,
    );
    assert.equal(result.url, `${origin}${artPath}`);
  }
});

test('7sefun does not handle unrelated hosts, pages, or player types', async () => {
  const http = fakeHttp();
  for (const url of [
    'https://example.com/vodplay/38247-2-2.html',
    'https://www.7sefun.top.example.com/vodplay/38247-2-2.html',
    'https://www.7sefun.top:8443/vodplay/38247-2-2.html',
    'https://user@www.7sefun.top/vodplay/38247-2-2.html',
    `${origin}${artPath}`,
  ])
    assert.equal(await resolveSevenSefun(http, episodeHtml(), url, headers), null);
  assert.equal(await resolveSevenSefun(http, episodeHtml({ from: 'lmm' }), pageUrl, headers), null);
  assert.equal(await resolveSevenSefun(http, '<p>no player</p>', pageUrl, headers), null);
  assert.equal(http.calls.length, 0);
});

test('7sefun rejects malformed metadata without requesting an opaque relative page', async () => {
  const http = fakeHttp();
  for (const values of [
    { encrypt: 1, url: '%zz' },
    { encrypt: 3, url: token },
    { encrypt: 0, url: '//elsewhere.example/movie.mp4' },
    { encrypt: 0, url: 'ali_bad?injected=value' },
    { encrypt: 0, url: {} },
    { id: '999' },
  ])
    await assert.rejects(
      resolveSevenSefun(http, episodeHtml(values), pageUrl, headers),
      /播放标识无效/,
    );
  assert.equal(http.calls.length, 0);
});

test('7sefun rejects redirects outside the observed same-origin player route', async () => {
  for (const target of [
    `https://elsewhere.example${artPath}`,
    `//elsewhere.example${artPath}`,
    `http://www.7sefun.top${artPath}`,
    `https://user@www.7sefun.top${artPath}`,
    artPath.replace('/art.php', '/other.php'),
    artPath.replace('from=ndx', 'from=lmm'),
    artPath.replace('id=38247', 'id=999'),
    `${artPath}&url=ali_another`,
    'javascript:alert(1)',
  ]) {
    const http = fakeHttp(`<script>window.location.href="${target}";</script>`);
    await assert.rejects(
      resolveSevenSefun(http, episodeHtml(), pageUrl, headers),
      /播放器跳转无效/,
    );
    assert.equal(http.calls.length, 1);
  }
});

test('7sefun does not execute redirect expressions or treat a challenge as a media address', async () => {
  for (const text of [
    `<script>window.location.href="${artPath}" + getToken();</script>`,
    `<script>window.location.href=getPlayerUrl();</script>`,
    '<html><title>Just a moment...</title><script src="/challenge.js"></script></html>',
    `<script>window.location.href="${artPath}"; globalThis.kazumiUnsafe = true;</script>`,
  ]) {
    await assert.rejects(
      resolveSevenSefun(fakeHttp(text), episodeHtml(), pageUrl, headers),
      /未返回可用地址/,
    );
  }
  assert.equal(globalThis.kazumiUnsafe, undefined);
});

test('7sefun rejects an entry response redirected away from its observed origin and path', async () => {
  for (const url of [`https://elsewhere.example${artPath}`, `${origin}/challenge`]) {
    await assert.rejects(
      resolveSevenSefun(fakeHttp(undefined, url), episodeHtml(), pageUrl, headers),
      /播放器跳转无效/,
    );
  }
});
