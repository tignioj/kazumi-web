import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHttpClient } from '../../server/lib/http.js';
import { RuleEngine, ruleHeaders } from '../../server/modules/rules/engine.js';
import { BrowserResolver } from '../../server/modules/playback/browser-resolver.js';
import { LocalSourceResolver } from '../../server/modules/playback/source-resolver.js';
import { RuleSessionStore } from '../../server/modules/verification/session-store.js';

const baseRule = {
  name: 'Request header fixture',
  api: '9',
  baseURL: 'https://source.example',
  searchURL: 'https://source.example/search?wd=@keyword',
  searchList: '//article',
  searchName: '//a',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
  userAgent: 'Playback-only UA',
  referer: 'https://player.example/watch',
};

const responses = {
  xpath: {
    search: '<article><a href="/detail">Found</a></article>',
    chapters: '<ul><a href="/episode.mp4">Episode 1</a></ul>',
  },
  api: {
    search: JSON.stringify({ data: [{ name: 'Found', url: '/detail' }] }),
    chapters: JSON.stringify({
      data: { roads: [{ name: 'Main', episodes: [{ name: 'Episode 1', url: '/episode.mp4' }] }] },
    }),
  },
};

function apiRule(headers = {}) {
  return {
    ...baseRule,
    searchMode: 'api',
    chapterMode: 'api',
    searchApiConfig: {
      request: { url: 'https://source.example/search?q=@keyword', headers },
    },
    chapterApiConfig: {
      request: { url: 'https://source.example/detail?id=@source', headers },
    },
  };
}

function recordHttp(body) {
  const calls = [];
  return {
    calls,
    async text(url, options) {
      calls.push({ url, ...options });
      return { text: body };
    },
  };
}

function run(engine, stage, rule, options) {
  return stage === 'search'
    ? engine.search(rule, 'Found', options)
    : engine.chapters(rule, '/detail', options);
}

for (const stage of ['search', 'chapters']) {
  for (const suffix of ['', '/']) {
    test(`XPath ${stage} excludes playback headers and preserves baseURL ${suffix ? 'with' : 'without'} trailing slash`, async () => {
      const rule = { ...baseRule, baseURL: `${baseRule.baseURL}${suffix}` };
      const http = recordHttp(responses.xpath[stage]);
      const result = await run(new RuleEngine(http), stage, rule);
      assert.equal(result.length, 1);
      // Kazumi's executor appends '/' literally; it does not trim an existing slash.
      assert.deepEqual(http.calls[0].headers, { referer: `${rule.baseURL}/` });
    });
  }

  test(`API ${stage} without request headers uses the scraping defaults`, async () => {
    const rule = apiRule();
    const http = recordHttp(responses.api[stage]);
    assert.equal((await run(new RuleEngine(http), stage, rule)).length, 1);
    assert.deepEqual(http.calls[0].headers, { referer: `${rule.baseURL}/` });
  });

  test(`API ${stage} request headers override defaults case-insensitively`, async () => {
    const configured = {
      ReFeReR: 'https://api.example/catalog',
      'UsEr-AgEnT': 'API request UA',
      'X-Source': 'fixture',
    };
    const rule = apiRule(configured);
    const http = recordHttp(responses.api[stage]);
    assert.equal((await run(new RuleEngine(http), stage, rule)).length, 1);
    assert.deepEqual(http.calls[0].headers, {
      referer: 'https://api.example/catalog',
      'user-agent': 'API request UA',
      'x-source': 'fixture',
    });
    assert.equal(configured.ReFeReR, 'https://api.example/catalog');
    assert.equal(configured['user-agent'], undefined);
  });

  test(`API ${stage} uses the clearance-bound UA only for the matching owner and cookie domain`, async (t) => {
    const rule = apiRule({ 'User-Agent': 'API request UA' });
    const sessions = new RuleSessionStore();
    t.after(() => sessions.close());
    sessions.set(
      rule,
      'alice',
      {
        cookies: [
          {
            name: 'clearance',
            value: 'verified',
            domain: 'source.example',
            path: '/',
            secure: true,
            expires: -1,
          },
        ],
        origins: [],
      },
      'Verified browser UA',
    );
    const http = recordHttp(responses.api[stage]);
    const engine = new RuleEngine(http, {
      browserResolver: { requestOptions: (...args) => sessions.requestOptions(...args) },
    });
    await run(engine, stage, rule, { sessionOwner: 'alice' });
    assert.deepEqual(http.calls[0].headers, {
      referer: `${rule.baseURL}/`,
      'user-agent': 'Verified browser UA',
      cookie: 'clearance=verified',
    });
    assert.equal(
      http.calls[0].headersForUrl('https://cdn.example/media')['user-agent'],
      'API request UA',
    );
    assert.equal(http.calls[0].headersForUrl('https://cdn.example/media').cookie, undefined);
    await run(engine, stage, rule, { sessionOwner: 'bob' });
    assert.deepEqual(http.calls[1].headers, {
      referer: `${rule.baseURL}/`,
      'user-agent': 'API request UA',
    });
  });

  for (const mode of ['xpath', 'api']) {
    test(`${mode} ${stage} forwards scraping headers when a challenge falls back to the browser`, async () => {
      const rule = {
        ...(mode === 'api' ? apiRule({ 'User-Agent': 'API request UA' }) : baseRule),
        antiCrawlerConfig: {
          enabled: true,
          captchaDetectType: 2,
          captchaDetectValue: 'Please verify',
        },
      };
      const http = recordHttp('<p>Please verify</p>');
      const reads = [];
      const engine = new RuleEngine(http, {
        browserResolver: {
          async read(receivedRule, request, options) {
            reads.push({ rule: receivedRule, request, options });
            return options.parse(responses[mode][stage]);
          },
        },
      });
      const result = await run(engine, stage, rule, {
        sessionOwner: 'alice',
        onVerification: async () => {},
      });
      assert.equal(result.length, 1);
      assert.equal(reads.length, 1);
      assert.deepEqual(reads[0].request.headers, {
        referer: `${rule.baseURL}/`,
        ...(mode === 'api' ? { 'user-agent': 'API request UA' } : {}),
      });
      assert.equal(reads[0].options.sessionOwner, 'alice');
      assert.equal(reads[0].options.responseType, mode === 'api' ? 'json' : 'html');
      assert.equal(reads[0].rule.userAgent, 'Playback-only UA');
    });
  }
}

