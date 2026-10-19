import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../../server/index.js';
import {
  availableRuleUpdates,
  newerRuleVersion,
  compareRuleVersions,
} from '../../server/modules/rules/updates.js';

test('rule versions compare numeric components without downgrading', () => {
  assert.equal(newerRuleVersion('1.10', '1.9'), true);
  assert.equal(newerRuleVersion('1.9', '1.10'), false);
  assert.equal(newerRuleVersion('1.0.0', '1.0'), false);
  assert.equal(newerRuleVersion('2', ''), true);
});

test('version comparison handles v prefixes, prereleases, build metadata and unknown formats conservatively', () => {
  assert.equal(newerRuleVersion('v1.0', 'v2.0'), false);
  assert.equal(newerRuleVersion('v2.0', '1.9'), true);
  assert.equal(compareRuleVersions('1.0.0+new', 'v1.0+old'), 0);
  const ordered = [
    '1.0-alpha',
    '1.0-alpha.1',
    '1.0-alpha.beta',
    '1.0-beta',
    '1.0-beta.2',
    '1.0-beta.11',
    '1.0-rc.1',
    '1.0',
  ];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(newerRuleVersion(ordered[i], ordered[i - 1]), true);
    assert.equal(newerRuleVersion(ordered[i - 1], ordered[i]), false);
  }
  assert.equal(newerRuleVersion('99999999999999999999', '99999999999999999998'), true);
  for (const [remote, local] of [
    ['release-old', 'release-new'],
    ['2.0', 'custom'],
    ['custom', '1.0'],
    ['', '1.0'],
  ]) {
    assert.equal(compareRuleVersions(remote, local), null);
    assert.equal(newerRuleVersion(remote, local), false);
  }
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
  const local = (name, version = '1.0') => ({
    name,
    version,
    baseURL: 'https://old.example/',
    searchURL: 'https://old.example/search?wd=@keyword',
    searchList: '//a',
    searchName: 'text()',
    searchResult: '.',
    chapterRoads: '//ul',
    chapterResult: '//a',
  });
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
  const preview = await pending.json();
  assert.deepEqual(
    preview.updates.map(({ name, version }) => ({ name, version })),
    [{ name: 'Working', version: '1.10' }],
  );
  assert.deepEqual(
    preview.blocked.map(({ name, status }) => ({ name, status })),
    [
      { name: 'Broken', status: 'failed' },
      { name: 'Mismatch', status: 'failed' },
      { name: 'Unsupported', status: 'incompatible' },
    ],
  );
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
      Unsupported: 'incompatible',
      Ahead: 'latest',
      Same: 'latest',
      Custom: 'unlisted',
    },
  );
  for (const name of ['Broken', 'Mismatch', 'Unsupported', 'Ahead', 'Same', 'Custom'])
    assert.equal(batch.rules.find((rule) => rule.name === name).baseURL, 'https://old.example/');
  assert.deepEqual((await (await fetch(`${base}/api/rules/updates`)).json()).updates, []);
  assert.match(batch.results.find((rule) => rule.name === 'Mismatch').message, /名称/);
  assert.match(batch.results.find((rule) => rule.name === 'Unsupported').message, /最高 9/);
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
