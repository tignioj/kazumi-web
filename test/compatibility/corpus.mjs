import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const api9 = JSON.parse(
  await readFile(new URL('../server/fixtures/api9-rules.json', import.meta.url)),
);
const chapterHtml = {
  LMM: '<div class="module-player-list"><a href="/play/1">第 1 集</a></div>',
  giriGiriLove: '<ul class="anthology-list-play size"><li><a href="/play/1">第 1 集</a></li></ul>',
  mutefun:
    '<div class="module-play-list-content"><a class="module-play-list-link" href="/play/1">第 1 集</a></div>',
  mgnacg: '<ul class="anthology-list-play size"><li><a href="/play/1">第 1 集</a></li></ul>',
  dalvdm:
    '<div id="playlist1" class="lists-box"><a href="/index.php/vod/play/123/sid/1/nid/1.html">第 1 集</a></div>',
};

export const keyword = '番剧 & a/b+中';
export function buildCases(origin) {
  const xpath = (id, extra = {}) => ({
    id,
    rule: {
      name: id,
      api: '9',
      baseURL: origin,
      searchURL: `${origin}/case/${id}/search?wd=@keyword`,
      searchList: '//article',
      searchName: '//a/text()',
      searchResult: '//a',
      chapterRoads: '//ul',
      chapterResult: '//a',
      ...extra,
    },
    search:
      '<article><a href="/detail/1"> 番剧 &amp; 测试 </a></article><article><a href="/detail/2">夜空</a></article>',
    chapters:
      '<ul><a href="/play/1">第 1 集</a><a href="//cdn.example/2">第 2 集</a><a>缺少地址</a></ul>',
    source: `${origin}/case/${id}/detail`,
  });
  const cases = [
    xpath('xpath'),
    xpath('xpath-post', { usePost: true }),
    xpath('xpath-bare', { chapterRoads: '//' }),
  ];
  cases.push({ ...xpath('xpath-empty-results'), search: '<p>没有结果</p>' });
  cases.push({
    ...xpath('xpath-normalize'),
    search: `<article><a href="${origin}/detail/1///?">一</a></article>`,
    chapters: `<ul><a href="${origin.replace(/^https?:/, origin.startsWith('https:') ? 'http:' : 'https:')}/play/1///?">一</a></ul>`,
  });
  cases.push({
    ...xpath('xpath-empty-road'),
    chapters: '<ul></ul><ul><a href="/play/1"> 一 </a></ul>',
  });
  cases.push({
    ...xpath('xpath-attributes', { searchName: '//a/@title' }),
    search: '<article><a title=" 标题 " href="../detail/1">名称</a></article>',
  });
  cases.push({
    ...xpath('xpath-mixed-text'),
    search:
      '<article><a href="/detail/1">开<span>中</span>尾</a></article>' +
      '<article><a href="/detail/2"><span>嵌套标题</span></a></article>' +
      '<article><a href="/empty"></a></article>',
    chapters: '<ul><a href="/play/1">第 <span>1</span> 集</a></ul>',
  });
  cases.push({
    ...xpath('xpath-encoded-urls'),
    search: '<article><a href="/detail/%61/%7e?q=%61%2f#%61">编码地址</a></article>',
    chapters:
      '<ul><a href="/play/%61/%7e/%2f/%3f/%23/%25/%E4%b8%AD///?q=%61%7e%2f%20%2b#%61%2f">一</a>' +
      '<a href="/play/%zz?x=%zz#%zz">二</a></ul>',
  });
  const postId = 'xpath-post-duplicates';
  cases.push(
    xpath(postId, {
      usePost: true,
      searchURL: `${origin}/case/${postId}/search?tag=first&tag=last&wd=@keyword&empty`,
    }),
  );
  cases.push({
    ...xpath('xpath-cf-header'),
    rule: {
      ...xpath('xpath-cf-header').rule,
      antiCrawlerConfig: {
        enabled: true,
        captchaType: 2,
        captchaButton: '//button',
        captchaDetectType: 2,
        captchaDetectValue: 'not in the response',
      },
    },
    search: '',
    searchResponse: { status: 403, headers: { 'cf-mitigated': 'challenge' } },
    verificationRequired: true,
  });
  for (const original of api9) {
    const id = `official-${original.name}`;
    const rule = structuredClone(original);
    rule.baseURL = origin;
    rule.searchApiConfig.request.url = `${origin}/case/${id}/search`;
    if (rule.searchApiConfig.sourceTemplate)
      rule.searchApiConfig.sourceTemplate = rule.searchApiConfig.sourceTemplate.replace(
        new URL(original.baseURL).origin,
        origin,
      );
    cases.push({
      id,
      rule,
      search: {
        list: [{ id: 'a/b +中', name: '番剧' }, { id: 7, name: '数字 ID' }, { name: '缺少 ID' }],
      },
      chapters: chapterHtml[original.name],
      source: `${origin}/case/${id}/detail`,
    });
  }
  const api = (id, chapterApiConfig, extra = {}) => ({
    id,
    rule: {
      ...xpath(id).rule,
      searchMode: 'api',
      chapterMode: 'api',
      searchApiConfig: {
        request: {
          url: `${origin}/case/${id}/search`,
          method: 'POST',
          bodyType: 'json',
          body: { keyword: '@keyword', page: 1, enabled: true },
        },
        listPath: '$.data[*]',
        namePath: '$.name',
        sourcePath: '$.id',
      },
      chapterApiConfig: {
        request: { url: `${origin}/case/${id}/chapters`, query: { source: '@source' } },
        ...chapterApiConfig,
      },
      ...extra,
    },
    search: {
      data: [
        null,
        { id: 'opaque/a%2Fb', name: '番剧' },
        { id: 7, name: '数字' },
        { id: 'missing' },
      ],
    },
    source: 'opaque/a%2Fb',
  });
  cases.push({
    ...api('api-nested', {
      variables: { token: '$.token' },
      episodePage: {
        url: '/play/@source',
        query: { token: '@token', r: '@roadNumber', e: '@episodeIndex', url: '@episodeUrl' },
      },
    }),
    chapters: {
      token: 'x/y +',
      data: {
        roads: [{ name: '线路', episodes: [{ name: '一', url: 'a/b?x=1' }, { url: 'next' }] }],
      },
    },
  });
  cases.push({
    ...api('api-root', {
      roadsPath: '',
      roadNamePath: '',
      episodesPath: '$.items[*]',
      episodeNamePath: "$['title']",
      episodeUrlPath: '$["url"]',
    }),
    chapters: { items: [{ title: '一', url: '/play/1' }, null, { title: '无地址' }] },
  });
  cases.push({
    ...api('api-empty-road', {}),
    chapters: {
      data: { roads: [{ episodes: [] }, { episodes: [{ name: '一', url: '/play/1' }] }] },
    },
  });
  cases.push({
    ...api('api-delimited', {
      format: 'delimited',
      roadNamesPath: '$.names',
      roadEpisodesPath: '$.episodes',
    }),
    chapters: {
      names: '线路一$$$线路二',
      episodes: '一$/play/1?token=a$b#二$/play/2$$$三$/play/3',
    },
  });
  cases.push(
    api(
      'api-form',
      {},
      {
        searchApiConfig: {
          request: {
            url: `${origin}/case/api-form/search`,
            method: 'POST',
            bodyType: 'form',
            body: { wd: '@keyword', page: 1 },
          },
          listPath: '$.data[*]',
          namePath: '$.name',
          sourcePath: '$.id',
          sourceTemplate: `${origin}/GV@source/`,
        },
      },
    ),
  );
  cases.at(-1).chapters = {
    data: { roads: [{ name: '线路', episodes: [{ name: '一', url: '/play/1' }] }] },
  };
  for (const bodyType of ['query', 'form']) {
    const id = `api-${bodyType}-collections`;
    const c = api(id, {});
    const parameters = {
      tag: ['A', 'B'],
      filter: { x: 1, tags: ['@keyword', "a~!*'()"] },
      rows: [{ id: 1 }, { id: 2 }],
      matrix: [
        [1, 2],
        [3, null],
      ],
      empty: null,
      blank: '',
      zero: 0,
      false: false,
      none: [],
      missing: {},
    };
    c.rule.searchApiConfig.request = {
      url: `${origin}/case/${id}/search?tag=old&tag=older`,
      ...(bodyType === 'query'
        ? { query: parameters }
        : { method: 'POST', bodyType: 'form', body: parameters }),
    };
    c.chapters = {
      data: { roads: [{ episodes: [{ name: '一', url: '/play/%61' }] }] },
    };
    cases.push(c);
  }
  return cases;
}

// The two transports use different error codes for the same official challenge.
// Assert each code before comparing their shared verification requirement.
export async function searchCase(engine, c, verificationCode = 'VERIFICATION_REQUIRED') {
  if (!c.verificationRequired) return engine.search(c.rule, keyword);
  await assert.rejects(engine.search(c.rule, keyword), { code: verificationCode });
  return { verificationRequired: true };
}

export function canonicalRequest(url, options = {}) {
  const parsed = new URL(url);
  const contentType = new Headers(options.headers).get('content-type') || '';
  const body =
    options.body == null
      ? null
      : contentType.includes('json')
        ? JSON.parse(String(options.body))
        : [...new URLSearchParams(String(options.body))];
  return {
    path: parsed.pathname,
    query: [...parsed.searchParams],
    method: options.method || 'GET',
    body,
  };
}

export function normalizeOrigin(value, origin) {
  return JSON.parse(JSON.stringify(value).replaceAll(origin, 'https://fixture.example'));
}
