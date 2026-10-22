import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOfficialRulesCatalog,
  DEFAULT_RULES_REPOSITORY,
} from '../../server/modules/rules/catalog.js';
import { createApp } from '../../server/app.js';

const rule = {
  name: '自有 规则',
  version: '1',
  baseURL: 'https://source.example/',
  searchURL: 'https://source.example/?wd=@keyword',
  searchList: '//a',
  searchName: '.',
  searchResult: '.',
  chapterRoads: '//ul',
  chapterResult: '//a',
};
const offline = {
  json: async () => {
    throw new Error('network offline');
  },
  close: async () => {},
};
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'kazumi-rule-catalog-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('first offline start exposes the bundled official catalog and complete installable rules', async () => {
  const snapshot = JSON.parse(
    await readFile(new URL('../../server/defaults/official-rules.json', import.meta.url)),
  );
  const catalog = createOfficialRulesCatalog(offline, { repository: DEFAULT_RULES_REPOSITORY });
  const rules = await catalog.officialRules();
  assert.deepEqual(
    rules.map(({ name }) => name),
    snapshot.rules.map(({ name }) => name),
  );
  assert.equal(catalog.status().source, 'builtin');
  assert.equal(catalog.status().stale, true);
  assert.equal(catalog.status().updatedAt, null);
  assert.deepEqual(await catalog.officialRule(rules[0].name), snapshot.rules[0]);
  assert.equal(catalog.status(rules[0].name).stale, true);
  rules[0].name = 'changed by caller';
  assert.notEqual((await catalog.officialRules())[0].name, rules[0].name);
  await assert.rejects(catalog.officialRules(true, { allowFallback: false }), /无法确认更新/);
});

test('successful custom repository data survives a restart and expired data remains usable offline', async (t) => {
  const dataDir = await directory(t);
  let time = Date.now();
  let calls = 0;
  const options = {
    directory: dataDir,
    repository: 'https://rules.example/custom',
    now: () => time,
  };
  const catalog = createOfficialRulesCatalog(
    {
      json: async (url) => {
        calls++;
        assert.ok(url.startsWith('https://rules.example/custom/'));
        return url.endsWith('index.json') ? [{ name: rule.name, version: '1' }] : rule;
      },
    },
    options,
  );
  await Promise.all([catalog.officialRules(), catalog.officialRules()]);
  await Promise.all([catalog.officialRule(rule.name), catalog.officialRule(rule.name)]);
  assert.equal(calls, 2, 'Concurrent readers share the index and detail requests');
  assert.equal((await readdir(join(dataDir, 'rule-catalog'))).length, 1, 'No partial files remain');
  const restored = createOfficialRulesCatalog(offline, options);
  assert.equal((await restored.officialRules())[0].name, rule.name);
  assert.deepEqual(await restored.officialRule(rule.name), rule);
  assert.equal(restored.status().source, 'disk');
  assert.equal(restored.status().stale, false);
  time += 60 * 60 * 1000 + 1;
  assert.equal((await restored.officialRules())[0].name, rule.name);
  assert.equal(restored.status().stale, true);
  assert.deepEqual(await restored.officialRule(rule.name), rule);
  await assert.rejects(
    restored.officialRule(rule.name, true, { allowFallback: false }),
    /无法确认更新/,
  );
  await assert.rejects(restored.officialRule('7sefun'), /network offline/);
});

