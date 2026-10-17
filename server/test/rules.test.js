import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseXPathSearch,
  parseXPathChapters,
  parseApiSearch,
  parseApiChapters,
  prepareApiRequest,
  readPath,
} from '../rules.js';
import { normalizeRule, parseImport, RuleStore } from '../store.js';
import { checkedUrl, isPublicAddress } from '../http.js';
import { extractMedia, rewritePlaylist, MediaService } from '../media.js';
import { normalizeSubject } from '../metadata.js';

const rule = {
  name: 'Fixture',
  api: '8',
  baseURL: 'https://example.com',
  searchList: '//article',
  searchName: '//h2/a/text()',
  searchResult: '//h2/a',
  chapterRoads: '//ul',
  chapterResult: '//li/a',
};

test('Next compact subject info retains precise known dates and episode counts', () => {
  const subject = normalizeSubject({
    id: 1,
    nameCN: '番剧',
    info: '12话 / 2026年10月1日 / 导演',
    tags: [],
    metaTags: ['漫画改'],
  });
  assert.equal(subject.date, '2026-10-01');
  assert.equal(subject.eps, 12);
  assert.deepEqual(subject.tags, ['漫画改']);
  assert.equal(normalizeSubject({ id: 2, info: '2026年 / 制作中' }).date, '2026');
  assert.equal(normalizeSubject({ id: 3, info: '未定' }).date, '');
});

test('XPath search scopes each item and accepts original text() selectors', () => {
  const html =
    '<article><h2><a href="/a">First</a></h2></article><article><h2><a href="/b">Second</a></h2></article>';
  assert.deepEqual(parseXPathSearch(html, rule), [
    { name: 'First', url: 'https://example.com/a' },
    { name: 'Second', url: 'https://example.com/b' },
  ]);
});

test('XPath chapters scope roads, normalize relative URLs, skip missing href', () => {
  const html =
    '<ul><li><a href="/p1"> 第 1 集 </a></li></ul><ul><li><a>invalid</a><a href="//cdn.example.com/p2">第2集</a></li></ul>';
  assert.deepEqual(parseXPathChapters(html, rule), [
    { name: '播放线路1', episodes: [{ name: '第1集', url: 'https://example.com/p1' }] },
    { name: '播放线路2', episodes: [{ name: '第2集', url: 'https://cdn.example.com/p2' }] },
  ]);
});

test('bare // retains the whole document or current fragment like original Kazumi', () => {
  const html = '<ul><li><a href="/one">第一集</a></li><li><a href="/two">第二集</a></li></ul>';
  assert.deepEqual(parseXPathChapters(html, { ...rule, chapterRoads: '//' }), [
    {
      name: '播放线路1',
      episodes: [
        { name: '第一集', url: 'https://example.com/one' },
        { name: '第二集', url: 'https://example.com/two' },
      ],
    },
  ]);
  assert.deepEqual(
    parseXPathSearch(html, { ...rule, searchList: '//a', searchName: '//', searchResult: '//' }),
    [
      { name: '第一集', url: 'https://example.com/one' },
      { name: '第二集', url: 'https://example.com/two' },
    ],
  );
});

test('rule metadata rejects non-scalar display values and normalizes numeric versions', () => {
  for (const field of ['version', 'author', 'type', 'api']) {
    for (const value of [{ unexpected: 'object' }, ['array']]) {
      assert.throws(() => normalizeRule({ ...rule, [field]: value }), /必须是|版本不受支持/);
    }
  }
  assert.equal(normalizeRule({ ...rule, version: 1.2 }).version, '1.2');
  assert.equal(normalizeRule({ ...rule, api: 8 }).api, '8');
  assert.throws(() => normalizeRule({ ...rule, version: Infinity }), /version/);
  assert.throws(() => normalizeRule({ ...rule, api: false }), /版本不受支持/);
});

test('numeric text captcha rules return useful challenge error', () => {
  assert.throws(
    () =>
      parseXPathSearch('<p>Please verify</p>', {
        ...rule,
        antiCrawlerConfig: {
          enabled: true,
          captchaDetectType: 2,
          captchaDetectValue: 'Please verify',
        },
      }),
    /人机验证/,
  );
});

