import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleSessionStore } from '../../server/modules/verification/session-store.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../server/app.js';
import { createHttpClient } from '../../server/lib/http.js';
import {
  headersForSession,
  MediaSessionStore,
} from '../../server/modules/playback/session-store.js';

const rule = { name: 'Fixture', baseURL: 'https://source.example', version: '1' };
const state = {
  cookies: [
    {
      name: 'clearance',
      value: 'private',
      domain: 'source.example',
      path: '/verified',
      secure: true,
      expires: -1,
    },
  ],
  origins: [],
};

test('rule clearance is scoped to owner, rule configuration, cookie path and redirect host', () => {
  const sessions = new RuleSessionStore();
  sessions.set(rule, 'alice', state, 'Verified UA');
  const input = { 'User-Agent': 'Rule UA', Authorization: 'Bearer own' };
  const options = sessions.requestOptions(
    rule,
    'https://source.example/verified/search',
    input,
    'alice',
  );
  assert.equal(options.headers.cookie, 'clearance=private');
  assert.equal(options.headers['user-agent'], 'Verified UA');
  const otherPath = options.headersForUrl('https://source.example/public');
  assert.equal(otherPath.cookie, undefined);
  assert.equal(otherPath['user-agent'], 'Rule UA');
  const otherHost = options.headersForUrl('https://elsewhere.example/verified/search');
  assert.equal(otherHost.cookie, undefined);
  assert.equal(otherHost.authorization, undefined);
  for (const [config, owner] of [
    [rule, 'bob'],
    [{ ...rule, version: '2' }, 'alice'],
    [{ ...rule, name: 'Other rule' }, 'alice'],
  ])
    assert.equal(
      sessions.requestOptions(config, 'https://source.example/verified/search', input, owner)
        .headers.cookie,
      undefined,
    );
  const restored = sessions.mediaSession(
    rule,
    'https://source.example/main.m3u8',
    { referer: 'https://player.example/', authorization: 'Bearer own' },
    'alice',
  );
  const mediaSessions = new MediaSessionStore();
  const media = mediaSessions.create(restored);
  const cdn = headersForSession(media, 'https://cdn.example/segment.ts');
  assert.equal(cdn.referer, 'https://player.example/');
  assert.equal(cdn.authorization, undefined);
  assert.equal(cdn.cookie, undefined);
  mediaSessions.close();
});

test('rule sessions expire, evict old entries, copy snapshots and clear on shutdown', () => {
  let now = 0;
  const sessions = new RuleSessionStore({ maxSessions: 2, ttlMs: 1000, now: () => now });
  const snapshot = structuredClone(state);
  sessions.set(rule, 'alice', snapshot, 'UA');
  snapshot.cookies[0].value = 'changed outside store';
  assert.equal(sessions.get(rule, 'alice').storageState.cookies[0].value, 'private');
  sessions.set(rule, 'bob', state, 'UA');
  sessions.set(rule, 'carol', state, 'UA');
  assert.equal(sessions.get(rule, 'alice'), undefined);
  now = 1001;
  assert.equal(sessions.get(rule, 'bob'), undefined);
  assert.equal(sessions.sessions.size, 0);
  sessions.set(rule, 'carol', state, 'UA');
  sessions.close();
  assert.equal(sessions.get(rule, 'carol'), undefined);
});

test('REST search, chapters, playback and background batch caches use the same server-issued owner jar', async (t) => {
  const received = [];
  const upstream = createServer((req, res) => {
    received.push({ path: req.url, cookie: req.headers.cookie, ua: req.headers['user-agent'] });
    if (
      !req.headers.cookie?.includes('verified=private') ||
      req.headers['user-agent'] !== 'Verified UA'
    )
      return res.writeHead(403).end('Access denied');
    if (req.url === '/search') return res.end('<article><a href="/detail">Found</a></article>');
    if (req.url === '/detail') return res.end('<ul><a href="/movie.mp4">Episode 1</a></ul>');
    res.writeHead(200, { 'content-type': 'video/mp4' }).end('cached verified bytes');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-rule-session-'));
  const sessions = new RuleSessionStore();
  const application = await createApp({
    dataDir: directory,
    httpClient: createHttpClient({ allowPrivate: true }),
    seedRules: [
      {
        name: 'Private source',
        baseURL: origin,
        searchURL: `${origin}/search`,
        searchList: '//article',
        searchName: '//a',
        searchResult: '//a',
        chapterRoads: '//ul',
        chapterResult: '//a',
      },
    ],
    browserResolver: {
      requestOptions: (...args) => sessions.requestOptions(...args),
      mediaSession: (...args) => sessions.mediaSession(...args),
      close: () => sessions.close(),
    },
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await application.close();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  let ownerCookie = '';
  const post = (path, body, cookie = ownerCookie) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const first = await post('/api/rules/search', { keyword: 'first' });
  ownerCookie = first.headers.get('set-cookie').split(';')[0];
  await first.json();
  const config = application.store.get('Private source');
  sessions.set(
    config,
    ownerCookie.split('=')[1],
    {
      cookies: [
        {
          name: 'verified',
          value: 'private',
          domain: '127.0.0.1',
          path: '/',
          secure: false,
          expires: -1,
        },
      ],
      origins: [],
    },
    'Verified UA',
  );
  const search = await (await post('/api/rules/search', { keyword: 'again' })).json();
  assert.equal(search.results[0].items.length, 1);
  const chapters = await (
    await post('/api/rules/chapters', { ruleName: config.name, url: `${origin}/detail` })
  ).json();
  assert.equal(chapters.roads[0].episodes.length, 1);
  const playback = await (
    await post('/api/resolve', { ruleName: config.name, url: `${origin}/movie.mp4` })
  ).json();
  const media = await fetch(`${base}${playback.url}`);
  assert.equal(await media.text(), 'cached verified bytes');
  const batchResponse = await post('/api/downloads/batch', {
    ruleName: config.name,
    episodes: [{ name: 'One', url: `${origin}/movie.mp4?batch` }],
  });
  assert.equal(batchResponse.status, 202);
  const batch = await batchResponse.json();
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = (await (await fetch(`${base}/api/downloads`)).json()).items.find(
      (item) => item.id === batch.items[0].id,
    );
    if (['complete', 'error'].includes(completed?.status)) break;
    await delay(20);
  }
  assert.equal(completed.status, 'complete', completed.error);
  assert.equal(
    await (await fetch(`${base}${completed.playbackUrl}`)).text(),
    'cached verified bytes',
  );
  assert.ok(
    received
      .slice(1)
      .every((request) => request.cookie === 'verified=private' && request.ua === 'Verified UA'),
  );
  const isolated = await (await post('/api/rules/search', { keyword: 'other browser' }, '')).json();
  assert.equal(isolated.results[0].items.length, 0);
  assert.equal(received.at(-1).cookie, undefined);
  assert.doesNotMatch(
    JSON.stringify([search, chapters, playback, batch, completed]),
    /verified=private|Verified UA/,
  );
});
