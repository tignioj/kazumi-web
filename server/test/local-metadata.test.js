import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LocalMetadataStore } from '../local-metadata.js';
import { ArchiveManager } from '../archive-manager.js';
import { MetadataService, categorySearchOptions } from '../metadata.js';
import { createApp } from '../index.js';
import { createCoverResolver } from '../cover-resolver.js';
import { archiveZip, zipFiles, subjects, episodes } from './fixtures/archive.js';

async function fixture(t, { now } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-local-'));
  const store = await new LocalMetadataStore(join(directory, 'metadata'), { now }).init();
  const http = {
    close: async () => {},
    json: async () => {
      throw new Error('unexpected upstream request');
    },
    request: async () => {
      throw new Error('unexpected upstream request');
    },
  };
  const manager = new ArchiveManager({ store, http, autoUpdate: false });
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await manager.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const archive = join(directory, 'fixture.zip');
  await writeFile(archive, archiveZip());
  return { directory, store, manager, http, archive, cleanup };
}

test('official archive import powers local Chinese/alias search, AND filters, sorting, pagination and detail', async (t) => {
  const { store, manager, http, archive } = await fixture(t);
  await assert.rejects(store.search('日常'), { status: 503 });
  assert.equal((await manager.status()).ready, false);
  const imported = await manager.update({ file: archive, version: 'first.zip' });
  assert.equal(imported.subjects, 30);
  assert.equal(imported.episodes, 3);
  const metadata = new MetadataService(http, { local: store });
  assert.equal((await metadata.search('日常')).items[0].id, 1);
  assert.equal((await metadata.search('HIDDEN ALIAS')).items[0].id, 1);
  assert.equal((await metadata.search('Ｓｐａｃｅ')).total, 28);
  assert.equal((await metadata.search('星际 物语')).total, 28);
  assert.equal((await metadata.search('" OR 1=1 --')).total, 0);
  assert.equal((await metadata.search('')).total, 30);
  assert.equal((await metadata.search('', { page: 1 })).items.length, 24);
  assert.equal((await metadata.search('', { page: 2 })).items.length, 6);
  assert.equal((await metadata.search('', { sort: 'heat' })).items[0].id, 2);
  assert.equal((await metadata.search('', { sort: 'rank' })).total, 2);
  assert.equal((await metadata.search('', { sort: 'score' })).items[0].id, 2);
  assert.deepEqual(
    (
      await metadata.search(
        '',
        categorySearchOptions({ tag: ['原创', '日常'], format: 'TV', year: '2026', season: '1' }),
      )
    ).items.map((x) => x.id),
    [1],
  );
  assert.equal(
    (await metadata.search('', categorySearchOptions({ year: '2026', season: '1' }))).total,
    29,
  );
  assert.equal(
    (await metadata.search('', categorySearchOptions({ year: '2026', season: '2' }))).total,
    1,
  );
  const detail = await metadata.subject(1);
  assert.equal(detail.eps, 12);
  assert.deepEqual(
    detail.episodes.map((x) => x.name_cn),
    ['第一话', '第二话'],
  );
  assert.equal(detail.image, 'https://api.bgm.tv/v0/subjects/1/image?type=large');
  await assert.rejects(metadata.subject(3), { status: 404 });
  await assert.rejects(metadata.subject('1 OR 1=1'), { status: 400 });
});

test('local recent popularity filters the last 365 days and paginates archive favorites without upstream requests', async (t) => {
  const { store, manager, http, archive } = await fixture(t, {
    now: () => Date.parse('2026-01-04T12:00:00Z'),
  });
  const item = (id, date, done) => ({ ...subjects[0], id, date, favorite: { done } });
  await writeFile(
    archive,
    archiveZip([
      subjects[0],
      item(101, '2024-12-31', 100000),
      item(102, '2026-01-05', 200000),
      item(103, '2025-01-05', 500),
      item(104, '2025-01-04', 600),
      item(105, '2026-01-04', 700),
      item(106, '', 800),
      item(107, '2025-02-30', 900),
      item(108, '2025', 1000),
      ...Array.from({ length: 28 }, (_, i) => item(200 + i, '2025-06-01', i)),
    ]),
  );
  await manager.update({ file: archive });
  const metadata = new MetadataService(http, { local: store });
  const result = await metadata.catalog('trending', 1);
  assert.equal(result.source, 'archive');
  assert.equal(result.basis, 'recent-favorites');
  assert.equal(result.startDate, '2025-01-05');
  assert.equal(result.endDate, '2026-01-04');
  assert.equal(result.total, 31);
  assert.equal(result.items.length, 24);
  assert.deepEqual(
    result.items.slice(0, 3).map((item) => item.id),
    [105, 103, 1],
  );
  const next = await metadata.catalog('trending', 2);
  assert.equal(next.items.length, 7);
  assert.ok(next.items.every((item) => !result.items.some((first) => first.id === item.id)));
  await assert.rejects(metadata.catalog('trending', 0), { status: 400 });
});

