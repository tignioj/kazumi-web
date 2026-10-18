import { HttpError } from '../../lib/http.js';
import { assertRuleCompatible, normalizeRule } from './validation.js';

export function compareRuleVersions(remote, local) {
  const parse = (value) => {
    const match =
      /^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
        String(value ?? '').trim(),
      );
    return match && { parts: match[1].split('.').map(BigInt), pre: match[2]?.split('.') };
  };
  const next = parse(remote);
  const previous = parse(local);
  if (!next || !previous) {
    if (String(remote ?? '').trim() === String(local ?? '').trim()) return 0;
    if (next && !String(local ?? '').trim()) return 1;
    return null; // Unknown formats must never be treated as a newer release.
  }
  for (let i = 0; i < Math.max(next.parts.length, previous.parts.length); i++) {
    const a = next.parts[i] ?? 0n;
    const b = previous.parts[i] ?? 0n;
    if (a !== b) return a > b ? 1 : -1;
  }
  if (!next.pre || !previous.pre) return next.pre ? -1 : previous.pre ? 1 : 0;
  for (let i = 0; i < Math.max(next.pre.length, previous.pre.length); i++) {
    const a = next.pre[i],
      b = previous.pre[i];
    if (a === b) continue;
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const numericA = /^\d+$/.test(a),
      numericB = /^\d+$/.test(b);
    if (numericA && numericB) {
      if (BigInt(a) !== BigInt(b)) return BigInt(a) > BigInt(b) ? 1 : -1;
    } else if (numericA !== numericB) return numericA ? -1 : 1;
    else return a > b ? 1 : -1;
  }
  return 0;
}

export const newerRuleVersion = (remote, local) => compareRuleVersions(remote, local) === 1;

export function availableRuleUpdates(installed, catalog) {
  const available = new Map(catalog.map((rule) => [rule.name.toLowerCase(), rule]));
  return installed.flatMap((local) => {
    const remote = available.get(local.name.toLowerCase());
    const version = remote?.version;
    if (
      !(
        (typeof version === 'string' && version.trim()) ||
        (typeof version === 'number' && Number.isFinite(version))
      ) ||
      !newerRuleVersion(version, local.version)
    )
      return [];
    return [{ name: local.name, version: String(version) }];
  });
}

export async function downloadOfficialRule(http, repository, name, options = {}) {
  const input = options.loadRule
    ? await options.loadRule(name)
    : await http.json(`${repository}${encodeURIComponent(name)}.json`);
  if (typeof input?.name === 'string' && input.name.toLowerCase() !== name.toLowerCase())
    throw new HttpError('规则仓库返回的名称与请求不一致', 502);
  await assertRuleCompatible(input, options);
  return normalizeRule(input, { validate: false });
}

const failure = (name, error) => ({
  name,
  status: error.code === 'RULE_INCOMPATIBLE' ? 'incompatible' : 'failed',
  message: error.message,
  ...(error.compatibility ? { compatibility: error.compatibility } : {}),
});
const unknownVersion = (name) => ({
  name,
  status: 'version-unknown',
  message: '版本号无法可靠比较，已保留当前规则；可核对后手动导入',
});

export async function checkInstalledRuleUpdates(store, http, repository, catalog, options = {}) {
  const available = new Map(catalog.map((rule) => [rule.name.toLowerCase(), rule]));
  const candidates = store.list().filter((local) => {
    const version = available.get(local.name.toLowerCase())?.version;
    return (
      version != null &&
      String(version).trim() &&
      ![-1, 0].includes(compareRuleVersions(version, local.version))
    );
  });
  const updates = [],
    blocked = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const results = await Promise.all(
      candidates.slice(i, i + 4).map(async (local) => {
        try {
          const rule = await downloadOfficialRule(
            http,
            repository,
            available.get(local.name.toLowerCase()).name,
            options,
          );
          const comparison = compareRuleVersions(rule.version, local.version);
          if (comparison === null) return { blocked: unknownVersion(local.name) };
          if (comparison !== 1) return {};
          return {
            update: {
              name: local.name,
              version: rule.version,
              compatibility: await assertRuleCompatible(rule, options),
            },
          };
        } catch (error) {
          return { blocked: failure(local.name, error) };
        }
      }),
    );
    for (const result of results) {
      if (result.update) updates.push(result.update);
      if (result.blocked) blocked.push(result.blocked);
    }
  }
  return { updates, blocked };
}

export async function updateInstalledRules(store, http, repository, catalog, name, options = {}) {
  const installed = name ? [store.get(name)] : store.list();
  const available = new Map(catalog.map((rule) => [rule.name.toLowerCase(), rule]));
  const replacements = new Map();
  const results = [];
  for (let i = 0; i < installed.length; i += 4) {
    results.push(
      ...(await Promise.all(
        installed.slice(i, i + 4).map(async (local) => {
          const remote = available.get(local.name.toLowerCase());
          const result = { name: local.name };
          if (!remote)
            return {
              ...result,
              status: 'unlisted',
              message: '官方目录未收录此规则，请重新导入或编辑更新',
            };
          try {
            const rule = await downloadOfficialRule(http, repository, remote.name, options);
            if (compareRuleVersions(rule.version, local.version) === null)
              return unknownVersion(local.name);
            if (!newerRuleVersion(rule.version, local.version))
              return { ...result, status: 'latest' };
            replacements.set(local.name.toLowerCase(), rule);
            return { ...result, status: 'updated', version: rule.version };
          } catch (error) {
            return failure(local.name, error);
          }
        }),
      )),
    );
  }
  const rules = replacements.size
    ? await store.update((current) =>
        current.map((local) => {
          const replacement = replacements.get(local.name.toLowerCase());
          if (!replacement || !newerRuleVersion(replacement.version, local.version)) return local;
          // Imported rules match the same catalog as installed rules. Preserve the
          // user's enabled state, including changes made while downloads were running.
          return { ...replacement, enabled: local.enabled };
        }),
      )
    : store.list();
  return { rules, results };
}
