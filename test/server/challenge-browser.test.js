import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { BrowserResolver } from '../../server/modules/playback/browser-resolver.js';
import { RuleEngine } from '../../server/modules/rules/engine.js';
import { hasChallenge } from '../../server/modules/verification/challenge.js';
import { createHttpClient } from '../../server/lib/http.js';

const installed = await chromium.launch({ headless: true }).then(
  async (browser) => {
    await browser.close();
    return true;
  },
  () => false,
);
const browserTest = (name, run) =>
  test(name, { skip: !installed && 'Chromium is not installed' }, run);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom'),
  Buffer.alloc(4084),
]);
const captchaConfig = {
  enabled: true,
  captchaDetectType: 2,
  captchaDetectValue: '请输入验证码',
  captchaImage: '//img[@id="captcha"]',
  captchaInput: '//input[@name="captcha"]',
  captchaButton: '//button[@type="submit"]',
};
const challenge = (target = '/results') =>
  `<p>请输入验证码</p><form method="POST" action="/verify?target=${encodeURIComponent(target)}"><img id="captcha" src="/captcha.svg"><input name="captcha"><button type="submit">验证</button></form>`;
const html = (response, body, status = 200) =>
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);

async function fixture(t, handler, options = {}) {
  const server = http.createServer((request, response) => void handler(request, response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const client = createHttpClient({ allowPrivate: true, timeout: 4000 });
  const resolver = new BrowserResolver(client, { timeout: 2000, settleTime: 100, ...options });
  t.after(async () => {
    await resolver.close();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    baseURL,
    client,
    resolver,
    engine: new RuleEngine(client, { browserResolver: resolver }),
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

async function captchaRoutes(request, response) {
  if (request.url === '/captcha.svg') {
    if (!request.headers.cookie?.includes('challenge=abc')) return response.writeHead(403).end();
    return response
      .writeHead(200, { 'content-type': 'image/svg+xml' })
      .end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="25">2468</text></svg>',
      );
  }
  if (request.url.startsWith('/verify?')) {
    const target = new URL(request.url, 'http://fixture').searchParams.get('target');
    if (
      request.headers.cookie?.includes('challenge=abc') &&
      new URLSearchParams(await body(request)).get('captcha') === '2468'
    ) {
      response.setHeader('set-cookie', 'verified=1; Path=/; HttpOnly');
      return response.writeHead(303, { location: target }).end();
    }
    return html(response, `${challenge(target)}<p>验证码错误</p>`);
  }
  return false;
}

test('challenge detection uses fixed markers and ignores rule regex and script text', () => {
  assert.equal(hasChallenge('<script>"请输入验证码"</script><p>Results</p>', {}), false);
  assert.equal(hasChallenge('<p>Plain upstream error</p>', {}), false);
  assert.equal(hasChallenge('<div id="challenge-stage">Checking</div>', {}), true);
  assert.equal(
    hasChallenge('<p>Results</p>', {
      antiCrawlerConfig: { enabled: true, captchaDetectType: 'regex', captchaDetectValue: '.*' },
    }),
    false,
  );
  assert.equal(
    hasChallenge('<p>Results</p>', {
      antiCrawlerConfig: { enabled: true, captchaDetectValue: '//*[(' },
    }),
    false,
  );
});

browserTest(
  'search keeps POST body, captcha image and cookies, pauses timeout and retries an incorrect answer',
  async (t) => {
    const posts = [];
    let imageRequests = 0;
    const { baseURL, resolver, engine } = await fixture(t, async (request, response) => {
      if (request.url === '/search') {
        posts.push({ method: request.method, body: await body(request) });
        response.setHeader('set-cookie', 'challenge=abc; Path=/; HttpOnly');
        return html(response, challenge(), 403);
      }
      if (request.url === '/captcha.svg') imageRequests++;
      if ((await captchaRoutes(request, response)) !== false) return;
      if (request.url === '/results' && request.headers.cookie?.includes('verified=1'))
        return html(response, '<article><a href="/show">Found</a></article>');
      response.writeHead(404).end();
    });
    let rounds = 0;
    const result = await engine.search(
      {
        name: 'Fixture',
        baseURL,
        searchURL: `${baseURL}/search?q=@keyword`,
        usePost: true,
        searchList: '//article',
        searchName: '//a',
        searchResult: '//a',
        antiCrawlerConfig: captchaConfig,
      },
      '中文 &',
      {
        async onVerification({ page, captcha, ruleName, originalUrl }) {
          rounds++;
          assert.equal(ruleName, 'Fixture');
          assert.equal(originalUrl, `${baseURL}/search`);
          assert.deepEqual(captcha, {
            image: captchaConfig.captchaImage,
            input: captchaConfig.captchaInput,
            submit: captchaConfig.captchaButton,
          });
          await page
            .locator('img')
            .evaluate(
              (image) =>
                image.complete ||
                new Promise((resolve) => image.addEventListener('load', resolve, { once: true })),
            );
          assert.equal(await page.locator('img').evaluate((image) => image.naturalWidth), 120);
          if (rounds === 1) await new Promise((resolve) => setTimeout(resolve, 2100));
          await page.locator('input').fill(rounds === 1 ? 'wrong' : '2468');
          await page.locator('button').click();
        },
      },
    );
    assert.deepEqual(result, [{ name: 'Found', url: `${baseURL}/show` }]);
    assert.equal(rounds, 2);
    assert.equal(posts.length, 2, 'one HTTP attempt and one same-method browser navigation');
    assert.ok(
      posts.every(
        (post) => post.method === 'POST' && new URLSearchParams(post.body).get('q') === '中文 &',
      ),
    );
    assert.ok(imageRequests >= 1);
    assert.equal(resolver.browser.contexts().length, 0);
    assert.equal(resolver.active.size, 0);
  },
);

browserTest(
  'playback resumes in the verified context and retains its HttpOnly media cookies',
  async (t) => {
    const { baseURL, resolver } = await fixture(t, async (request, response) => {
      if (request.url === '/watch') {
        if (request.headers.cookie?.includes('verified=1'))
          return html(response, '<video src="/movie.mp4"></video>');
        response.setHeader('set-cookie', 'challenge=abc; Path=/; HttpOnly');
        return html(response, challenge('/watch'));
      }
      if (request.url === '/movie.mp4') {
        if (!request.headers.cookie?.includes('verified=1')) return response.writeHead(403).end();
        return response.writeHead(206, { 'content-type': 'video/mp4' }).end(mp4);
      }
      if ((await captchaRoutes(request, response)) !== false) return;
      response.writeHead(404).end();
    });
    let rounds = 0;
    const result = await resolver.resolve(
      { name: 'Fixture', baseURL, antiCrawlerConfig: captchaConfig },
      `${baseURL}/watch`,
      {
        async onVerification({ page }) {
          rounds++;
          await page.locator('input').fill('2468');
          await page.locator('button').click();
        },
      },
    );
    assert.equal(rounds, 1);
    assert.equal(result.url, `${baseURL}/movie.mp4`);
    assert.ok(result.cookies.some((cookie) => cookie.name === 'verified' && cookie.httpOnly));
    assert.equal(resolver.browser.contexts().length, 0);
  },
);

browserTest(
  'cancelling a human verification wait releases its browser slot immediately',
  async (t) => {
    const { baseURL, resolver } = await fixture(
      t,
      (_request, response) => html(response, '<p>请输入验证码</p>'),
      { maxConcurrency: 1 },
    );
    const controller = new AbortController();
    let opened;
    const waiting = new Promise((resolve) => {
      opened = resolve;
    });
    const pending = resolver.read(
      { baseURL },
      { url: baseURL },
      {
        signal: controller.signal,
        onVerification() {
          opened();
          return new Promise(() => {});
        },
      },
    );
    const rejected = assert.rejects(pending, { status: 499 });
    await waiting;
    await assert.rejects(resolver.read({ baseURL }, { url: baseURL }), { status: 503 });
    controller.abort();
    await rejected;
    assert.equal(resolver.active.size, 0);
    assert.equal(resolver.browser.contexts().length, 0);
  },
);

browserTest('an unknown player gets only one manual opportunity before timing out', async (t) => {
  const { baseURL, resolver } = await fixture(
    t,
    (_request, response) => html(response, '<p>Waiting for a player</p>'),
    { timeout: 600 },
  );
  let rounds = 0;
  await assert.rejects(
    resolver.resolve({ baseURL }, baseURL, {
      async onVerification() {
        rounds++;
      },
    }),
    { status: 504 },
  );
  assert.equal(rounds, 1);
  assert.equal(resolver.active.size, 0);
});

test('verification browser reads retain private-address protection before starting Chromium', async () => {
  const resolver = new BrowserResolver(
    { allowPrivate: false },
    {
      egressFactory() {
        assert.fail('must not start');
      },
    },
  );
  await assert.rejects(
    resolver.read(
      { baseURL: 'http://127.0.0.1' },
      { url: 'http://127.0.0.1' },
      { onVerification() {} },
    ),
    { status: 403 },
  );
  for (const name of ['Authorization', 'Cookie', 'proxy-authorization']) {
    await assert.rejects(
      resolver.read(
        { baseURL: 'https://example.com' },
        { url: 'https://example.com', headers: { [name]: 'sensitive' } },
        { onVerification() {} },
      ),
      { status: 422, message: /认证信息/ },
    );
  }
});

browserTest(
  'API challenge waits for delayed AJAX and replays the original JSON POST after landing',
  async (t) => {
    const requests = [];
    const { baseURL, engine, resolver } = await fixture(t, async (request, response) => {
      if (request.url === '/api/search') {
        requests.push({
          method: request.method,
          body: await body(request),
          header: request.headers['x-fixture'],
        });
        if (request.headers.cookie?.includes('verified=1'))
          return response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ data: [{ name: 'API result', url: 'opaque-source' }] }));
        return html(
          response,
          "<p>请输入验证码</p><button onclick=\"fetch('/grant', {method: 'POST'}).then(() => location.href = '/landing')\">Complete</button>",
          403,
        );
      }
      if (request.url === '/grant') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        response.setHeader('set-cookie', 'verified=1; Path=/; HttpOnly');
        return response.writeHead(200).end('ok');
      }
      if (request.url === '/landing') return html(response, '<p>Verification completed</p>');
      response.writeHead(404).end();
    });
    let rounds = 0;
    const result = await engine.search(
      {
        name: 'API fixture',
        baseURL,
        searchMode: 'api',
        searchApiConfig: {
          request: {
            url: `${baseURL}/api/search`,
            method: 'POST',
            bodyType: 'json',
            body: { keyword: '@keyword' },
            headers: { 'x-fixture': 'original' },
          },
        },
      },
      '猫',
      {
        async onVerification({ page, reason }) {
          rounds++;
          assert.equal(reason, 'challenge');
          await page.locator('button').click();
        },
      },
    );
    assert.deepEqual(result, [{ name: 'API result', url: 'opaque-source' }]);
    assert.equal(rounds, 1, 'pending AJAX does not cause a premature retry');
    assert.equal(
      requests.length,
      3,
      'HTTP request, browser challenge request and verified browser replay',
    );
    assert.ok(
      requests.every(
        (request) =>
          request.method === 'POST' &&
          request.header === 'original' &&
          JSON.parse(request.body).keyword === '猫',
      ),
    );
    assert.equal(resolver.browser.contexts().length, 0);
  },
);

browserTest(
  'chapter verification replays the source after a successful landing page',
  async (t) => {
    let sourceRequests = 0;
    const { baseURL, engine } = await fixture(t, async (request, response) => {
      if (request.url === '/chapters') {
        sourceRequests++;
        if (request.headers.cookie?.includes('verified=1'))
          return html(response, '<ul><li><a href="/watch">Episode 1</a></li></ul>');
        response.setHeader('set-cookie', 'challenge=abc; Path=/; HttpOnly');
        return html(response, challenge('/landing'));
      }
      if (request.url === '/landing') return html(response, '<p>Verified</p>');
      if ((await captchaRoutes(request, response)) !== false) return;
      response.writeHead(404).end();
    });
    const result = await engine.chapters(
      { baseURL, chapterRoads: '//ul', chapterResult: '//li/a', antiCrawlerConfig: captchaConfig },
      '/chapters',
      {
        async onVerification({ page }) {
          await page.locator('input').fill('2468');
          await page.locator('button').click();
        },
      },
    );
    assert.deepEqual(result, [
      { name: '播放线路1', episodes: [{ name: 'Episode1', url: `${baseURL}/watch` }] },
    ]);
    assert.equal(sourceRequests, 3);
  },
);