test('XPath POST retains form encoding without inheriting playback headers', async () => {
  const rule = { ...baseRule, usePost: true };
  const http = recordHttp(responses.xpath.search);
  await new RuleEngine(http).search(rule, 'A B');
  assert.equal(http.calls[0].method, 'POST');
  assert.equal(http.calls[0].body, 'wd=A+B');
  assert.deepEqual(http.calls[0].headers, {
    referer: `${rule.baseURL}/`,
    'content-type': 'application/x-www-form-urlencoded',
  });
});

test('static playback still uses top-level UA and Referer for its page and resolved media', async () => {
  const calls = [];
  const resolver = new LocalSourceResolver({
    async request(url, options) {
      calls.push({ url, ...options });
      return {
        url,
        response: new Response('<video src="https://media.example/video.mp4"></video>', {
          headers: { 'content-type': 'text/html' },
        }),
      };
    },
  });
  const result = await resolver.resolve(baseRule, '/watch');
  const expected = { 'user-agent': 'Playback-only UA', referer: 'https://player.example/watch' };
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].headers, expected);
  assert.equal(result.url, 'https://media.example/video.mp4');
  assert.deepEqual(result.headers, expected);
  assert.deepEqual(ruleHeaders(baseRule), expected);
});

test('real browser reads isolate playback headers, honor API headers and retain the verified UA', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'text/html' }).end('<main>Ready</main>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = createHttpClient({ allowPrivate: true, timeout: 5000 });
  const resolver = new BrowserResolver(client, { timeout: 10000, settleTime: 50 });
  t.after(async () => {
    await resolver.close();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const rule = { ...baseRule, baseURL: origin };
  const read = async (path, headers, owner) => {
    assert.equal(
      await resolver.read(
        rule,
        { url: `${origin}${path}`, headers },
        { sessionOwner: owner, parse: (raw) => raw.includes('<main>Ready</main>') },
      ),
      true,
    );
    const received = requests.find((entry) => entry.path === path);
    assert.ok(received, `browser requested ${path}`);
    // rememberContext stores navigator.userAgent, so both the network and actual
    // browser context must agree; changing only outgoing headers is insufficient.
    assert.equal(resolver.ruleSessions.get(rule, owner).userAgent, received.headers['user-agent']);
    return received.headers;
  };

  const xpath = await read('/xpath', { referer: `${origin}/` }, 'xpath-owner');
  assert.notEqual(xpath['user-agent'], baseRule.userAgent);
  assert.match(xpath['user-agent'], /Mozilla\//);
  assert.equal(xpath.referer, `${origin}/`);

  const apiHeaders = { 'User-Agent': 'API browser UA', Referer: `${origin}/api-catalog` };
  const api = await read('/api', apiHeaders, 'api-owner');
  assert.equal(api['user-agent'], 'API browser UA');
  assert.equal(api.referer, `${origin}/api-catalog`);

  resolver.ruleSessions.set(
    rule,
    'verified-owner',
    {
      cookies: [
        {
          name: 'clearance',
          value: 'verified',
          domain: '127.0.0.1',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'Lax',
          expires: -1,
        },
      ],
      origins: [],
    },
    'Verified browser UA',
  );
  const verified = await read('/verified', apiHeaders, 'verified-owner');
  assert.equal(verified['user-agent'], 'Verified browser UA');
  assert.equal(verified.referer, `${origin}/api-catalog`);
  assert.match(verified.cookie, /clearance=verified/);
  assert.equal(resolver.browser.contexts().length, 0);
});
