import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyRulesUpdate,
  discoverRulesUpdate,
  readCatalog,
  verifyCatalog,
  rulesUpgradeBody,
} from '../../scripts/lib/kazumi-rules.mjs';

const previous = 'a'.repeat(40),
  commit = 'b'.repeat(40);
const old = { name: 'Changed', version: '1', searchList: '//article' };
const catalog = {
  repository: 'https://github.com/Predidit/KazumiRules',
  commit: previous,
  rules: [old, { name: 'Removed', version: '1' }],
};
function rulesApi(rules, { head = commit, index = rules, fail } = {}) {
  const calls = [];
  return {
    calls,
    api: async (path, options) => {
      calls.push(path);
      if (path === 'repos/Predidit/KazumiRules') return { default_branch: 'main' };
      if (path.endsWith('/commits/main')) return { sha: head };
      assert.ok(options.raw);
      assert.ok(path.endsWith(`?ref=${commit}`), 'All files must come from the resolved SHA');
      if (path.includes('/contents/index.json')) return JSON.stringify(index);
      if (fail) throw new Error('download interrupted');
      const name = decodeURIComponent(path.split('/contents/')[1].split('.json?')[0]);
      return JSON.stringify(rules.find((rule) => rule.name === name));
    },
  };
}

test('catalog updates capture additions, deletions and same-version content changes at one commit', async (t) => {
  const rules = [
    { name: '新增 空格', version: '1' },
    { ...old, searchList: '//section' },
  ];
  const { api, calls } = rulesApi(rules);
  const update = await discoverRulesUpdate(catalog, api);
  assert.deepEqual(update.changes, {
    added: ['新增 空格'],
    modified: ['Changed'],
    removed: ['Removed'],
  });
  assert.ok(calls.some((path) => path.includes(encodeURIComponent('新增 空格'))));
  const body = rulesUpgradeBody(update);
  assert.match(body, /searchList/);
  assert.match(body, /\/\/article/);
  assert.match(body, /\/\/section/);
  assert.match(body, /不修改用户已安装规则/);
  const root = await mkdtemp(join(tmpdir(), 'kazumi-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'server/defaults'), { recursive: true });
  await applyRulesUpdate(root, update);
  assert.deepEqual(await readCatalog(root), update.snapshot);
});

test('catalog monitoring ignores unrelated commits and index reordering', async () => {
  const rules = [...catalog.rules].reverse();
  assert.equal((await discoverRulesUpdate(catalog, rulesApi(rules).api)).available, false);
  const { api, calls } = rulesApi([], { head: previous });
  assert.equal((await discoverRulesUpdate(catalog, api)).available, false);
  assert.equal(calls.length, 2);
});

test('invalid or partial downloads cannot replace the saved catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kazumi-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'server/defaults'), { recursive: true });
  const path = join(root, 'server/defaults/official-rules.json');
  const original = JSON.stringify(catalog);
  await writeFile(path, original);
  for (const fixture of [
    rulesApi([old], { fail: true }),
    rulesApi([{ ...old, version: '2' }], { index: [old] }),
    rulesApi([old], { index: [{ name: '../outside', version: '1' }] }),
    rulesApi([old], { index: [old, { ...old, name: 'changed' }] }),
    rulesApi([old], { index: [] }),
  ])
    await assert.rejects(discoverRulesUpdate(catalog, fixture.api));
  assert.equal(await readFile(path, 'utf8'), original);
  assert.throws(() => verifyCatalog({ ...catalog, commit: 'main' }));
});