test('repository changes and mismatched on-disk identities cannot leak cached or official rules', async (t) => {
  const dataDir = await directory(t);
  const options = { directory: dataDir, repository: 'https://rules.example/a/' };
  const catalog = createOfficialRulesCatalog(
    { json: async (url) => (url.endsWith('index.json') ? [{ name: rule.name }] : rule) },
    options,
  );
  await catalog.officialRules();
  await catalog.officialRule(rule.name);
  const other = createOfficialRulesCatalog(offline, {
    ...options,
    repository: 'https://rules.example/b/',
  });
  await assert.rejects(other.officialRules(), /network offline/);
  await assert.rejects(other.officialRule(rule.name), /network offline/);
  const file = join(dataDir, 'rule-catalog', (await readdir(join(dataDir, 'rule-catalog')))[0]);
  const saved = JSON.parse(await readFile(file));
  saved.repository = 'https://rules.example/b/';
  await writeFile(file, JSON.stringify(saved));
  await assert.rejects(
    createOfficialRulesCatalog(offline, options).officialRules(),
    /network offline/,
  );
  await writeFile(file, '{interrupted');
  await assert.rejects(
    createOfficialRulesCatalog(offline, options).officialRules(),
    /network offline/,
  );
});

test('a valid empty official directory stays empty through an outage and restart', async (t) => {
  const dataDir = await directory(t);
  let unavailable = false;
  const options = { directory: dataDir, repository: DEFAULT_RULES_REPOSITORY };
  const catalog = createOfficialRulesCatalog(
    {
      json: async () => {
        if (unavailable) throw new Error('offline');
        return [];
      },
    },
    options,
  );
  assert.deepEqual(await catalog.officialRules(), []);
  unavailable = true;
  assert.deepEqual(await catalog.officialRules(true), []);
  assert.notEqual(catalog.status().source, 'builtin');
  assert.deepEqual(await createOfficialRulesCatalog(offline, options).officialRules(), []);
});

test('malformed remote data preserves the last good index and rule on disk', async (t) => {
  const dataDir = await directory(t);
  const options = { directory: dataDir, repository: 'https://rules.example/' };
  let invalid = false;
  const catalog = createOfficialRulesCatalog(
    {
      json: async (url) =>
        url.endsWith('index.json')
          ? invalid
            ? [{ name: '../escape' }]
            : [{ name: rule.name }]
          : invalid
            ? { ...rule, name: 'injected' }
            : rule,
    },
    options,
  );
  await catalog.officialRules();
  await catalog.officialRule(rule.name);
  invalid = true;
  assert.equal((await catalog.officialRules(true))[0].name, rule.name);
  assert.deepEqual(await catalog.officialRule(rule.name, true), rule);
  await assert.rejects(catalog.officialRule(rule.name, true, { allowFallback: false }), /名称/);
  const restored = createOfficialRulesCatalog(offline, options);
  assert.equal((await restored.officialRules())[0].name, rule.name);
  assert.deepEqual(await restored.officialRule(rule.name), rule);
  for (const name of ['../escape', '..', '.', 'bad/name', 'bad\\name', 'bad\nname', ' spaced '])
    await assert.rejects(catalog.officialRule(name), /名称/);
});

test('a mounted local repository supports Unicode file names, updates and its own offline cache without HTTP', async (t) => {
  const dataDir = await directory(t);
  const repository = join(dataDir, 'repository');
  await mkdir(repository);
  const write = async (version) => {
    await writeFile(join(repository, 'index.json'), JSON.stringify([{ name: rule.name, version }]));
    await writeFile(join(repository, `${rule.name}.json`), JSON.stringify({ ...rule, version }));
  };
  await write('1');
  const catalog = createOfficialRulesCatalog(
    { json: () => assert.fail('Local repositories must not use HTTP') },
    { directory: dataDir, repository },
  );
  await catalog.officialRules();
  assert.equal((await catalog.officialRule(rule.name)).version, '1');
  assert.equal(catalog.status().source, 'local');
  await write('2');
  await catalog.officialRules(true, { allowFallback: false });
  assert.equal(
    (await catalog.officialRule(rule.name, true, { allowFallback: false })).version,
    '2',
  );
  await rm(repository, { recursive: true });
  assert.equal((await catalog.officialRules(true))[0].version, '2');
  assert.equal(catalog.status().stale, true);
  await assert.rejects(catalog.officialRules(true, { allowFallback: false }), /无法确认更新/);
});