test('local calendar uses dated main episodes, deduplicates each day, and rolls weeks in Shanghai time', async (t) => {
  let clock = Date.parse('2026-01-04T15:59:00Z');
  const { store, manager, http, archive } = await fixture(t, { now: () => clock });
  const item = (id, date) => ({ ...subjects[0], id, date });
  const episode = (id, subject_id, airdate, type = 0) => ({
    id,
    subject_id,
    airdate,
    type,
    sort: id,
  });
  await writeFile(
    archive,
    archiveZip(
      [
        item(1, '2026-01-01'),
        item(2, '2026-01-02'),
        item(10, '2025-12-29'),
        item(11, '2025-12-29'),
        item(12, '2026-01-04'),
        item(13, '2020-01-01'),
        item(14, '2024-02-29'),
        item(15, '2026-02-30'),
      ],
      [
        episode(1, 1, '2026-01-01'),
        episode(2, 1, '2026-01-01'),
        episode(3, 1, '2026-01-08'),
        episode(4, 10, '2026-01-03'),
        episode(5, 10, '2026-01-04'),
        episode(6, 11, '2026-01-05'),
        episode(7, 12, '2026'),
        episode(8, 13, '2026-01-01', 2),
        episode(9, 13, '2026-02-30'),
      ],
    ),
  );
  await manager.update({ file: archive });
  const metadata = new MetadataService(http, { local: store });
  const result = await metadata.calendar();
  assert.equal(result.source, 'archive');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.today, '2026-01-04');
  assert.equal(result.weekStart, '2025-12-29');
  assert.equal(result.weekEnd, '2026-01-04');
  assert.deepEqual(
    result.items.map((day) => day.weekday.id),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    result.items.map((day) => day.items.map((item) => item.id)),
    [[], [], [], [1], [2], [10], [10, 12]],
  );
  clock = Date.parse('2026-01-04T16:00:00Z');
  const next = await metadata.calendar();
  assert.equal(next.today, '2026-01-05');
  assert.equal(next.weekStart, '2026-01-05');
  assert.deepEqual(
    next.items[0].items.map((item) => item.id),
    [11],
  );
  assert.deepEqual(
    next.items[3].items.map((item) => item.id),
    [1],
  );
  assert.ok(next.items.every((day) => day.items.every((item) => item.id !== 2)));
  clock = Date.parse('2024-02-29T00:00:00Z');
  assert.deepEqual(
    (await metadata.calendar()).items[3].items.map((item) => item.id),
    [14],
  );
  clock = Date.parse('2026-02-28T00:00:00Z');
  assert.ok((await metadata.calendar()).items.every((day) => day.items.length === 0));
});

test('failed, incomplete and malformed imports preserve the published database across restart', async (t) => {
  const { directory, store, manager, archive } = await fixture(t);
  const first = await manager.update({ file: archive });
  const pointer = await readFile(join(store.directory, 'current.json'), 'utf8');
  for (const bytes of [
    Buffer.from('not a ZIP'),
    zipFiles({ 'subject.jsonlines': '{}\n' }),
    zipFiles({ 'subject.jsonlines': '{broken\n', 'episode.jsonlines': '' }),
    archiveZip([]),
  ]) {
    const broken = join(directory, 'broken.zip');
    await writeFile(broken, bytes);
    await assert.rejects(manager.update({ file: broken }));
    assert.equal(await readFile(join(store.directory, 'current.json'), 'utf8'), pointer);
    assert.equal((await store.subject(1)).name_cn, '日常故事');
  }
  const reader = await new LocalMetadataStore(store.directory).init();
  t.after(() => reader.close());
  assert.equal((await reader.info()).digest, first.digest);
  assert.equal((await reader.search('日常')).total, 1);
});

