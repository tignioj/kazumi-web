import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { RuleStore } from '../../server/modules/rules/store.js';

const rule = {
  name: 'Editor',
  api: '9',
  version: '1.0',
  baseURL: 'https://example.com/',
  searchURL: 'https://example.com/search?wd=@keyword',
  searchList: '//article',
  searchName: '//a',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
};

test('concurrent rule creation rejects case-insensitive duplicates without overwriting storage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-create-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new RuleStore(directory).init();
  const results = await Promise.allSettled([
    store.create(rule),
    store.create({ ...rule, name: 'editor', version: '2.0' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.status, 409);
  assert.equal(store.get(rule.name).version, '1.0');
  await assert.rejects(store.create({ ...rule, name: 'Invalid', searchList: '//*[(' }));
  assert.equal(store.list().length, 1);
  const restored = await new RuleStore(directory).init();
  assert.equal(restored.get(rule.name).version, '1.0');
});

test('editor HTTP create validates one rule and preserves existing rules on rejected writes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-editor-api-'));
  const application = await createApp({
    dataDir: directory,
    seedRules: [],
    browserResolver: false,
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await application.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/rules`;
  const create = (body) =>
    fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const created = await create({ ...rule, custom: { keep: true } });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).rules[0].custom.keep, true);
  const before = await readFile(join(directory, 'rules.json'), 'utf8');
  assert.equal((await create({ ...rule, name: 'editor', version: '2.0' })).status, 409);
  assert.equal((await create([rule])).status, 400);
  assert.equal((await create({ ...rule, name: 'Invalid', api: '99' })).status, 400);
  assert.equal(await readFile(join(directory, 'rules.json'), 'utf8'), before);
  const updated = await fetch(`${base}/Editor`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rule, name: 'Renamed', version: '2.0', custom: { keep: true } }),
  });
  assert.equal(updated.status, 200);
  const rules = (await (await fetch(base)).json()).rules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'Renamed');
  assert.equal(rules[0].custom.keep, true);
});
