import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export const fixturePort = Number(process.env.E2E_FIXTURE_PORT || 4174);
export const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
export const fixtureRule = {
  api: '8',
  name: '本地测试源',
  version: '1.0',
  type: 'anime',
  baseURL: fixtureUrl,
  searchURL: `${fixtureUrl}/source/search?wd=@keyword`,
  searchList: '//article',
  searchName: '//h2/a/text()',
  searchResult: '//h2/a',
  chapterRoads: '//section[@class="road"]',
  chapterResult: '//a',
  searchMode: 'xpath',
  chapterMode: 'xpath',
  enabled: true,
};

export const subject = {
  id: 101,
  type: 2,
  name: 'Test Animation',
  name_cn: '测试番剧',
  summary: '这是供端到端测试使用的番剧。元数据、规则源与视频均来自本地测试服务。',
  date: '2026-10-01',
  air_date: '2026-10-01',
  air_weekday: 4,
  eps: 2,
  total_episodes: 2,
  platform: 'TV',
  nsfw: false,
  images: {
    large: `${fixtureUrl}/cover.svg`,
    common: `${fixtureUrl}/cover.svg`,
    medium: `${fixtureUrl}/cover.svg`,
  },
  rating: { score: 8.4, rank: 123, total: 456, count: {} },
  collection: { doing: 120, collect: 320, wish: 20 },
  tags: [
    { name: '原创', count: 20 },
    { name: '日常', count: 10 },
  ],
  infobox: [{ key: '中文名', value: '测试番剧' }],
};
const secondSubject = { ...subject, id: 102, name: 'Night Train', name_cn: '夜空列车' };

export async function createUpstream() {
  const video = await readFile(new URL('./sample.mp4', import.meta.url));
  const hlsFiles = Object.fromEntries(
    await Promise.all(
      ['sample.m3u8', 'segment00.ts', 'segment01.ts'].map(async (name) => [
        name,
        await readFile(new URL(`./${name}`, import.meta.url)),
      ]),
    ),
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, fixtureUrl);
    response.setHeader('Access-Control-Allow-Origin', '*');
    const json = (value) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    const html = (value) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(value);
    };
    if (url.pathname === '/calendar')
      return json(
        Array.from({ length: 7 }, (_, index) => ({
          weekday: { id: index + 1, cn: `星期${index + 1}` },
          items: [subject],
        })),
      );
    if (url.pathname === '/p1/calendar')
      return json(
        Object.fromEntries(Array.from({ length: 7 }, (_, index) => [index + 1, [{ subject }]])),
      );
    if (url.pathname === '/p1/trending/subjects')
      return json({
        data: [
          { subject, count: 120 },
          { subject: secondSubject, count: 100 },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      });
    if (url.pathname === '/v0/search/subjects' || url.pathname === '/v0/subjects')
      return json({ data: [subject, secondSubject], total: 2, limit: 20, offset: 0 });
    if (/^\/(v0|p1)\/subjects\/\d+$/.test(url.pathname))
      return json(url.pathname.endsWith('102') ? secondSubject : subject);
    if (url.pathname === '/v0/episodes')
      return json({
        data: [1, 2].map((sort) => ({
          id: 1000 + sort,
          sort,
          ep: sort,
          type: 0,
          name: `Episode ${sort}`,
          name_cn: `第${sort}集`,
          airdate: '2026-10-01',
          duration: '00:20',
        })),
        total: 2,
        limit: 100,
        offset: 0,
      });
    if (/\/subjects\/\d+\/(characters|persons|subjects)$/.test(url.pathname)) return json([]);
    if (url.pathname === '/cover.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      return response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#313749"/><circle cx="150" cy="180" r="70" fill="#fd8da0"/><path d="M0 360L140 240L300 370V420H0Z" fill="#8994bd"/></svg>',
      );
    }
    if (url.pathname === '/source/search')
      return html(
        '<html><body><article><h2><a href="/source/subject/101">测试番剧</a></h2></article><article><h2><a href="/source/subject/102">夜空列车</a></h2></article></body></html>',
      );
    if (url.pathname.startsWith('/source/subject/'))
      return html(
        '<html><body><section class="road"><a href="/source/watch/1">第 1 集</a><a href="/source/watch/2">第 2 集</a></section><section class="road"><a href="/source/watch/3">备用第 1 集</a></section></body></html>',
      );
    if (url.pathname.startsWith('/source/watch/'))
      return html(
        `<html><body><video controls src="${fixtureUrl}/${url.pathname.endsWith('/2') ? 'sample.m3u8' : 'sample.mp4'}"></video></body></html>`,
      );
    if (hlsFiles[url.pathname.slice(1)]) {
      response.setHeader(
        'Content-Type',
        url.pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      );
      return response.end(hlsFiles[url.pathname.slice(1)]);
    }
    if (url.pathname === '/sample.mp4') {
      response.setHeader('Content-Type', 'video/mp4');
      response.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : video.length - 1, video.length - 1);
        if (start > end) {
          response.writeHead(416, { 'Content-Range': `bytes */${video.length}` });
          return response.end();
        }
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${video.length}`,
          'Content-Length': end - start + 1,
        });
        return response.end(video.subarray(start, end + 1));
      }
      response.setHeader('Content-Length', video.length);
      return response.end(video);
    }
    response.statusCode = 404;
    json({ error: `Unknown fixture URL ${url.pathname}` });
  });
  await new Promise((resolve) => server.listen(fixturePort, '127.0.0.1', resolve));
  return server;
}