test('invalid selectors and unsupported future APIs cannot replace a working cached rule', async (t) => {
  const dataDir = await directory(t);
  const options = { directory: dataDir, repository: 'https://rules.example/' };
  let remote = rule;
  const catalog = createOfficialRulesCatalog({ json: async () => remote }, options);
  await catalog.officialRule(rule.name);
  for (const bad of [
    { ...rule, searchList: '//*[(' },
    { ...rule, api: '999' },
  ]) {
    remote = bad;
    await assert.rejects(catalog.officialRule(rule.name, true, { allowFallback: false }), {
      code: 'RULE_INCOMPATIBLE',
    });
    assert.deepEqual(await catalog.officialRule(rule.name, true), rule);
  }
  const restored = createOfficialRulesCatalog(offline, options);
  assert.deepEqual(await restored.officialRule(rule.name), rule);
});

test('late index refreshes cannot overwrite newer index or detail data, including the persisted cache', async (t) => {
  const dataDir = await directory(t);
  const options = { directory: dataDir, repository: 'https://rules.example/' };
  const started = Promise.withResolvers();
  const oldIndex = Promise.withResolvers();
  let calls = 0;
  const catalog = createOfficialRulesCatalog(
    {
      json: async (url) => {
        if (!url.endsWith('index.json')) return { ...rule, version: '2' };
        if (++calls === 1) {
          started.resolve();
          return oldIndex.promise;
        }
        return [{ name: rule.name, version: '2' }];
      },
    },
    options,
  );
  const old = catalog.officialRules();
  await started.promise;
  await catalog.officialRules(true);
  await catalog.officialRule(rule.name);
  oldIndex.resolve([{ name: rule.name, version: '1' }]);
  await old;
  assert.equal((await catalog.officialRules())[0].version, '2');
  const restored = createOfficialRulesCatalog(offline, options);
  assert.equal((await restored.officialRules())[0].version, '2');
  assert.equal((await restored.officialRule(rule.name)).version, '2');
});

test('repeated incompatible previews do not postpone recovery when their error cache expires', async () => {
  let time = Date.now();
  let remote = { ...rule, api: '999' };
  let requests = 0;
  const catalog = createOfficialRulesCatalog(
    {
      json: async () => {
        requests++;
        return remote;
      },
    },
    { repository: 'https://rules.example/', now: () => time },
  );
  const preview = () => catalog.officialRule(rule.name, false, { allowFallback: false });
  await assert.rejects(preview(), { code: 'RULE_INCOMPATIBLE' });
  time += 30 * 60 * 1000;
  await assert.rejects(preview(), { code: 'RULE_INCOMPATIBLE' });
  assert.equal(requests, 1);
  remote = rule;
  time += 30 * 60 * 1000 + 1;
  assert.deepEqual(await preview(), rule);
  assert.equal(requests, 2);
});

test('REST installs work on first offline start but update failures never report latest or change installed rules', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kazumi-offline-install-'));
  const application = await createApp({
    dataDir,
    seedRules: [],
    metadata: {},
    browserResolver: false,
    httpClient: offline,
    rulesRepository: DEFAULT_RULES_REPOSITORY,
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await application.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/rules`;
  const catalog = await (await fetch(`${base}/catalog`)).json();
  assert.equal(catalog.catalog.source, 'builtin');
  const response = await fetch(`${base}/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '7sefun' }),
  });
  assert.equal(response.status, 200);
  const installed = await response.json();
  assert.equal(installed.rules[0].name, '7sefun');
  assert.equal(installed.catalog.stale, true);
  const update = await fetch(`${base}/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(update.status, 502);
  assert.match((await update.json()).error, /无法确认更新/);
  const preview = await fetch(`${base}/updates`);
  assert.equal(preview.status, 502);
  assert.deepEqual(application.store.list(), installed.rules);
});
