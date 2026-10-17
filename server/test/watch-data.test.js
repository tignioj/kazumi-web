import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchStore } from '../watch-store.js';
import { createApp } from '../index.js';
import { watchKey } from '../../shared/watch-data.js';

const collection = (id, status = '在看') => ({
  subject: { id, name: `动画 ${id}`, name_cn: `番剧 ${id}`, image: 'https://example.com/a.jpg' },
  status,
  addedAt: 100,
});
const record = (id, updatedAt = id, position = id) => ({
  key: 'untrusted-key',
  title: `动画 ${id}`,
  ruleName: '测试源',
  sourceUrl: `https://example.com/subject/${id}`,
  episodeUrl: `https://example.com/play/${id}`,
  episodeName: '第 1 话',
  roadIndex: 0,
  episodeIndex: 0,
  position,
  duration: 1200,
  updatedAt,
});
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'kazumi-watch-data-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('watch store preserves shared collection and progress across restarts, including empty data', async (t) => {
  const path = await directory(t);
  const store = await new WatchStore(path).init();
  assert.deepEqual(store.list(), { library: {}, history: [] });
  await store.saveLibrary('1', collection(1));
  await store.saveLibrary('1', { ...collection(1, '看过'), addedAt: 200 });
  await store.saveHistory(record(1, 500, 123));
  const restarted = await new WatchStore(path).init();
  assert.deepEqual(restarted.list(), store.list());
  assert.equal(restarted.list().library[1].addedAt, 100);
  assert.equal(restarted.list().library[1].status, '看过');
  assert.equal(restarted.list().history[0].position, 123);
  assert.equal(restarted.list().history[0].key, watchKey('测试源', record(1).sourceUrl));
  await restarted.removeLibrary('1');
  await restarted.removeHistory();
  assert.deepEqual((await new WatchStore(path).init()).list(), { library: {}, history: [] });
});

test('concurrent device mutations preserve distinct records and isolate returned snapshots', async (t) => {
  const store = await new WatchStore(await directory(t)).init();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) => index + 1).flatMap((id) => [
      store.saveLibrary(String(id), collection(id)),
      store.saveHistory(record(id)),
    ]),
  );
  assert.equal(Object.keys(store.list().library).length, 20);
  assert.equal(store.list().history.length, 20);
  const copy = store.list();
  copy.library[1].subject.name = 'changed';
  copy.history.length = 0;
  assert.equal(store.list().library[1].subject.name, '动画 1');
  assert.equal(store.list().history.length, 20);
});

test('late progress cannot rewind a newer episode and history retains the latest 200 entries', async (t) => {
  const store = await new WatchStore(await directory(t)).init();
  await store.saveHistory({ ...record(1, 500, 23), episodeIndex: 1 });
  await store.saveHistory(record(1, 400, 1200));
  assert.equal(store.list().history[0].episodeIndex, 1);
  assert.equal(store.list().history[0].position, 23);
  await store.restore({
    library: {},
    history: Array.from({ length: 205 }, (_, index) => record(index + 1)),
  });
  assert.equal(store.list().history.length, 200);
  assert.equal(store.list().history[0].updatedAt, 205);
  assert.equal(store.list().history.at(-1).updatedAt, 6);
  await store.removeHistory(watchKey('测试源', record(205).sourceUrl));
  assert.equal(store.list().history[0].updatedAt, 204);
});

test('legacy migration is repeatable and merges records without replacing server collection choices', async (t) => {
  const store = await new WatchStore(await directory(t)).init();
  await store.saveLibrary('1', collection(1, '看过'));
  await store.saveHistory(record(1, 300, 700));
  await store.saveHistory(record(2, 100, 20));
  const legacy = {
    library: { 1: collection(1, '想看'), 2: collection(2) },
    history: [record(1, 200, 10), record(2, 400, 900), record(3)],
  };
  await store.migrate(legacy);
  const merged = store.list();
  assert.equal(merged.library[1].status, '看过');
  assert.equal(merged.library[2].status, '在看');
  assert.equal(merged.history.find((item) => item.sourceUrl === record(1).sourceUrl).position, 700);
  assert.equal(merged.history.find((item) => item.sourceUrl === record(2).sourceUrl).position, 900);
  assert.equal(merged.history.length, 3);
  await store.migrate(legacy);
  assert.deepEqual(store.list(), merged);
});

test('invalid imports and failed writes leave saved data intact and the write queue can recover', async (t) => {
  const path = await directory(t);
  const store = await new WatchStore(path).init();
  await mkdir(store.file);
  await assert.rejects(store.saveLibrary('1', collection(1)));
  assert.deepEqual(store.list(), { library: {}, history: [] });
  assert.deepEqual(await readdir(path), ['watch-data.json']);
  await rm(store.file, { recursive: true });
  await store.saveLibrary('1', collection(1));
  const saved = await readFile(store.file, 'utf8');
  assert.throws(() => store.restore({ library: {}, history: [null] }), /观看记录/);
  assert.throws(() => store.saveLibrary('2', collection(1)), /ID/);
  assert.throws(() => store.saveLibrary('1', collection(1, 'invalid')), /收藏/);
  assert.equal(await readFile(store.file, 'utf8'), saved);
  await writeFile(store.file, '{invalid');
  await assert.rejects(new WatchStore(path).init(), /无法读取收藏与观看记录文件/);
  assert.equal(await readFile(store.file, 'utf8'), '{invalid');
});

test('watch API shares persisted data without browser identity and validates every write', async (t) => {
  const path = await directory(t);
  let app;
  let server;
  async function start() {
    app = await createApp({ dataDir: path, seedRules: [], browserResolver: false });
    server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}/api/watch-data`;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  }
  let base = await start();
  async function request(suffix = '', method = 'GET', body, headers = {}) {
    const response = await fetch(`${base}${suffix}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  try {
    assert.deepEqual((await request()).data, { library: {}, history: [] });
    assert.equal((await request()).headers.get('cache-control'), 'no-store');
    assert.equal((await request('/library/1', 'PUT', collection(1))).status, 200);
    assert.equal((await request('/history', 'PUT', record(1, 500, 88))).status, 200);
    const otherBrowser = await request('', 'GET', undefined, { cookie: 'unrelated=device-b' });
    assert.equal(otherBrowser.data.library[1].status, '在看');
    assert.equal(otherBrowser.data.history[0].position, 88);
    assert.equal((await request('/library/2', 'PUT', collection(1))).status, 400);
    assert.equal((await request('/history', 'PUT', { title: 'invalid' })).status, 400);
    assert.equal((await request('', 'PUT', { library: [], history: [] })).status, 400);
    assert.equal(
      (await request('/library/1', 'PUT', collection(1), { origin: 'https://evil.example' }))
        .status,
      403,
    );
    await request('/migrate', 'POST', { library: { 2: collection(2) }, history: [record(2)] });
    await stop();
    base = await start();
    assert.equal(Object.keys((await request()).data.library).length, 2);
    assert.equal((await request()).data.history[0].position, 88);
    await request(
      `/history?key=${encodeURIComponent(watchKey('测试源', record(1).sourceUrl))}`,
      'DELETE',
    );
    assert.equal((await request()).data.history.length, 1);
    await request('/history', 'DELETE');
    await request('/library/1', 'DELETE');
    assert.equal((await request()).data.library[1], undefined);
    const restored = await request('', 'PUT', {
      library: { 3: collection(3) },
      history: [record(3)],
    });
    assert.deepEqual(Object.keys(restored.data.library), ['3']);
    assert.equal(restored.data.history.length, 1);
  } finally {
    await stop();
  }
});