test('API request templates encode URL once and preserve JSON scalar variables', () => {
  const result = prepareApiRequest(
    {
      method: 'POST',
      url: 'https://example.com/@source',
      query: { q: '@keyword' },
      bodyType: 'json',
      body: { id: '@id', keyword: '@keyword' },
    },
    { source: 'a/b', keyword: '中文 &?', id: 42 },
  );
  assert.equal(result.url, 'https://example.com/a%2Fb?q=%E4%B8%AD%E6%96%87+%26%3F');
  assert.deepEqual(JSON.parse(result.body), { id: 42, keyword: '中文 &?' });
});

test('API search preserves opaque source identifiers', () => {
  assert.deepEqual(
    parseApiSearch(
      { data: [{ title: 'Result', shortId: 'opaque-id' }] },
      { namePath: '$.title', sourcePath: '$.shortId' },
    ),
    [{ name: 'Result', url: 'opaque-id' }],
  );
});

test('API 9 search templates encode IDs once, support adjoining text, and skip missing sources', () => {
  const config = {
    listPath: '$.list[*]',
    namePath: '$.name',
    sourcePath: '$.id',
    sourceTemplate: ' https://example.com/GV@source/?id=@source ',
  };
  assert.deepEqual(
    parseApiSearch(
      {
        list: [
          { id: '中文/a%2Fb?x=1&y=2#part', name: '番剧' },
          { id: 0, name: '零号条目' },
          { name: '缺少 ID' },
          { id: '123' },
        ],
      },
      config,
    ),
    [
      {
        name: '番剧',
        url: 'https://example.com/GV%E4%B8%AD%E6%96%87%2Fa%252Fb%3Fx%3D1%26y%3D2%23part/?id=%E4%B8%AD%E6%96%87%2Fa%252Fb%3Fx%3D1%26y%3D2%23part',
      },
      { name: '零号条目', url: 'https://example.com/GV0/?id=0' },
    ],
  );
  for (const sourceTemplate of [null, '', '   '])
    assert.deepEqual(
      parseApiSearch(
        { list: [{ name: '番剧', id: 'opaque-id' }] },
        {
          ...config,
          sourceTemplate,
        },
      ),
      [{ name: '番剧', url: 'opaque-id' }],
    );
  assert.throws(() => parseApiSearch({}, { sourceTemplate: {} }), /必须是文本/);
  assert.throws(
    () => parseApiSearch({}, { sourceTemplate: 'https://example.com/fixed' }),
    /必须引用 @source/,
  );
});

test('nested chapter mapping supports captures and 0/1-based episode templates', () => {
  const config = {
    roadsPath: '$.roads[*]',
    variables: { id: '$.id' },
    episodeUrlPath: '$.id',
    episodePage: {
      url: '/watch/@id/@roadNumber/@episodeNumber',
      query: { ep: '@episodeUrl', road: '@roadIndex', index: '@episodeIndex' },
    },
  };
  const roads = parseApiChapters(
    {
      id: 99,
      roads: [
        {
          name: 'A',
          episodes: [
            { name: 'One', id: 'a/b' },
            { name: 'Two', id: 'c' },
          ],
        },
      ],
    },
    config,
    'opaque',
    rule.baseURL,
  );
  assert.equal(roads[0].episodes[1].url, 'https://example.com/watch/99/1/2?ep=c&road=0&index=1');
  assert.equal(
    roads[0].episodes[0].url,
    'https://example.com/watch/99/1/1?ep=a%2Fb&road=0&index=0',
  );
});

test('delimited chapters use first field delimiter and preserve dollars in URLs', () => {
  const roads = parseApiChapters(
    { names: 'A$$$B', urls: '一$/a?x=$d#二$/b$$$三$/c' },
    { format: 'delimited', roadNamesPath: '$.names', roadEpisodesPath: '$.urls' },
    '/source',
    rule.baseURL,
  );
  assert.equal(roads.length, 2);
  assert.equal(roads[0].episodes[0].url, 'https://example.com/a?x=$d');
  assert.equal(roads[1].name, 'B');
});

test('JSONPath scripts, filters and recursive descent cannot execute', () => {
  for (const path of ['$..url', '$.data[?(@.id>0)]', '$[(process.exit())]'])
    assert.throws(() => readPath({}, path), /JSONPath/);
});

