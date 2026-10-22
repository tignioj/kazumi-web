import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXPathSearch,
  parseXPathChapters,
  parseApiSearch,
  parseApiChapters,
  RuleEngine,
} from '../../server/modules/rules/engine.js';
import { RuleParseTrace, TRACE_LIMITS } from '../../server/modules/rules/trace.js';

const rule = {
  name: 'Parse trace',
  baseURL: 'https://example.com',
  searchURL: 'https://example.com/search?wd=@keyword',
  searchList: '//article',
  searchName: '//a',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
};

function traceFor(stage, mode, raw) {
  const trace = new RuleParseTrace(stage, mode);
  trace.capture(raw, mode === 'api' ? 'json' : 'html');
  return trace;
}

test('XPath search traces original fragments, child selections and each skipped item without changing results', () => {
  const raw =
    '<article><a href="/one">One</a></article>' +
    '<article><a href="/empty"></a></article>' +
    '<article><a>No source</a></article>' +
    '<article><a href="javascript:bad">Invalid source</a></article>';
  const trace = traceFor('search', 'xpath', raw);
  const items = parseXPathSearch(raw, rule, trace);
  assert.deepEqual(items, parseXPathSearch(raw, rule));
  assert.deepEqual(items, [{ name: 'One', url: 'https://example.com/one' }]);
  const result = trace.snapshot();
  assert.deepEqual(result.counts.items, { matched: 4, accepted: 1, skipped: 3 });
  assert.deepEqual(
    result.nodes.map(({ index, status }) => [index, status]),
    [
      [1, 'accepted'],
      [2, 'skipped'],
      [3, 'skipped'],
      [4, 'skipped'],
    ],
  );
  assert.match(result.nodes[0].fragment, /^<article><a href="\/one">/);
  assert.match(result.nodes[1].reason, /缺少名称/);
  assert.match(result.nodes[2].reason, /缺少来源/);
  assert.match(result.nodes[3].reason, /地址无效/);
  assert.deepEqual(result.selections[0], {
    label: 'searchList',
    expression: '//article',
    context: '响应',
    matched: 4,
  });
  assert.equal(result.selections.filter(({ label }) => label === 'searchName').length, 4);
  assert.equal(result.selections.filter(({ label }) => label === 'searchResult').length, 4);
});

test('XPath chapters retain original road and episode indices while accepting fallback names', () => {
  const raw = '<ul></ul><ul><a>Missing URL</a><a href="/two"></a></ul>';
  const trace = traceFor('chapters', 'xpath', raw);
  const roads = parseXPathChapters(raw, rule, trace);
  assert.deepEqual(roads, parseXPathChapters(raw, rule));
  assert.deepEqual(roads, [
    {
      name: '播放线路1',
      episodes: [{ name: '第2集', url: 'https://example.com/two' }],
    },
  ]);
  const result = trace.snapshot();
  assert.deepEqual(result.counts.roads, { matched: 2, accepted: 1, skipped: 1 });
  assert.deepEqual(result.counts.episodes, { matched: 2, accepted: 1, skipped: 1 });
  const acceptedEpisode = result.nodes.find(
    ({ kind, status }) => kind === 'episode' && status === 'accepted',
  );
  assert.equal(acceptedEpisode.index, 2);
  assert.equal(acceptedEpisode.roadIndex, 2);
  assert.equal(acceptedEpisode.name, '第2集');
  assert.match(acceptedEpisode.fragment, /href="\/two"/);
  const acceptedRoad = result.nodes.find(
    ({ kind, status }) => kind === 'road' && status === 'accepted',
  );
  assert.equal(acceptedRoad.index, 2);
  assert.equal(acceptedRoad.name, '播放线路1');
  assert.ok(result.diagnostics.some((message) => /无有效剧集/.test(message)));
  assert.ok(result.diagnostics.some((message) => /chapterResult 未匹配/.test(message)));
});

test('bare XPath road selectors retain the full document HTML as their fragment', () => {
  const raw = '<ul><a href="/one">One</a></ul>';
  const trace = traceFor('chapters', 'xpath', raw);
  const roads = parseXPathChapters(raw, { ...rule, chapterRoads: '//' }, trace);
  assert.equal(roads.length, 1);
  const road = trace.snapshot().nodes.find(({ kind }) => kind === 'road');
  assert.equal(road.fragment, `<html><head></head><body>${raw}</body></html>`);
});

