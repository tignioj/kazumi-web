import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../../server/app.js';
import { normalizeRule, ruleCompatibility } from '../../server/modules/rules/validation.js';
import { RuleStore } from '../../server/modules/rules/store.js';
import { createOfficialRulesCatalog } from '../../server/modules/rules/catalog.js';

const rule = {
  name: 'Fixture',
  api: '1',
  version: '1.0',
  baseURL: 'https://source.example/',
  searchURL: 'https://source.example/search?wd=@keyword',
  searchList: '//article',
  searchName: '//a/text()',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
};
const captcha = {
  enabled: true,
  captchaType: 1,
  captchaImage: '//img',
  captchaInput: '//input',
  captchaButton: '//button',
};

test('forced detail and catalog refreshes bypass older in-flight previews and keep their cache results', async () => {
  for (const refreshIndex of [false, true]) {
    let finishOld;
    let calls = 0;
    const catalog = createOfficialRulesCatalog({
      json: async (url) => {
        if (url.endsWith('/index.json')) return [{ name: rule.name, version: '2.0' }];
        calls++;
        if (calls === 1)
          return new Promise((resolve) => {
            finishOld = resolve;
          });
        return { ...rule, version: '2.0' };
      },
    });
    const old = catalog.officialRule(rule.name);
    await Promise.resolve();
    if (refreshIndex) await catalog.officialRules(true);
    assert.equal((await catalog.officialRule(rule.name, !refreshIndex)).version, '2.0');
    finishOld(rule);
    assert.equal((await old).version, '1.0');
    assert.equal((await catalog.officialRule(rule.name)).version, '2.0');
    assert.equal(calls, 2);
  }
});

test('one validator checks active requests, selectors, templates, nested shapes and boolean values', () => {
  const api = {
    ...rule,
    api: '9',
    searchMode: 'api',
    searchApiConfig: { request: { url: 'https://source.example/api?q=@keyword' } },
  };
  const invalid = [
    { ...rule, usePost: 'false' },
    { ...rule, adBlocker: 'true' },
    { ...rule, enabled: 'false' },
    { ...rule, searchList: '//*[(' },
    { ...rule, chapterRoads: 'count(//ul)' },
    { ...rule, chapterResult: '' },
    { ...rule, api: '9', antiCrawlerConfig: { enabled: true, captchaType: 2, captchaButton: '' } },
    { ...rule, api: '9', antiCrawlerConfig: { enabled: true, captchaType: 3, captchaScript: '' } },
    {
      ...rule,
      api: '9',
      antiCrawlerConfig: { enabled: true, captchaType: 3, captchaScript: 'return (' },
    },
    {
      ...rule,
      api: '9',
      antiCrawlerConfig: { ...captcha, captchaDetectType: 3, captchaDetectValue: '[' },
    },
    { ...rule, searchURL: 'javascript:alert(1)' },
    { ...api, searchApiConfig: null },
    { ...api, searchApiConfig: { request: { url: 'https://source.example', method: 'PUT' } } },
    { ...api, searchApiConfig: { request: { url: 'https://source.example', headers: [] } } },
    {
      ...api,
      searchApiConfig: { request: { url: 'https://source.example', bodyType: 'invalid' } },
    },
    { ...api, searchApiConfig: { request: { url: 'https://source.example/@unknown' } } },
    { ...api, searchApiConfig: { ...api.searchApiConfig, listPath: '$..data' } },
    { ...api, searchApiConfig: { ...api.searchApiConfig, sourceTemplate: '/fixed' } },
    {
      ...api,
      chapterMode: 'api',
      chapterApiConfig: {
        request: { url: 'https://source.example' },
        format: 'delimited',
        roadNamesPath: '$.names',
        roadEpisodesPath: '$.urls',
        fieldSeparator: '',
      },
    },
    {
      ...api,
      chapterMode: 'api',
      chapterApiConfig: {
        request: { url: 'https://source.example' },
        episodeUrlPath: '',
        episodePage: { url: '/@unknown' },
      },
    },
  ];
  for (const input of invalid)
    assert.throws(() => normalizeRule(input), { code: 'RULE_INCOMPATIBLE' });
  assert.equal(normalizeRule(api).api, '9');
  assert.equal(normalizeRule({ ...rule, searchName: 'string(//a)' }).api, '1');
  assert.equal(normalizeRule({ ...rule, api: '01' }).api, '1');
});

