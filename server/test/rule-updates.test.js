import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../index.js';
import { availableRuleUpdates, newerRuleVersion } from '../modules/rules/updates.js';

test('rule versions compare numeric components without downgrading', () => {
  assert.equal(newerRuleVersion('1.10', '1.9'), true);
  assert.equal(newerRuleVersion('1.9', '1.10'), false);
  assert.equal(newerRuleVersion('1.0.0', '1.0'), false);
  assert.equal(newerRuleVersion('2', ''), true);
});

test('available updates count installed rules with newer known versions', () => {
  const installed = [
    { name: 'imported', version: '1.9', enabled: false },
    { name: 'Same', version: '1.0' },
    { name: 'Ahead', version: '2.0' },
    { name: 'Custom', version: '1.0' },
    { name: 'Unknown', version: '1.0' },
    { name: 'Blank', version: '1.0' },
    { name: 'Numeric', version: '1' },
  ];
  const catalog = [
    { name: 'Imported', version: '1.10' },
    { name: 'Imported', version: '1.10' },
    { name: 'Same', version: '1.0.0' },
    { name: 'Ahead', version: '1.10' },
    { name: 'Not installed', version: '3.0' },
    { name: 'Unknown' },
    { name: 'Blank', version: '' },
    { name: 'Numeric', version: 2 },
  ];
  assert.deepEqual(availableRuleUpdates(installed, catalog), [
    { name: 'imported', version: '1.10' },
    { name: 'Numeric', version: '2' },
  ]);
  assert.deepEqual(availableRuleUpdates([], catalog), []);
  assert.deepEqual(availableRuleUpdates(installed, []), []);
});

test('imported rules update from a fresh official catalog and persist partial successes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-rule-updates-'));
  const local = (name, version = '1.0') => ({ name, version, baseURL: 'https://old.example/' });
  const catalog = ['Imported', 'Working', 'Broken', 'Mismatch', 'Unsupported', 'Ahead', 'Same'];
  let index = [];
  let catalogRequests = 0;
  const http = {
    allowPrivate: false,
    async json(url) {
      if (url.endsWith('/index.json')) {
        catalogRequests++;
        return index;
      }
      const name = decodeURIComponent(
        new URL(url).pathname
          .split('/')
          .at(-1)
          .replace(/\.json$/, ''),
      );
      if (name === 'Broken') throw new Error('上游请求超时');
      return {
        ...local(name === 'Mismatch' ? 'Injected' : name, name === 'Ahead' ? '1.0' : '1.10'),
        baseURL: 'https://new.example/',
        ...(name === 'Unsupported' ? { api: '99' } : {}),
      };
    },
    async close() {},
  };
  const application = await createApp({
    dataDir: directory,
    seedRules: [],
    httpClient: http,
    browserResolver: false,
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await application.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(`${base}/api/rules/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  };
  await post('import', {
    content: [
      { ...local('imported', '1.9'), enabled: false },
      ...catalog
        .slice(1)
        .map((name) => local(name, name === 'Ahead' ? '2.0' : name === 'Same' ? '1.10' : '1.0')),
      local('Custom'),
    ],
  });
  await fetch(`${base}/api/rules/catalog`); // Cache the old empty catalog.
  index = catalog.map((name) => ({ name, version: '1.10' }));
  const single = await post('update', { name: 'IMPORTED' });
  assert.equal(single.status, 200);
  assert.deepEqual(single.results, [{ name: 'imported', status: 'updated', version: '1.10' }]);
  assert.equal(catalogRequests, 2, 'update bypasses the cached catalog');
  assert.equal(single.rules.find((rule) => rule.name === 'Imported').enabled, false);
  assert.equal(single.rules.length, catalog.length + 1, 'case variants replace the imported rule');
  const pending = await fetch(`${base}/api/rules/updates`);
  assert.equal(pending.status, 200);
  assert.deepEqual((await pending.json()).updates, [
    { name: 'Working', version: '1.10' },
    { name: 'Broken', version: '1.10' },
    { name: 'Mismatch', version: '1.10' },
    { name: 'Unsupported', version: '1.10' },
  ]);
  assert.equal(catalogRequests, 2, 'checking availability reuses the cached catalog');
  assert.equal(application.store.get('Working').version, '1.0', 'checking does not update rules');
  const batch = await post('update', {});
  assert.deepEqual(
    Object.fromEntries(batch.results.map((result) => [result.name, result.status])),
    {
      Imported: 'latest',
      Working: 'updated',
      Broken: 'failed',
      Mismatch: 'failed',
      Unsupported: 'failed',
      Ahead: 'latest',
      Same: 'latest',
      Custom: 'unlisted',
    },
  );
  for (const name of ['Broken', 'Mismatch', 'Unsupported', 'Ahead', 'Same', 'Custom'])
    assert.equal(batch.rules.find((rule) => rule.name === name).baseURL, 'https://old.example/');
  assert.deepEqual((await (await fetch(`${base}/api/rules/updates`)).json()).updates, [
    { name: 'Broken', version: '1.10' },
    { name: 'Mismatch', version: '1.10' },
    { name: 'Unsupported', version: '1.10' },
  ]);
  assert.match(batch.results.find((rule) => rule.name === 'Mismatch').message, /名称/);
  assert.match(batch.results.find((rule) => rule.name === 'Unsupported').message, /版本不受支持/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'rules.json'), 'utf8')), batch.rules);
  assert.equal((await post('update', { name: 'Missing' })).status, 404);
  assert.equal((await post('update', { name: '' })).status, 400);
  const mismatch = await post('install', { name: 'Mismatch' });
  assert.equal(mismatch.status, 502);
  assert.equal(
    application.store.list().some((rule) => rule.name === 'Injected'),
    false,
  );
});