test('atomic replacement refreshes existing readers and survives failed download checksum validation', async (t) => {
  const { directory, store, manager, archive } = await fixture(t);
  await manager.update({ file: archive, version: 'first.zip' });
  const other = await new LocalMetadataStore(store.directory).init();
  t.after(() => other.close());
  const bytes = archiveZip(
    subjects.map((item) => (item.id === 1 ? { ...item, name_cn: '全新故事' } : item)),
    episodes,
  );
  let downloads = 0;
  manager.http = {
    json: async () => ({
      browser_download_url:
        'https://github.com/bangumi/Archive/releases/download/archive/dump-next.zip',
      name: 'dump-next.zip',
      size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }),
    request: async () => {
      downloads++;
      return { response: new Response(bytes) };
    },
  };
  const pending = manager.update();
  assert.equal(manager.update(), pending);
  await pending;
  assert.equal((await other.subject(1)).name_cn, '全新故事');
  assert.equal((await store.info()).version, 'dump-next.zip');
  await manager.update();
  assert.equal(downloads, 1, 'unchanged digest does not download again');
  manager.http.json = async () => ({
    browser_download_url: 'https://github.com/dump-bad.zip',
    name: 'dump-bad.zip',
    size: bytes.length,
    digest: 'sha256:' + '0'.repeat(64),
  });
  await assert.rejects(manager.update(), /SHA-256/);
  assert.equal((await other.subject(1)).name_cn, '全新故事');
  assert.equal((await manager.status()).phase, 'error');
  assert.equal((await manager.status()).ready, true);
  assert.ok(
    (await readFile(join(directory, 'metadata/current.json'), 'utf8')).includes('dump-next.zip'),
  );
  await writeFile(
    archive,
    archiveZip(subjects.map((item) => ({ ...item, name_cn: item.name_cn + '新版' }))),
  );
  await manager.update({ file: archive, version: 'third.zip' });
  assert.equal((await other.subject(1)).name_cn, '日常故事新版');
  assert.equal(
    (await readdir(store.directory)).filter((name) => /^metadata-.*\.sqlite$/.test(name)).length,
    2,
    'only the current and one preceding database snapshot remain',
  );
});

test('separate updater processes share a crash-safe database lock', async (t) => {
  const { store, manager, archive } = await fixture(t);
  await manager.update({ file: archive });
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  manager.http.json = async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    throw new Error('test release');
  };
  const running = manager.update();
  await started;
  const competing = new ArchiveManager({ store, http: manager.http });
  await assert.rejects(competing.update(), { status: 409 });
  release();
  await assert.rejects(running, /test release/);
  await competing.close();
  assert.equal((await store.search('日常')).total, 1);
});

test('periodic checks run on startup and use the configured interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager } = await fixture(t);
  manager.autoUpdate = true;
  let calls = 0;
  manager.update = async () => {
    calls++;
  };
  manager.persist = async (changes) => Object.assign(manager.state, changes);
  manager.start();
  await nextTurn();
  assert.equal(calls, 1);
  t.mock.timers.tick(24 * 3600000);
  await nextTurn();
  assert.equal(calls, 2);
  assert.ok(manager.state.nextCheckAt);
});

test('all local REST metadata routes work with the upstream offline, and cover lookup is separate', async (t) => {
  const { directory, manager, archive, http, cleanup } = await fixture(t);
  await manager.update({ file: archive });
  const application = await createApp({
    dataDir: directory,
    seedRules: [],
    browserResolver: false,
    httpClient: http,
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await application.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    '/api/categories?tag=日常&format=TV',
    '/api/search?q=Hidden%20Alias',
    '/api/subjects/1',
    '/api/catalog?sort=trending',
    '/api/calendar',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal((await response.json()).source, 'archive');
  }
  assert.equal((await (await fetch(base + '/api/metadata/status')).json()).ready, true);
  let requests = 0;
  const resolver = createCoverResolver({
    json: async (url) => {
      requests++;
      assert.match(url, /\/p1\/subjects\/1$/);
      return { images: { large: 'https://lain.bgm.tv/pic/cover/l/example.jpg' } };
    },
  });
  assert.equal(
    await resolver('https://api.bgm.tv/v0/subjects/1/image?type=large'),
    'https://lain.bgm.tv/pic/cover/l/example.jpg',
  );
  assert.equal(
    await resolver('https://lain.bgm.tv/pic/cover/l/existing.jpg'),
    'https://lain.bgm.tv/pic/cover/l/existing.jpg',
  );
  assert.equal(requests, 1);
  await assert.rejects(
    createCoverResolver({ json: async () => ({ images: { large: 'http://127.0.0.1/private' } }) })(
      'https://api.bgm.tv/v0/subjects/1/image',
    ),
    { status: 502 },
  );
});