test('API search records JSON fragments, missing fields and opaque source template outputs', () => {
  const data = { data: [null, { name: 'One', id: 'a/b' }, { name: 'No source' }, { id: 4 }] };
  const config = { sourcePath: '$.id', sourceTemplate: 'https://example.com/GV@source' };
  const trace = traceFor('search', 'api', JSON.stringify(data));
  const items = parseApiSearch(data, config, trace);
  assert.deepEqual(items, parseApiSearch(data, config));
  assert.deepEqual(items, [{ name: 'One', url: 'https://example.com/GVa%2Fb' }]);
  const result = trace.snapshot();
  assert.deepEqual(result.counts.items, { matched: 4, accepted: 1, skipped: 3 });
  assert.equal(result.nodes[0].fragment, 'null');
  assert.equal(result.nodes[1].fragment, '{"name":"One","id":"a/b"}');
  assert.equal(result.nodes[1].index, 2);
  assert.equal(result.selections.filter(({ label }) => label === 'namePath').length, 4);
  assert.equal(result.selections.filter(({ label }) => label === 'sourcePath').length, 4);
});

test('nested API chapters trace captured variables, empty roads and missing URLs with original indices', () => {
  const data = {
    token: 'token',
    data: {
      roads: [{ episodes: [] }, { episodes: [{ name: 'Missing URL' }, { url: '/two' }, null] }],
    },
  };
  const config = { variables: { token: '$.token' } };
  const trace = traceFor('chapters', 'api', JSON.stringify(data));
  const roads = parseApiChapters(data, config, 'source', rule.baseURL, trace);
  assert.deepEqual(roads, parseApiChapters(data, config, 'source', rule.baseURL));
  assert.deepEqual(roads, [
    {
      name: '播放线路1',
      episodes: [{ name: '第2集', url: 'https://example.com/two' }],
    },
  ]);
  const result = trace.snapshot();
  assert.deepEqual(result.counts.roads, { matched: 2, accepted: 1, skipped: 1 });
  assert.deepEqual(result.counts.episodes, { matched: 3, accepted: 1, skipped: 2 });
  assert.equal(result.selections.find(({ label }) => label === 'variables.token').matched, 1);
  assert.equal(result.selections.filter(({ label }) => label === 'episodeUrlPath').length, 3);
  const episode = result.nodes.find(
    ({ kind, status }) => kind === 'episode' && status === 'accepted',
  );
  assert.equal(episode.index, 2);
  assert.equal(episode.roadIndex, 2);
  assert.equal(episode.fragment, '{"url":"/two"}');
});

test('root API chapter templates accept missing raw URLs and fallback names', () => {
  const data = { episodes: [{}] };
  const config = {
    roadsPath: '',
    episodeUrlPath: '',
    episodePage: { url: '/play/@source/@episodeNumber' },
  };
  const trace = traceFor('chapters', 'api', JSON.stringify(data));
  const roads = parseApiChapters(data, config, 'opaque', rule.baseURL, trace);
  assert.deepEqual(roads, parseApiChapters(data, config, 'opaque', rule.baseURL));
  assert.deepEqual(roads, [
    {
      name: '播放线路1',
      episodes: [{ name: '第1集', url: 'https://example.com/play/opaque/1' }],
    },
  ]);
  const result = trace.snapshot();
  assert.equal(result.counts.episodes.skipped, 0);
  assert.equal(result.counts.roads.skipped, 0);
  assert.equal(
    result.selections.some(({ label }) => label === 'episodeUrlPath'),
    false,
  );
});

test('invalid episode-page templates are distinguished from missing raw episode URLs', () => {
  for (const [data, config] of [
    [{ episodes: [{}] }, { roadsPath: '', episodeUrlPath: '' }],
    [
      { names: '', episodes: '$' },
      { format: 'delimited', roadNamesPath: '$.names', roadEpisodesPath: '$.episodes' },
    ],
  ]) {
    const trace = traceFor('chapters', 'api', JSON.stringify(data));
    const settings = { ...config, episodePage: { url: 'javascript:invalid' } };
    assert.deepEqual(parseApiChapters(data, settings, 'source', rule.baseURL, trace), []);
    const episode = trace.snapshot().nodes.find(({ kind }) => kind === 'episode');
    assert.equal(episode.status, 'skipped');
    assert.equal(episode.reason, '剧集地址模板生成的地址无效');
  }
});

