import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp } from '../../server/app.js';
import { registerRuleTestRoute } from '../../server/modules/rules/test-route.js';
import { createInteractive } from '../../server/modules/verification/interactive.js';
import { VerificationTasks } from '../../server/modules/verification/tasks.js';
import { registerVerificationRoutes } from '../../server/modules/verification/routes.js';
import { handleError } from '../../server/middleware/errors.js';
import { createResolutionLogger } from '../../server/modules/playback/diagnostics.js';
import { normalizeRule } from '../../server/modules/rules/validation.js';

const baseRule = {
  name: 'Draft',
  api: '9',
  version: '1.0',
  baseURL: 'https://example.com',
  searchURL: 'https://example.com/search?wd=@keyword',
  searchList: '//article',
  searchName: '//a',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
};
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const post = (base, body, headers = {}, signal) =>
  fetch(`${base}/api/rules/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });

for (const mode of ['xpath', 'api']) {
  test(`unsaved ${mode} drafts search, parse every road and resolve proxied media without saving`, async (t) => {
    const requests = [];
    const upstream = createServer((req, res) => {
      const url = new URL(req.url, 'https://fixture.invalid');
      requests.push({ url, headers: req.headers });
      const roads = [
        {
          name: '线路一',
          episodes: [
            { name: '第1集', url: '/watch/1' },
            { name: '第2集', url: '/watch/2' },
          ],
        },
        { name: '线路二', episodes: [{ name: '备用集', url: '/watch/3' }] },
      ];
      if (url.pathname === '/search') {
        res.setHeader('content-type', 'text/html');
        res.end('<article><a href="/detail/1">草稿结果</a></article>');
      } else if (url.pathname === '/detail/1') {
        res.end(
          roads
            .map(
              (road) =>
                `<ul>${road.episodes.map((episode) => `<li><a href="${episode.url}">${episode.name}</a></li>`).join('')}</ul>`,
            )
            .join(''),
        );
      } else if (url.pathname === '/api/search') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ name: '草稿结果', id: 'opaque-id' }] }));
      } else if (url.pathname === '/api/detail') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { roads } }));
      } else if (url.pathname.startsWith('/watch/')) {
        res.end('<script>var player_aaaa={"url":"/movie.mp4"}</script>');
      } else if (url.pathname === '/movie.mp4') {
        res.setHeader('content-type', 'video/mp4');
        res.end('draft-media');
      } else res.writeHead(404).end();
    });
    const origin = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), 'kazumi-rule-test-'));
    const application = await createApp({
      dataDir: directory,
      seedRules: [{ ...baseRule, version: 'installed' }],
      browserResolver: false,
      httpOptions: { allowPrivate: true },
    });
    const server = createServer(application.app);
    const base = await listen(server);
    t.after(async () => {
      await application.close();
      await close(server);
      await close(upstream);
      await rm(directory, { recursive: true, force: true });
    });
    const before = await readFile(join(directory, 'rules.json'), 'utf8');
    const draft = {
      ...baseRule,
      version: 'unsaved',
      baseURL: origin,
      userAgent: 'Draft UA',
      referer: `${origin}/player-context`,
      searchURL: `${origin}/search?wd=@keyword`,
      enabled: false,
      ...(mode === 'api' && {
        searchMode: 'api',
        chapterMode: 'api',
        searchApiConfig: {
          request: { url: `${origin}/api/search?q=@keyword`, headers: { 'X-Draft': 'yes' } },
          sourcePath: '$.id',
        },
        chapterApiConfig: { request: { url: `${origin}/api/detail?id=@source` } },
      }),
    };
    const run = async (stage, args, rule = draft) => {
      const response = await post(base, { rule, stage, ...args });
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(response.headers.get('cache-control'), /no-store/);
      const result = await response.json();
      assert.equal(result.stage, stage);
      assert.ok(result.elapsedMs >= 0);
      return result;
    };
    const search = await run('search', { keyword: '草稿' });
    assert.equal(search.items[0].name, '草稿结果');
    assert.equal(requests[0].url.searchParams.get(mode === 'api' ? 'q' : 'wd'), '草稿');
    if (mode === 'api') assert.equal(requests[0].headers['x-draft'], 'yes');
    assert.notEqual(requests[0].headers['user-agent'], draft.userAgent);
    assert.equal(requests[0].headers.referer, `${origin}/`);
    const chapters = await run('chapters', { url: search.items[0].url });
    assert.deepEqual(
      chapters.roads.map((road) => road.episodes.length),
      [2, 1],
    );
    if (mode === 'api') assert.equal(requests[1].url.searchParams.get('id'), 'opaque-id');
    assert.notEqual(requests[1].headers['user-agent'], draft.userAgent);
    assert.equal(requests[1].headers.referer, `${origin}/`);
    const playback = await run('resolve', { url: chapters.roads[1].episodes[0].url });
    assert.equal(playback.source.type, 'video');
    assert.match(playback.source.url, /^\/api\/media\?/);
    assert.equal(await (await fetch(`${base}${playback.source.url}`)).text(), 'draft-media');
    const playbackRequests = requests.slice(2);
    assert.ok(playbackRequests.length >= 2);
    for (const { headers } of playbackRequests) {
      assert.equal(headers['user-agent'], draft.userAgent);
      assert.equal(headers.referer, draft.referer);
    }
    await run('search', { keyword: 'new rule' }, { ...draft, name: 'Not installed' });
    assert.equal(await readFile(join(directory, 'rules.json'), 'utf8'), before);
    assert.equal(application.store.get('Draft').version, 'installed');
    assert.deepEqual((await (await fetch(`${base}/api/watch-data`)).json()).history, []);
    assert.deepEqual((await (await fetch(`${base}/api/downloads`)).json()).items, []);
    const count = requests.length;
    for (const body of [
      { stage: 'invalid', rule: draft },
      { stage: 'search', rule: { ...draft, api: '99' }, keyword: 'x' },
      { stage: 'search', rule: [draft], keyword: 'x' },
      { stage: 'search', rule: draft, keyword: '' },
      { stage: 'chapters', rule: draft, url: '' },
    ])
      assert.equal((await post(base, body)).status, 400);
    assert.equal(requests.length, count, 'invalid drafts must fail before source requests');
    assert.equal(await readFile(join(directory, 'rules.json'), 'utf8'), before);
  });
}

async function fixture(t, { engine = {}, media = {}, timeoutMs = 3000 } = {}) {
  const app = express();
  const verification = new VerificationTasks({ timeoutMs });
  app.use(express.json());
  registerVerificationRoutes(app, { verification });
  registerRuleTestRoute(app, { engine, media, interactive: createInteractive(verification) });
  app.use(handleError);
  const server = createServer(app);
  const base = await listen(server);
  t.after(async () => {
    verification.close();
    await close(server);
  });
  return { base, verification };
}

test('draft testing preserves engine errors and empty search results, and rejects empty chapters', async (t) => {
  const f = await fixture(t, {
    engine: { search: async () => [], chapters: async () => [{ name: 'Empty', episodes: [] }] },
    media: {
      resolve: async () => {
        throw new Error('resolver failed');
      },
    },
  });
  assert.deepEqual(
    (await (await post(f.base, { rule: baseRule, stage: 'search', keyword: 'x' })).json()).items,
    [],
  );
  const chapters = await post(f.base, { rule: baseRule, stage: 'chapters', url: 'opaque' });
  assert.equal(chapters.status, 422);
  assert.match((await chapters.json()).error, /未解析到可播放剧集/);
  const failed = await post(f.base, { rule: baseRule, stage: 'resolve', url: '/watch' });
  assert.equal(failed.status, 500);
});

test('each draft test validates its own stage while saving still requires a complete rule', async (t) => {
  const f = await fixture(t, {
    engine: {
      async search(rule) {
        assert.equal(rule.chapterResult, '');
        return [];
      },
      async chapters(rule) {
        assert.equal(rule.searchURL, '');
        return [{ name: 'One', episodes: [{ name: 'One', url: '/one' }] }];
      },
    },
    media: {
      async resolve(rule) {
        assert.equal(rule.searchURL, '');
        assert.equal(rule.chapterResult, '');
        return { type: 'video', url: '/api/media?draft' };
      },
    },
  });
  for (const stage of ['search', 'chapters', 'resolve']) {
    const rule = {
      ...baseRule,
      ...(stage !== 'search' && { searchURL: '', searchApiConfig: { request: null } }),
      ...(stage !== 'chapters' && { chapterResult: '', chapterApiConfig: { request: null } }),
    };
    assert.throws(() => normalizeRule(rule));
    const response = await post(f.base, { rule, stage, keyword: 'x', url: '/one' });
    assert.equal(response.status, 200, await response.clone().text());
  }
});

test('playback testing streams sanitized resolver diagnostics and returns the draft media result', async (t) => {
  const f = await fixture(t, {
    media: {
      async resolve(rule, url, options) {
        assert.equal(rule.version, 'draft');
        assert.ok(options.sessionOwner);
        createResolutionLogger(options)('解析', '读取 https://source.example/watch?token=private');
        return { type: 'hls', url: '/api/media?session', nativePlayback: true };
      },
    },
  });
  const response = await post(
    f.base,
    { rule: { ...baseRule, version: 'draft' }, stage: 'resolve', url: '/watch' },
    { accept: 'application/x-ndjson' },
  );
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events[0].type, 'diagnostic');
  assert.doesNotMatch(events[0].diagnostic.message, /private/);
  assert.equal(events.at(-1).type, 'complete');
  assert.deepEqual(events.at(-1).result.source, {
    type: 'hls',
    url: '/api/media?session',
    nativePlayback: true,
  });
});

test('stopping a streamed draft test aborts engine work and releases the verification task', async (t) => {
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const f = await fixture(t, {
    engine: {
      search(rule, keyword, { signal, onDiagnostic }) {
        started.resolve();
        onDiagnostic({ scope: 'search', message: 'started' });
        return new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    },
  });
  const controller = new AbortController();
  const pending = post(
    f.base,
    { rule: baseRule, stage: 'search', keyword: 'x' },
    { accept: 'application/x-ndjson' },
    controller.signal,
  );
  await started.promise;
  const response = await pending;
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await aborted.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.verification.tasks.size, 0);
});

test('draft testing reuses a visitor verification session and continues after a challenge', async (t) => {
  const f = await fixture(t, {
    engine: {
      async search(rule, keyword, options) {
        assert.ok(options.sessionOwner);
        await options.onVerification({
          ruleName: rule.name,
          originalUrl: 'https://example.com/challenge',
        });
        return [{ name: keyword, url: 'opaque' }];
      },
    },
  });
  const session = await fetch(`${f.base}/api/verification-session`);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await post(
    f.base,
    { rule: baseRule, stage: 'search', keyword: 'resumed' },
    { cookie },
  );
  assert.equal(response.status, 202);
  const challenge = await response.json();
  const task = [...f.verification.tasks.values()][0];
  assert.ok(cookie.endsWith(task.owner));
  assert.equal(task.id, challenge.verificationId);
  const [waiting] = task.challenges.splice(0);
  waiting.resolve();
  await task.done;
  const result = await (
    await fetch(`${f.base}/api/verification/${task.id}`, { headers: { cookie } })
  ).json();
  assert.equal(result.status, 'completed');
  assert.equal(result.result.items[0].name, 'resumed');
  assert.equal((await fetch(`${f.base}/api/verification/${task.id}`)).status, 404);
});

test('draft test requests keep the normal private-network restrictions for every stage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-rule-test-private-'));
  const application = await createApp({
    dataDir: directory,
    seedRules: [],
    browserResolver: false,
    httpOptions: { allowPrivate: false },
  });
  const server = createServer(application.app);
  const base = await listen(server);
  t.after(async () => {
    await application.close();
    await close(server);
    await rm(directory, { recursive: true, force: true });
  });
  const rule = {
    ...baseRule,
    baseURL: 'http://127.0.0.1:9',
    searchURL: 'http://127.0.0.1:9/search?wd=@keyword',
  };
  for (const stage of ['search', 'chapters', 'resolve']) {
    const response = await post(base, {
      rule,
      stage,
      keyword: 'x',
      url: 'http://127.0.0.1:9/page',
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /私有网络/);
  }
});