test('share import supports URL-safe, percent-encoded, wrapped links and case-insensitive duplicate names', () => {
  const payload = Buffer.from(JSON.stringify(rule)).toString('base64url');
  const wrapped = `kazumi://${payload.slice(0, 30)}\n${payload.slice(30)}`;
  assert.equal(parseImport(wrapped)[0].name, 'Fixture');
  assert.equal(parseImport(`分享 kazumi://${encodeURIComponent(payload)} done`)[0].name, 'Fixture');
  assert.equal(parseImport([rule, { ...rule, name: 'fixture' }]).length, 1);
});

test('rule persistence serializes concurrent mutations and preserves intentionally empty storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-store-'));
  try {
    const store = await new RuleStore(directory, [rule]).init();
    await Promise.all([store.import({ ...rule, name: 'A' }), store.import({ ...rule, name: 'B' })]);
    assert.equal(JSON.parse(await readFile(join(directory, 'rules.json'), 'utf8')).length, 3);
    await Promise.all(store.list().map((item) => store.remove(item.name)));
    assert.deepEqual((await new RuleStore(directory, [rule]).init()).list(), []);
    await writeFile(join(directory, 'rules.json'), '{broken');
    await assert.rejects(new RuleStore(directory, [rule]).init(), /无法读取/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('URL validation blocks private, loopback, mapped IPv6, metadata and alternate schemes', () => {
  for (const url of [
    'http://127.1',
    'http://2130706433',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://169.254.169.254',
    'http://10.0.0.1',
    'http://localhost.',
    'file:///etc/passwd',
    'https://user:pass@example.com',
  ])
    assert.throws(() => checkedUrl(url));
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('fc00::1'), false);
});

test('static resolver decodes MacCMS player JSON without evaluating scripts', () => {
  const url = 'https://cdn.example.com/video.m3u8?token=a&b=c';
  const encoded = Buffer.from(encodeURIComponent(url)).toString('base64');
  const html = `<script>globalThis.hacked=true;var player_aaaa = ${JSON.stringify({ encrypt: 2, url: encoded })};</script>`;
  assert.deepEqual(extractMedia(html, rule.baseURL), { type: 'hls', url });
  assert.equal(globalThis.hacked, undefined);
  assert.deepEqual(extractMedia('<video><source src="/a.mp4"></video>', rule.baseURL), {
    type: 'video',
    url: 'https://example.com/a.mp4',
  });
});

test('HLS rewrite covers variants, media, keys, maps and segment URLs', () => {
  const rewritten = rewritePlaylist(
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio"\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvariant\nsegment.ts',
    'https://cdn.example.com/a/master.m3u8',
    (url, kind) => `proxy:${kind || 'binary'}:${url}`,
  );
  assert.match(rewritten, /URI="proxy:hls:https:\/\/cdn.example.com\/a\/audio"/);
  assert.match(rewritten, /URI="proxy:binary:https:\/\/cdn.example.com\/key"/);
  assert.match(rewritten, /proxy:hls:https:\/\/cdn.example.com\/a\/variant/);
  assert.match(rewritten, /proxy:binary:https:\/\/cdn.example.com\/a\/segment.ts/);
  assert.throws(
    () => rewritePlaylist('<html>login</html>', rule.baseURL, (value) => value),
    /播放列表格式/,
  );
});

test('media signatures reject tampering and expired URLs', () => {
  const service = new MediaService({ allowPrivate: false }, 'secret');
  const url = new URL(service.proxyUrl('https://cdn.example.com/movie.mp4', {}), rule.baseURL);
  assert.equal(
    service.verify(url.searchParams.get('payload'), url.searchParams.get('signature')).url,
    'https://cdn.example.com/movie.mp4',
  );
  assert.throws(
    () => service.verify(`${url.searchParams.get('payload')}a`, url.searchParams.get('signature')),
    /签名/,
  );
  const expired = new URL(
    service.proxyUrl('https://cdn.example.com/movie.mp4', {}, 1),
    rule.baseURL,
  );
  assert.throws(
    () =>
      service.verify(expired.searchParams.get('payload'), expired.searchParams.get('signature')),
    /过期/,
  );
});
