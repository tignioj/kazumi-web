import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { github } from './kazumi-upstream.mjs';

export const rulesRepository = 'Predidit/KazumiRules';
const catalogPath = 'test/compatibility/official-rules.json';

function fieldChanges(before, after, prefix = '') {
  if (isDeepStrictEqual(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  )
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) => fieldChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  return [
    {
      field: prefix,
      before: before === undefined ? '(未设置)' : JSON.stringify(before),
      after: after === undefined ? '(移除)' : JSON.stringify(after),
    },
  ];
}

export function verifyCatalog(catalog) {
  assert.equal(catalog.repository, `https://github.com/${rulesRepository}`);
  assert.match(catalog.commit, /^[a-f0-9]{40}$/);
  assert.ok(Array.isArray(catalog.rules) && catalog.rules.length, 'Empty official catalog');
  const names = new Set();
  for (const rule of catalog.rules) {
    assert.ok(rule && typeof rule.name === 'string' && rule.name.trim());
    assert.ok(
      !/[\r\n/\\]/.test(rule.name) && !['.', '..'].includes(rule.name),
      'Invalid rule name',
    );
    assert.ok(!names.has(rule.name.toLowerCase()), 'Duplicate official rule name');
    names.add(rule.name.toLowerCase());
  }
}

export async function readCatalog(root) {
  const catalog = JSON.parse(await readFile(join(root, catalogPath), 'utf8'));
  verifyCatalog(catalog);
  return catalog;
}

export async function discoverRulesUpdate(catalog, api = github) {
  verifyCatalog(catalog);
  const repository = await api(`repos/${rulesRepository}`);
  const { sha } = await api(
    `repos/${rulesRepository}/commits/${encodeURIComponent(repository.default_branch)}`,
  );
  assert.match(sha, /^[a-f0-9]{40}$/);
  if (sha === catalog.commit) return { available: false, source: 'rules', commit: sha };
  const source = async (path) =>
    JSON.parse(await api(`repos/${rulesRepository}/contents/${path}?ref=${sha}`, { raw: true }));
  const index = await source('index.json');
  // Check names before using them as paths; fetch the entire catalog at one immutable SHA.
  verifyCatalog({ repository: catalog.repository, commit: sha, rules: index });
  assert.ok(index.length <= 500, 'Official catalog exceeds the review limit');
  const rules = [];
  for (let i = 0; i < index.length; i += 4) {
    rules.push(
      ...(await Promise.all(
        index.slice(i, i + 4).map(async ({ name, version }) => {
          const rule = await source(`${encodeURIComponent(name)}.json`);
          assert.equal(rule.name, name, 'Index and rule name differ');
          assert.equal(String(rule.version), String(version), 'Index and rule version differ');
          return rule;
        }),
      )),
    );
  }
  rules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const previous = new Map(catalog.rules.map((rule) => [rule.name, rule]));
  const next = new Map(rules.map((rule) => [rule.name, rule]));
  const changes = {
    added: [...next.keys()].filter((name) => !previous.has(name)),
    modified: [...next.keys()].filter(
      (name) => previous.has(name) && !isDeepStrictEqual(next.get(name), previous.get(name)),
    ),
    removed: [...previous.keys()].filter((name) => !next.has(name)),
  };
  if (!Object.values(changes).some((names) => names.length))
    return { available: false, source: 'rules', commit: sha };
  const snapshot = { repository: catalog.repository, commit: sha, rules };
  verifyCatalog(snapshot);
  return {
    available: true,
    source: 'rules',
    commit: sha,
    previous: catalog.commit,
    changes,
    details: [...new Set([...changes.added, ...changes.modified, ...changes.removed])].map(
      (name) => ({
        name,
        beforeVersion: previous.get(name)?.version ?? null,
        afterVersion: next.get(name)?.version ?? null,
        fields: fieldChanges(previous.get(name) || {}, next.get(name) || {}),
      }),
    ),
    snapshot,
    compareUrl: `https://github.com/${rulesRepository}/compare/${catalog.commit}...${sha}`,
  };
}

export async function applyRulesUpdate(root, update) {
  assert.equal(update.available, true);
  verifyCatalog(update.snapshot);
  await writeFile(join(root, catalogPath), `${JSON.stringify(update.snapshot, null, 2)}\n`);
}
