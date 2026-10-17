import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../../server/index.js';
import { createHttpClient } from '../../server/lib/http.js';
import { MetadataService } from '../../server/modules/metadata/service.js';

test('real HTTP API, rule execution, metadata and media proxy integration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-api-'));
  const received = [];
  const subject = {
    id: 7,
    name: 'Fixture',
    name_cn: '测试番剧',
    images: { large: 'https://example.com/cover.jpg' },
    rating: { score: 8.5, rank: 42 },
    tags: [{ name: '动画' }],
    eps: 2,
  };
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    received.push({
      path: url.pathname,
      method: req.method,
      range: req.headers.range,
      referer: req.headers.referer,
    });
    if (url.pathname === '/v0/search/subjects') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.at(-1).body = JSON.parse(Buffer.concat(chunks).toString());
      received.at(-1).query = Object.fromEntries(url.searchParams);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ total: 1, data: [subject] }));
      return;
    }
    if (url.pathname === '/v0/subjects/7') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(subject));
      return;
    }
    if (url.pathname === '/v0/episodes') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 1, name: '开始', sort: 1 }] }));
      return;
    }
    if (url.pathname === '/p1/trending/subjects') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ total: 1, data: [{ subject }] }));
      return;
    }
    if (url.pathname === '/p1/calendar') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ 1: [{ subject }] }));
      return;
    }
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'text/html');
      res.end('<article><h2><a href="/chapter">测试番剧</a></h2></article>');
      return;
    }
    if (url.pathname === '/chapter') {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<ul><li><a href="/play">第 1 集</a></li><li><a href="/movie.mp4">第 2 集</a></li></ul>',
      );
      return;
    }
    if (url.pathname === '/play') {
      res.setHeader('content-type', 'text/html');
      res.end('<script>var player_aaaa = {"encrypt":0,"url":"/master.m3u8"};</script>');
      return;
    }
    if (url.pathname === '/dynamic-play') {
      res.setHeader('content-type', 'text/html');
      res.end('<iframe src="https://hhjx.hhplayer.com/?url=fixture-token"></iframe>');
      return;
    }
    if (url.pathname === '/hhjx') {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<script>window.__HHJX_BOOTSTRAP__={"url":"fixture-token","t":123456,"key":"fixture-key"};</script>',
      );
      return;
    }
    if (url.pathname === '/api/parse') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.method, 'POST');
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        url: 'fixture-token',
        t: 123456,
        key: 'fixture-key',
        client_fallback: false,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 200, url: 'https://cdn.example.com/no-referer.mp4' }));
      return;
    }
    if (url.pathname === '/master.m3u8' || url.pathname === '/extensionless') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000\nvariant');
      return;
    }
    if (url.pathname === '/variant') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init"\n#EXTINF:5,\nsegment.ts',
      );
      return;
    }
    if (url.pathname === '/movie.mp4' || url.pathname === '/no-referer.mp4') {
      if (url.pathname === '/no-referer.mp4' && req.headers.referer) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('accept-ranges', 'bytes');
      if (req.headers.range) {
        res.writeHead(206, { 'content-range': 'bytes 2-5/10' });
        res.end('2345');
      } else res.end('0123456789');
      return;
    }
    if (url.pathname === '/evil.mp4') {
      res.setHeader('content-type', 'text/html');
      res.end('<script>alert(1)</script>');
      return;
    }
    if (['/key', '/init', '/segment.ts'].includes(url.pathname)) {
      res.setHeader('content-type', 'application/octet-stream');
      res.end('binary-data');
      return;
    }
    res.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const http = createHttpClient({ allowPrivate: true, dnsOverHttpsUrl: '' });
  // Exercise the real parser/proxy over HTTP while keeping the known player
  // origin (the adapter's trust boundary) independent of public services.
  const fixtureHttp = {
    ...http,
    async request(input, options) {
      const target = new URL(input);
      const fixturePath =
        target.hostname === 'hhjx.hhplayer.com'
          ? '/hhjx'
          : target.hostname === 'cdn.example.com'
            ? '/no-referer.mp4'
            : null;
      if (!fixturePath) return http.request(input, options);
      const result = await http.request(`${upstreamUrl}${fixturePath}`, options);
      return { ...result, url: input };
    },
    json(input, options) {
      return http.json(
        new URL(input).hostname === 'hhjx.hhplayer.com' ? `${upstreamUrl}/api/parse` : input,
        options,
      );
    },
  };
  const application = await createApp({
    browserResolver: false,
    dataDir: directory,
    httpClient: fixtureHttp,
    metadata: new MetadataService(http, { apiUrl: upstreamUrl, nextUrl: upstreamUrl }),
    seedRules: [],
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const rule = {
    name: 'Local fixture',
    baseURL: upstreamUrl,
    referer: `${upstreamUrl}/expected-ref`,
    searchURL: `${upstreamUrl}/search?wd=@keyword`,
    searchList: '//article',
    searchName: '//h2/a',
    searchResult: '//h2/a',
    chapterRoads: '//ul',
    chapterResult: '//li/a',
  };
  async function json(path, body, method = 'POST') {
    const response = await fetch(
      `${base}${path}`,
      body === undefined
        ? {}
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    return { status: response.status, data: await response.json() };
  }
  try {
    await t.test('health and unknown API remain JSON', async () => {
      assert.deepEqual((await json('/api/health')).data, { status: 'ok' });
      assert.equal((await json('/api/missing')).status, 404);
    });
    await t.test('mutation blocks cross-site requests and non-JSON forms', async () => {
      const response = await fetch(`${base}/api/rules/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ content: rule }),
      });
      assert.equal(response.status, 403);
      const form = await fetch(`${base}/api/rules/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'content=x',
      });
      assert.equal(form.status, 415);
    });
    await t.test('metadata returns normalized subjects and calendar', async () => {
      assert.equal((await json('/api/catalog?sort=rank')).data.items[0].score, 8.5);
      assert.equal((await json('/api/catalog?sort=trending')).data.items[0].name_cn, '测试番剧');
      assert.equal((await json('/api/calendar')).data[0].items[0].id, 7);
      assert.equal((await json('/api/subjects/7')).data.episodes[0].name, '开始');
      assert.equal((await json('/api/catalog?page=-1')).status, 400);
    });
    await t.test('categories forward combined filters and pagination to Bangumi', async () => {
      const result = await json(
        '/api/categories?tag=日常&tag=原创&format=TV&year=2026&season=4&sort=rank&page=2',
      );
      assert.equal(result.status, 200);
      assert.equal(result.data.items[0].id, 7);
      const request = received.findLast((entry) => entry.path === '/v0/search/subjects');
      assert.deepEqual(request.query, { limit: '24', offset: '24' });
      assert.deepEqual(request.body, {
        keyword: '',
        sort: 'rank',
        filter: {
          type: [2],
          rank: ['>0'],
          tag: ['TV', '原创', '日常'],
          air_date: ['>=2026-10-01', '<2027-01-01'],
        },
      });
      const count = received.length;
      assert.equal(
        (
          await json(
            '/api/categories?tag=原创&tag=日常&format=TV&year=2026&season=4&sort=rank&page=2',
          )
        ).status,
        200,
      );
      assert.equal(
        received.length,
        count,
        'same filters share a cache entry regardless of tag order',
      );
      assert.equal((await json('/api/categories?tag=科幻&year=2025&sort=score')).status, 200);
      assert.deepEqual(received.at(-1).body, {
        keyword: '',
        sort: 'score',
        filter: { type: [2], tag: ['科幻'], air_date: ['>=2025-01-01', '<2026-01-01'] },
      });
      assert.equal((await json('/api/categories')).status, 200);
      assert.deepEqual(received.at(-1).body, { keyword: '', sort: 'heat', filter: { type: [2] } });
    });
    await t.test('invalid category filters are rejected before contacting Bangumi', async () => {
      const count = received.length;
      for (const query of [
        'sort=trending',
        'sort=heat&sort=rank',
        'format=invalid',
        'year=1899',
        'year=2026&year=2025',
        'year=not-a-year',
        'season=1',
        'year=2026&season=5',
        'tag=',
        `tag=${'a'.repeat(41)}`,
        Array(9).fill('tag=日常').join('&'),
        'page=1001',
      ]) {
        assert.equal((await json(`/api/categories?${query}`)).status, 400, query);
      }
      assert.equal(received.length, count);
    });
    await t.test('import, source search, chapters and static playback resolution', async () => {
      assert.equal((await json('/api/rules/import', { content: rule })).status, 200);
      const search = await json('/api/rules/search', { keyword: '测试', ruleNames: [rule.name] });
      assert.equal(search.data.results[0].items[0].name, '测试番剧');
      const chapters = await json('/api/rules/chapters', {
        ruleName: rule.name,
        url: search.data.results[0].items[0].url,
      });
      assert.equal(chapters.data.roads[0].episodes.length, 2);
      const resolved = await json('/api/resolve', {
        ruleName: rule.name,
        url: chapters.data.roads[0].episodes[0].url,
      });
      assert.equal(resolved.data.type, 'hls');
      const master = await (await fetch(`${base}${resolved.data.url}`)).text();
      const variantPath = master.split('\n').find((line) => line.startsWith('/api/media'));
      assert.ok(variantPath, 'master variants are rewritten');
      const variant = await (await fetch(`${base}${variantPath}`)).text();
      assert.match(variant, /#EXT-X-KEY:METHOD=AES-128,URI="\/api\/media/);
      assert.match(variant, /#EXT-X-MAP:URI="\/api\/media/);
      const segment = variant.split('\n').find((line) => line.startsWith('/api/media'));
      assert.equal(await (await fetch(`${base}${segment}`)).text(), 'binary-data');
      assert.ok(
        received
          .filter((request) => ['/master.m3u8', '/variant', '/segment.ts'].includes(request.path))
          .every((request) => request.referer === rule.referer),
      );
    });
    await t.test('extensionless HLS retains playlist kind through signed URLs', async () => {
      const resolved = await json('/api/resolve', {
        ruleName: rule.name,
        url: `${upstreamUrl}/extensionless`,
      });
      assert.equal(resolved.data.type, 'hls');
      const response = await fetch(`${base}${resolved.data.url}`);
      assert.match(response.headers.get('content-type'), /mpegurl/);
      assert.match(await response.text(), /\/api\/media\?/);
    });
    await t.test(
      'dynamic playback stays on the media proxy without the source Referer',
      async () => {
        const resolved = await json('/api/resolve', {
          ruleName: rule.name,
          url: `${upstreamUrl}/dynamic-play`,
        });
        assert.equal(resolved.status, 200);
        assert.equal(resolved.data.type, 'video');
        assert.match(resolved.data.url, /^\/api\/media\?/);
        const response = await fetch(`${base}${resolved.data.url}`, {
          headers: { range: 'bytes=2-5' },
        });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(await response.text(), '2345');
        assert.equal(
          received.find((request) => request.path === '/no-referer.mp4').referer,
          undefined,
        );
      },
    );
    await t.test('media proxy preserves Range semantics and rejects HTML', async () => {
      const resolved = await json('/api/resolve', {
        ruleName: rule.name,
        url: `${upstreamUrl}/movie.mp4`,
      });
      const response = await fetch(`${base}${resolved.data.url}`, {
        headers: { range: 'bytes=2-5' },
      });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
      assert.equal(await response.text(), '2345');
      const evil = await json('/api/resolve', {
        ruleName: rule.name,
        url: `${upstreamUrl}/evil.mp4`,
      });
      const blocked = await fetch(`${base}${evil.data.url}`);
      assert.equal(blocked.status, 422);
      assert.equal(blocked.headers.get('x-content-type-options'), 'nosniff');
      assert.match((await blocked.json()).error, /网页/);
    });
    await t.test('stored rules can be edited and deleted through REST', async () => {
      const path = `/api/rules/${encodeURIComponent(rule.name)}`;
      assert.equal(
        (await json(path, { ...rule, enabled: false }, 'PUT')).data.rules[0].enabled,
        false,
      );
      assert.deepEqual((await json(path, {}, 'DELETE')).data.rules, []);
    });
  } finally {
    await application.close();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});