test('compatibility checks minimum levels and all captcha strategies without rejecting inactive settings', () => {
  for (const [fields, minimum] of [
    [{ usePost: true }, 2],
    [{ referer: 'https://source.example/' }, 3],
    [{ useLegacyParser: true }, 3],
    [{ adBlocker: true }, 5],
    [{ antiCrawlerConfig: captcha }, 6],
    [{ antiCrawlerConfig: { ...captcha, captchaDetectType: 2, captchaDetectValue: 'verify' } }, 7],
    [{ searchMode: 'api', searchApiConfig: { request: { url: 'https://source.example' } } }, 8],
    [
      {
        searchMode: 'api',
        searchApiConfig: { request: { url: 'https://source.example' }, sourceTemplate: '/@source' },
      },
      9,
    ],
  ]) {
    const report = ruleCompatibility({ ...rule, ...fields });
    assert.equal(report.requiredApi, minimum);
    assert.ok(report.issues.some(({ code }) => code === 'API_LEVEL_MISMATCH'));
    assert.equal(ruleCompatibility({ ...rule, ...fields, api: String(minimum) }).compatible, true);
  }
  for (const config of [
    { ...captcha, captchaType: 2 },
    { ...captcha, captchaType: 3, captchaScript: 'window.verify()' },
    { ...captcha, captchaDetectType: 3, captchaDetectValue: 'challenge-\\d+' },
  ]) {
    const report = ruleCompatibility({ ...rule, api: '9', antiCrawlerConfig: config });
    assert.equal(report.compatible, true);
    assert.deepEqual(report.requirements, ['dynamicResolver']);
    assert.equal(
      ruleCompatibility(
        { ...rule, api: '9', antiCrawlerConfig: config },
        { dynamicResolver: false },
      ).compatible,
      false,
    );
    assert.equal(
      ruleCompatibility({ ...rule, api: '9', antiCrawlerConfig: { ...config, enabled: false } })
        .compatible,
      true,
    );
  }
  const environment = ruleCompatibility(
    { ...rule, api: '6', antiCrawlerConfig: captcha },
    { dynamicResolver: false },
  );
  assert.deepEqual(environment.requirements, ['dynamicResolver']);
  assert.ok(environment.issues.some(({ code }) => code === 'DYNAMIC_RESOLVER_REQUIRED'));
});

