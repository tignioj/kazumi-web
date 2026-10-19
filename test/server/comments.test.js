import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { CommentService } from '../../server/modules/metadata/comments.js';
import { registerMetadataRoutes } from '../../server/modules/metadata/routes.js';
import { handleError } from '../../server/middleware/errors.js';

const short = (id, comment = `短评 ${id}`) => ({
  id,
  user: { username: 'reader', nickname: '读者' },
  rate: 8,
  comment,
  updatedAt: 1792382400,
});
const episodeComment = (id) => ({
  id,
  user: { username: 'watcher', nickname: '观众' },
  content: `讨论 ${id}`,
  createdAt: 1792382400,
  replies: [],
});

async function fixture(t, http, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-comments-'));
  let service = await new CommentService({ directory, http, ...options }).init();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    async restart(overrides = {}) {
      await service.close();
      service = await new CommentService({ directory, http, ...options, ...overrides }).init();
      return service;
    },
  };
}

test('short comments persist across restarts, expire and fall back without losing the last good page', async (t) => {
  let now = 1792382400000;
  let offline = false;
  let malformed = false;
  const calls = [];
  const f = await fixture(
    t,
    {
      async json(url, options) {
        calls.push({ url, options });
        if (offline) throw new Error('offline');
        if (malformed) return { data: '<html>', total: 1 };
        return { data: [short(1, '<script>alert(1)</script>\n普通评论')], total: 25 };
      },
    },
    { now: () => now, ttlMinutes: 1 },
  );
  const first = await f.service.read('subjects', '101');
  assert.equal(first.items[0].content, '<script>alert(1)</script>\n普通评论');
  assert.deepEqual(first.items[0].user, { username: 'reader', nickname: '读者' });
  assert.equal(first.items[0].rate, 8);
  assert.equal(first.items[0].timestamp, 1792382400);
  assert.equal(first.cache.persisted, true);
  assert.equal(calls[0].url, 'https://next.bgm.tv/p1/subjects/101/comments?limit=20&offset=0');
  assert.match(calls[0].options.headers['user-agent'], /KazumiWeb/);
  await f.restart();
  offline = true;
  const fresh = await f.service.read('subjects', 101);
  assert.equal(fresh.cache.cached, true);
  assert.equal(fresh.cache.stale, false);
  assert.equal(calls.length, 1);
  now += 60001;
  const stale = await f.service.read('subjects', 101);
  assert.equal(stale.cache.stale, true);
  assert.equal(stale.cache.updatedAt, first.cache.updatedAt);
  assert.deepEqual(stale.items, first.items);
  await assert.rejects(f.service.read('subjects', 101, { page: 2 }), { status: 502 });
  offline = false;
  malformed = true;
  assert.equal((await f.service.read('subjects', 101)).cache.stale, true);
  malformed = false;
  const updated = await f.service.read('subjects', 101, { refresh: true });
  assert.equal(updated.cache.stale, false);
  assert.equal(updated.cache.updatedAt, now);
  await f.service.read('subjects', 101, { page: 2 });
  assert.match(calls.at(-1).url, /offset=20$/);
});

test('episode discussions cache the full reply tree once and paginate roots locally', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    async json(url) {
      calls++;
      assert.equal(url, 'https://next.bgm.tv/p1/episodes/1001/comments');
      const rows = Array.from({ length: 21 }, (_, i) => episodeComment(i + 1));
      rows[0].replies = [
        episodeComment(101),
        { id: 102, content: '已注销用户的回复', createdAt: 1e100 },
      ];
      return rows;
    },
  });
  const first = await f.service.read('episodes', 1001);
  assert.equal(first.total, 21);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].replies.length, 2);
  assert.equal(first.items[0].replies[1].timestamp, 0);
  assert.deepEqual(first.items[0].replies[1].user, { username: '', nickname: '' });
  await f.restart();
  const second = await f.service.read('episodes', 1001, { page: 2 });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].id, 21);
  assert.equal(second.cache.cached, true);
  assert.equal(calls, 1);
});

test('empty responses are cached and manual refreshes deduplicate concurrent upstream requests', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    async json() {
      calls++;
      await new Promise((resolve) => setImmediate(resolve));
      return { data: [], total: 0 };
    },
  });
  const results = await Promise.all(Array.from({ length: 5 }, () => f.service.read('subjects', 1)));
  assert.equal(calls, 1);
  assert.deepEqual(results[0].items, []);
  assert.equal((await f.service.read('subjects', 1)).cache.cached, true);
  await Promise.all([
    f.service.read('subjects', 1, { refresh: true }),
    f.service.read('subjects', 1, { refresh: true }),
  ]);
  assert.equal(calls, 2);
});

test('cache eviction is bounded and upstream changes do not reuse another server’s data', async (t) => {
  let offline = false;
  let now = 100;
  const data = { items: [], total: 0 };
  const f = await fixture(
    t,
    {
      async json() {
        if (offline) throw new Error('offline');
        return { data: [], total: 0 };
      },
    },
    { maxBytes: Buffer.byteLength(JSON.stringify(data)), now: () => now++ },
  );
  await f.service.read('subjects', 1);
  await f.service.read('subjects', 2);
  offline = true;
  await assert.rejects(f.service.read('subjects', 1), { status: 502 });
  assert.equal((await f.service.read('subjects', 2)).cache.cached, true);
  await f.restart({ nextUrl: 'https://another.example' });
  await assert.rejects(f.service.read('subjects', 2), { status: 502 });
});

test('malformed upstream responses and invalid IDs never become cached empty discussions', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    async json() {
      calls++;
      return { error: 'upstream failed' };
    },
  });
  for (const id of ['0', '-1', '1/2', '1e2', '1?x=1', '9007199254740992'])
    await assert.rejects(f.service.read('subjects', id), { status: 400 });
  for (const page of [0, -1, 1.5, 1001])
    await assert.rejects(f.service.read('subjects', 1, { page }), { status: 400 });
  assert.equal(calls, 0);
  await assert.rejects(f.service.read('subjects', 1), { status: 502 });
  await assert.rejects(f.service.read('subjects', 1), { status: 502 });
  await assert.rejects(f.service.read('episodes', 1), { status: 502 });
  assert.equal(calls, 3);
});

test('HTTP comment routes work independently of local metadata and validate page and refresh parameters', async (t) => {
  const f = await fixture(t, {
    async json(url) {
      return url.includes('/subjects/') ? { data: [short(1)], total: 1 } : [episodeComment(2)];
    },
  });
  const app = express();
  registerMetadataRoutes(app, { metadata: {}, comments: f.service });
  app.use(handleError);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const get = (path) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`);
  for (const kind of ['subjects', 'episodes']) {
    const response = await get(`/${kind}/101/comments`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).items.length, 1);
  }
  for (const path of [
    '/subjects/abc/comments',
    '/episodes/0/comments',
    '/subjects/1/comments?page=0',
    '/subjects/1/comments?refresh=yes',
  ])
    assert.equal((await get(path)).status, 400, path);
});