test('delimited API chapters retain original entry fragments and explain every discarded entry', () => {
  const data = { names: '', episodes: 'broken#Missing$#$/play/3$$$missing' };
  const config = { format: 'delimited', roadNamesPath: '$.names', roadEpisodesPath: '$.episodes' };
  const trace = traceFor('chapters', 'api', JSON.stringify(data));
  const roads = parseApiChapters(data, config, 'source', rule.baseURL, trace);
  assert.deepEqual(roads, parseApiChapters(data, config, 'source', rule.baseURL));
  assert.deepEqual(roads, [
    {
      name: '播放线路1',
      episodes: [{ name: '第3集', url: 'https://example.com/play/3' }],
    },
  ]);
  const result = trace.snapshot();
  assert.deepEqual(result.counts.episodes, { matched: 4, accepted: 1, skipped: 3 });
  assert.deepEqual(result.counts.roads, { matched: 2, accepted: 1, skipped: 1 });
  const episodes = result.nodes.filter(({ kind }) => kind === 'episode');
  assert.deepEqual(
    episodes.map(({ fragment }) => fragment),
    ['broken', 'Missing$', '$/play/3', 'missing'],
  );
  assert.match(episodes[0].reason, /字段分隔符/);
  assert.match(episodes[1].reason, /缺少 URL/);
  assert.equal(episodes[2].index, 3);
  assert.equal(episodes[2].status, 'accepted');
  assert.equal(
    result.nodes.find(({ kind }) => kind === 'road').fragment,
    'broken#Missing$#$/play/3',
  );
});

test('all parsing modes explain zero matches without turning empty results into errors', () => {
  for (const [stage, mode, parse] of [
    ['search', 'xpath', (trace) => parseXPathSearch('<p>Empty</p>', rule, trace)],
    ['chapters', 'xpath', (trace) => parseXPathChapters('<p>Empty</p>', rule, trace)],
    ['search', 'api', (trace) => parseApiSearch({}, {}, trace)],
    ['chapters', 'api', (trace) => parseApiChapters({}, {}, 'source', rule.baseURL, trace)],
    [
      'chapters',
      'api',
      (trace) =>
        parseApiChapters(
          {},
          {
            format: 'delimited',
            roadNamesPath: '$.names',
            roadEpisodesPath: '$.episodes',
          },
          'source',
          rule.baseURL,
          trace,
        ),
    ],
  ]) {
    const trace = traceFor(stage, mode, '');
    assert.deepEqual(parse(trace), []);
    assert.ok(trace.snapshot().selections.some(({ matched }) => matched === 0));
    assert.ok(trace.snapshot().diagnostics.some((message) => /未匹配/.test(message)));
  }
});

test('selector and captured-variable failures retain their errors and record actionable diagnostics', () => {
  const xpathTrace = traceFor('search', 'xpath', searchHtml);
  assert.throws(
    () => parseXPathSearch(searchHtml, { ...rule, searchName: '//a[' }, xpathTrace),
    /XPath 无效/,
  );
  assert.ok(
    xpathTrace.snapshot().diagnostics.some((message) => /searchName 解析失败/.test(message)),
  );
  const apiTrace = traceFor('chapters', 'api', '{}');
  assert.throws(
    () =>
      parseApiChapters({}, { variables: { token: '$.token' } }, 'source', rule.baseURL, apiTrace),
    /变量 token 未匹配到值/,
  );
  assert.ok(
    apiTrace.snapshot().diagnostics.some((message) => /variables.token 未匹配/.test(message)),
  );
});

const searchHtml = '<article><a href="/one">One</a></article>';

test('trace-disabled API parsing does not serialize diagnostic fragments', () => {
  let serializations = 0;
  const item = {
    name: 'One',
    url: '/one',
    toJSON() {
      serializations++;
      return { name: this.name };
    },
  };
  assert.equal(parseApiSearch({ data: [item] }).length, 1);
  assert.equal(
    parseApiChapters({ data: { roads: [{ episodes: [item] }] } }, {}, 'source', rule.baseURL)
      .length,
    1,
  );
  assert.equal(serializations, 0);
});

