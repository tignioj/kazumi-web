import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../../server/lib/http.js';
import {
  absoluteUrl,
  normalizeEpisodeUrl,
  parseXPathSearch,
  prepareApiRequest,
  RuleEngine,
} from '../../server/modules/rules/engine.js';

const rule = {
  name: 'Official compatibility',
  api: '9',
  baseURL: 'https://example.com',
  searchURL: 'https://example.com/search?q=@keyword',
  searchList: '//article',
  searchName: '//a/text()',
  searchResult: '//a',
};

// Expected encodings were checked against the pinned official Dio transformer.
const parameters = {
  tag: ['A', 'B'],
  filter: { x: 1, tags: ['中 /+', "a~!*'()"] },
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
const encoded =
  'tag=A&tag=B&filter%5Bx%5D=1&filter%5Btags%5D=%E4%B8%AD+%2F%2B&filter%5Btags%5D=a~%21%2A%27%28%29&rows%5B0%5D%5Bid%5D=1&rows%5B1%5D%5Bid%5D=2&matrix%5B0%5D=1&matrix%5B0%5D=2&matrix%5B1%5D=3&matrix%5B1%5D&empty&blank=&zero=0&false=false';

test('API queries append duplicate keys and encode nested collections, nulls and empty values like Dio', () => {
  const request = prepareApiRequest(
    { url: 'https://example.com/search?tag=old&tag=older#part', query: parameters },
    {},
  );
  assert.equal(
    request.url,
    `https://example.com/search?tag=old&tag=older&${encoded.replaceAll('%5B', '[').replaceAll('%5D', ']')}#part`,
  );
});

test('API form bodies preserve repeated scalars and indexed nested collections like Dio', () => {
  const request = prepareApiRequest(
    { url: rule.baseURL, method: 'POST', bodyType: 'form', body: parameters },
    {},
  );
  assert.equal(request.body, encoded);
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
});

test('parameter templates preserve collection values and encode nested field names once', () => {
  const request = prepareApiRequest(
    {
      url: rule.baseURL,
      query: { '@key': '@tags', nested: { 'a b': '@keyword' } },
      method: 'POST',
      bodyType: 'form',
      body: { tags: '@tags' },
    },
    { key: 'a b', tags: ['a/b', '中 +'], keyword: 'x%y' },
  );
  assert.equal(request.url, 'https://example.com/?a+b=a%2Fb&a+b=%E4%B8%AD+%2B&nested[a+b]=x%25y');
  assert.equal(request.body, 'tags=a%2Fb&tags=%E4%B8%AD+%2B');
});

test('XPath POST retains the URL query but uses the last duplicate value in its form', async () => {
  let request;
  const engine = new RuleEngine({
    async text(url, options) {
      request = { url, ...options };
      return { text: '<article><a href="/detail">Found</a></article>' };
    },
  });
  await engine.search(
    { ...rule, usePost: true, searchURL: `${rule.searchURL}&tag=first&tag=last&empty` },
    'a b',
  );
  assert.deepEqual(new URL(request.url).searchParams.getAll('tag'), ['first', 'last']);
  assert.equal(request.body, 'q=a+b&tag=last&empty=');
});

test('XPath text() reads complete element text, including elements without direct text nodes', () => {
  assert.deepEqual(
    parseXPathSearch(
      '<article><a href="/one">开<span>中</span>尾</a></article>' +
        '<article><a href="/two"><span>嵌套标题</span></a></article>' +
        '<article><a href="/empty"></a></article>' +
        '<article><a href="/three"> <!-- ignored --> <span>第三个</span></a></article>',
      rule,
    ),
    [
      { name: '开中尾', url: 'https://example.com/one' },
      { name: '嵌套标题', url: 'https://example.com/two' },
      { name: '第三个', url: 'https://example.com/three' },
    ],
  );
  assert.deepEqual(
    parseXPathSearch(
      '<article><a data-path="/text()" href="/one">开<span>中</span>尾</a></article>',
      {
        ...rule,
        searchName: '//a[@data-path="/text()"]/text()',
      },
    ),
    [{ name: '开中尾', url: 'https://example.com/one' }],
  );
});

test('episode identity decodes unreserved escapes, uppercases reserved escapes and stays idempotent', () => {
  for (const [input, expected] of [
    [
      '/play/%61/%7e/%2f/%3f/%23/%25/%E4%b8%AD///?q=%61%7e%2f%20%2b#%61%2f',
      'https://example.com/play/a/~/%2F/%3F/%23/%25/%E4%B8%AD?q=a~%2F%20%2B#a%2F',
    ],
    ['https://example.com:443/play/%41', 'https://example.com/play/A'],
    ['/play/%2e%2e/%61', 'https://example.com/a'],
    ['/play/%zz?x=%zz#%zz', 'https://example.com/play/%25zz?x=%25zz#%25zz'],
    ['http://example.com/play/%61///?', 'https://example.com/play/a'],
    ['http://cdn.example.com/play/%61', 'http://cdn.example.com/play/a'],
    ['http://example.com:8080/play/%61', 'http://example.com:8080/play/a'],
  ]) {
    assert.equal(normalizeEpisodeUrl(input, rule.baseURL), expected);
    assert.equal(normalizeEpisodeUrl(expected, rule.baseURL), expected);
  }
  const signedMedia = 'https://cdn.example.com/%61.mp4?token=%61%2f&x=%25';
  assert.equal(absoluteUrl(signedMedia, rule.baseURL), signedMedia);
  assert.equal(normalizeEpisodeUrl('javascript:alert(1)', rule.baseURL), '');
});

function headerOnlyEngine(status, header = 'challenge', browserResolver) {
  return new RuleEngine(
    {
      async request(url) {
        return {
          url,
          response: new Response('<article><a href="/detail">Found</a></article>', {
            status,
            headers: { 'cf-mitigated': header },
          }),
        };
      },
      async text(url, options) {
        const { response } = await this.request(url, options);
        if (!response.ok) throw new HttpError(`上游返回 HTTP ${response.status}`, 502);
        return { text: await response.text(), url };
      },
    },
    { browserResolver },
  );
}
const protectedRule = {
  ...rule,
  antiCrawlerConfig: {
    enabled: true,
    captchaType: 1,
    captchaDetectType: 2,
    captchaDetectValue: 'not in the response',
  },
};

test('a failed XPath search recognizes the Cloudflare challenge header without body markers or a callback', async () => {
  for (const status of [403, 429, 503])
    await assert.rejects(headerOnlyEngine(status, 'ChAlLeNgE').search(protectedRule, 'test'), {
      code: 'VERIFICATION_REQUIRED',
    });
});

test('a header-only challenge enters the existing browser verification flow with the original POST', async () => {
  const onVerification = () => {};
  let calls = 0;
  const engine = headerOnlyEngine(403, 'challenge', {
    async read(receivedRule, request, options) {
      calls++;
      assert.equal(receivedRule, protectedPostRule);
      assert.equal(request.method, 'POST');
      assert.equal(request.body, 'q=a+b');
      assert.equal(options.onVerification, onVerification);
      assert.equal(options.detectChallengeHeaders, true);
      return [{ name: 'Verified', url: 'https://example.com/detail' }];
    },
  });
  const protectedPostRule = { ...protectedRule, usePost: true };
  assert.deepEqual(await engine.search(protectedPostRule, 'a b', { onVerification }), [
    { name: 'Verified', url: 'https://example.com/detail' },
  ]);
  assert.equal(calls, 1);
});

test('Cloudflare header detection retains the official XPath-search, enabled-rule and failed-response boundaries', async () => {
  assert.equal((await headerOnlyEngine(200).search(protectedRule, 'test'))[0].name, 'Found');
  for (const candidate of [
    rule,
    { ...protectedRule, antiCrawlerConfig: { ...protectedRule.antiCrawlerConfig, enabled: false } },
    { ...protectedRule, searchMode: 'api', searchApiConfig: { request: { url: rule.searchURL } } },
  ]) {
    await assert.rejects(headerOnlyEngine(403).search(candidate, 'test'), {
      code: 'SOURCE_HTTP_ERROR',
    });
  }
  await assert.rejects(headerOnlyEngine(403, 'other').search(protectedRule, 'test'), {
    code: 'SOURCE_HTTP_ERROR',
  });
  await assert.rejects(headerOnlyEngine(403).chapters(protectedRule, '/detail'), {
    code: 'SOURCE_HTTP_ERROR',
  });
});