test('all automatic verification strategies pass REST validation, install and update preflight when Chromium is available', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-automatic-preflight-'));
  const configs = [
    { enabled: true, captchaType: 2, captchaButton: '//button' },
    {
      enabled: true,
      captchaType: 3,
      captchaScript: 'globalThis.__kazumiServerCompileOnly = true; return true;',
    },
    { ...captcha, captchaDetectType: 3, captchaDetectValue: 'challenge.*pending' },
  ];
  const candidates = configs.map((antiCrawlerConfig, index) => ({
    ...rule,
    name: `Strategy ${index}`,
    api: '7',
    version: '2.0',
    antiCrawlerConfig,
  }));
  const app = await createApp({
    dataDir: directory,
    seedRules: candidates.map(({ name }) => ({ ...rule, name, enabled: false })),
    browserResolver: { available: true, read() {}, async close() {} },
    httpClient: {
      async json(url) {
        if (url.endsWith('/index.json'))
          return candidates.map(({ name, version }) => ({ name, version }));
        return structuredClone(
          candidates.find(({ name }) =>
            decodeURIComponent(new URL(url).pathname).endsWith(`/${name}.json`),
          ),
        );
      },
      async close() {},
    },
  });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (path, body) => {
    const response = await fetch(`${base}/api/rules/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const validated = await post('validate', { content: candidates });
  assert.ok(validated.compatibility.every(({ compatible }) => compatible));
  const preview = await (await fetch(`${base}/api/rules/updates`)).json();
  assert.equal(preview.updates.length, 3);
  assert.deepEqual(preview.blocked, []);
  const updated = await post('update', {});
  assert.ok(updated.results.every(({ status }) => status === 'updated'));
  assert.ok(updated.rules.every(({ version, enabled }) => version === '2.0' && enabled === false));
  await post('install', { name: candidates[1].name });
  assert.equal(
    globalThis.__kazumiServerCompileOnly,
    undefined,
    'validation compiles syntax without executing the script in Node',
  );
});

test('stored malformed legacy scripts remain readable, while writes are atomic and strict', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = {
    ...rule,
    api: '7',
    antiCrawlerConfig: { enabled: true, captchaType: 3, captchaScript: 'return (' },
  };
  const original = JSON.stringify([legacy]);
  await writeFile(join(directory, 'rules.json'), original);
  const store = await new RuleStore(directory).init();
  assert.equal(store.get(rule.name).antiCrawlerConfig.captchaScript, 'return (');
  assert.equal(ruleCompatibility(store.get(rule.name)).compatible, false);
  await assert.rejects(
    async () =>
      store.import([
        { ...rule, name: 'New' },
        { ...legacy, name: 'Bad' },
      ]),
    { code: 'RULE_INCOMPATIBLE' },
  );
  await assert.rejects(async () => store.replace(rule.name, { ...legacy, version: '2.0' }), {
    code: 'RULE_INCOMPATIBLE',
  });
  assert.equal(await readFile(join(directory, 'rules.json'), 'utf8'), original);
  await store.replace(rule.name, rule);
  assert.deepEqual(store.get(rule.name).antiCrawlerConfig, { enabled: false });
});

test('REST preview reads real rule JSON, reports blockers, and revalidates fresh candidates before updating', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-preflight-'));
  const names = [
    'Working',
    'Script',
    'Regex',
    'Click',
    'Invalid',
    'Future',
    'Opaque',
    'Downgrade',
    'Changed',
  ];
  const installed = names.map((name) => ({
    ...rule,
    name,
    version: name === 'Downgrade' ? 'v2.0' : '1.0',
    enabled: name !== 'Working',
  }));
  const remote = new Map(names.map((name) => [name, { ...rule, name, version: '2.0' }]));
  remote.set('Script', {
    ...remote.get('Script'),
    api: '7',
    antiCrawlerConfig: { ...captcha, captchaType: 3, captchaScript: 'window.verify()' },
  });
  remote.set('Regex', {
    ...remote.get('Regex'),
    api: '7',
    antiCrawlerConfig: { ...captcha, captchaDetectType: 3, captchaDetectValue: 'verify' },
  });
  remote.set('Click', {
    ...remote.get('Click'),
    api: '6',
    antiCrawlerConfig: { ...captcha, captchaType: 2 },
  });
  remote.set('Invalid', { ...remote.get('Invalid'), chapterResult: '//*[(' });
  remote.set('Future', { ...remote.get('Future'), api: '10' });
  remote.set('Opaque', { ...remote.get('Opaque'), version: 'release-two' });
  remote.set('Downgrade', { ...remote.get('Downgrade'), version: 'v1.0' });
  let downloads = 0;
  const application = await createApp({
    dataDir: directory,
    seedRules: installed,
    browserResolver: false,
    httpClient: {
      async json(url) {
        if (url.endsWith('/index.json'))
          return [...remote.values()].map(({ name, version }) => ({ name, version }));
        downloads++;
        return structuredClone(
          remote.get(
            decodeURIComponent(
              new URL(url).pathname
                .split('/')
                .at(-1)
                .replace(/\.json$/, ''),
            ),
          ),
        );
      },
      async close() {},
    },
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await application.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (path, data) => {
    const response = await fetch(`${base}/api/rules/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  const before = await readFile(join(directory, 'rules.json'), 'utf8');
  const checked = await post('validate', { content: rule });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.compatibility[0].compatible, true);
  for (const path of ['validate', 'import']) {
    const response = await post(path, { content: remote.get('Script') });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, 'RULE_INCOMPATIBLE');
  }
  const preview = await (await fetch(`${base}/api/rules/updates`)).json();
  assert.deepEqual(
    preview.updates.map(({ name }) => name),
    ['Working', 'Changed'],
  );
  assert.ok(preview.updates.every(({ compatibility }) => compatibility.compatible));
  assert.deepEqual(
    preview.blocked.map(({ name }) => name),
    ['Script', 'Regex', 'Click', 'Invalid', 'Future', 'Opaque'],
  );
  assert.ok(downloads > 0, 'preflight downloads bodies even when the index omits API metadata');
  const previousDownloads = downloads;
  await fetch(`${base}/api/rules/updates`);
  assert.equal(
    downloads,
    previousDownloads,
    'successful downloads are cached for repeated previews',
  );
  assert.equal(
    await readFile(join(directory, 'rules.json'), 'utf8'),
    before,
    'validation and preview never mutate storage',
  );
  remote.set('Changed', {
    ...remote.get('Changed'),
    api: '7',
    antiCrawlerConfig: { ...captcha, captchaType: 3, captchaScript: 'window.verify()' },
  });
  const result = await post('update', {});
  assert.equal(result.status, 200);
  assert.equal(result.data.results.find(({ name }) => name === 'Working').status, 'updated');
  assert.equal(application.store.get('Working').enabled, false);
  for (const name of ['Script', 'Regex', 'Click', 'Invalid', 'Future', 'Changed']) {
    assert.equal(result.data.results.find((item) => item.name === name).status, 'incompatible');
    assert.deepEqual(
      application.store.get(name),
      normalizeRule(installed.find((item) => item.name === name)),
    );
  }
  assert.equal(result.data.results.find(({ name }) => name === 'Opaque').status, 'version-unknown');
  assert.equal(application.store.get('Downgrade').version, 'v2.0');
  const persisted = await readFile(join(directory, 'rules.json'), 'utf8');
  await post('update', { name: 'Script' });
  assert.equal(
    await readFile(join(directory, 'rules.json'), 'utf8'),
    persisted,
    'a wholly blocked update leaves the original file unchanged',
  );
});