test('deep valid JSON keeps successful engine results when diagnostic fragment serialization fails', async () => {
  const raw =
    '{"data":[{"name":"One","url":"/one","unused":' +
    '['.repeat(8000) +
    '0' +
    ']'.repeat(8000) +
    '}]}';
  const draft = {
    ...rule,
    searchMode: 'api',
    searchApiConfig: { request: { url: 'https://example.com/api' } },
  };
  const engine = new RuleEngine({ text: async () => ({ text: raw }) });
  const expected = await engine.search(draft, 'keyword');
  assert.deepEqual(expected, [{ name: 'One', url: '/one' }]);
  const trace = new RuleParseTrace('search', 'api');
  assert.deepEqual(await engine.search(draft, 'keyword', { trace }), expected);
  const result = trace.snapshot();
  assert.equal(result.response.raw, raw);
  assert.deepEqual(result.counts.items, { matched: 1, accepted: 1, skipped: 0 });
  assert.equal(result.nodes[0].status, 'accepted');
  assert.equal(result.nodes[0].fragment, '');
  assert.match(result.nodes[0].fragmentError, /片段无法序列化/);
  assert.ok(result.diagnostics.some((message) => /片段无法序列化/.test(message)));
});

test('trace counts every parsed item even after retained node details reach their limit', () => {
  const data = {
    data: Array.from({ length: TRACE_LIMITS.nodes + 3 }, (_, index) => ({
      name: `Item ${index}`,
      url: `/item/${index}`,
    })),
  };
  const trace = traceFor('search', 'api', JSON.stringify(data));
  assert.equal(parseApiSearch(data, {}, trace).length, TRACE_LIMITS.nodes + 3);
  const result = trace.snapshot();
  assert.equal(result.nodes.length, TRACE_LIMITS.nodes);
  assert.equal(result.counts.items.matched, TRACE_LIMITS.nodes + 3);
  assert.equal(result.omittedNodes, 3);
});

test('invalid upstream JSON is captured before decoding and retains the safe external error', async () => {
  const raw = '{"data": [invalid JSON';
  const trace = new RuleParseTrace('search', 'api');
  const engine = new RuleEngine({ text: async () => ({ text: raw }) });
  await assert.rejects(
    engine.search(
      {
        ...rule,
        searchMode: 'api',
        searchApiConfig: { request: { url: 'https://example.com/api' } },
      },
      'keyword',
      { trace },
    ),
    { code: 'SOURCE_RULE_ERROR', status: 502 },
  );
  const result = trace.snapshot();
  assert.equal(result.response.raw, raw);
  assert.equal(result.response.format, 'json');
  assert.ok(result.diagnostics.some((message) => /JSON 语法错误/.test(message)));
});

for (const mode of ['xpath', 'api']) {
  for (const stage of ['search', 'chapters']) {
    test(`${mode} ${stage} browser fallback traces only its final parsed response`, async () => {
      const challenge = '<p>VERIFY REQUIRED</p>';
      const raw =
        mode === 'api'
          ? JSON.stringify(
              stage === 'search'
                ? { data: [{ name: 'One', url: '/one' }] }
                : { data: { roads: [{ episodes: [{ name: 'One', url: '/one' }] }] } },
            )
          : stage === 'search'
            ? searchHtml
            : '<ul><a href="/one">One</a></ul>';
      const trace = new RuleParseTrace(stage, mode);
      let reads = 0;
      const engine = new RuleEngine(
        { text: async () => ({ text: challenge }) },
        {
          browserResolver: {
            read: async (_rule, _request, options) => {
              reads++;
              return options.parse(raw);
            },
          },
        },
      );
      const draft = {
        ...rule,
        searchMode: mode,
        chapterMode: mode,
        searchApiConfig: { request: { url: 'https://example.com/search' } },
        chapterApiConfig: { request: { url: 'https://example.com/chapters' } },
        antiCrawlerConfig: {
          enabled: true,
          captchaType: 1,
          captchaDetectType: 2,
          captchaDetectValue: 'VERIFY REQUIRED',
        },
      };
      const result = await engine[stage](draft, stage === 'search' ? 'keyword' : '/detail', {
        trace,
        onVerification: async () => {},
      });
      assert.equal(reads, 1);
      assert.equal(result.length, 1);
      const snapshot = trace.snapshot();
      assert.equal(snapshot.response.raw, raw);
      assert.equal(snapshot.response.format, mode === 'api' ? 'json' : 'html');
      assert.equal(snapshot.counts[stage === 'search' ? 'items' : 'episodes'].accepted, 1);
      assert.equal(
        snapshot.diagnostics.some((message) => /响应解析失败/.test(message)),
        false,
      );
      assert.equal(
        snapshot.nodes.some(({ fragment }) => fragment.includes('VERIFY REQUIRED')),
        false,
      );
    });
  }
}
