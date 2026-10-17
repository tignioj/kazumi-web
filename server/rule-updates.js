import { HttpError } from './http.js';
import { normalizeRule } from './store.js';

export function newerRuleVersion(remote, local) {
  const parts = (value) =>
    /^\d+(?:\.\d+)*$/.test(String(value)) ? String(value).split('.').map(Number) : null;
  const next = parts(remote);
  const previous = parts(local);
  if (!next || !previous) return String(remote) !== String(local);
  for (let i = 0; i < Math.max(next.length, previous.length); i++) {
    const difference = (next[i] || 0) - (previous[i] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

export async function downloadOfficialRule(http, repository, name) {
  const rule = normalizeRule(await http.json(`${repository}${encodeURIComponent(name)}.json`));
  if (rule.name.toLowerCase() !== name.toLowerCase())
    throw new HttpError('规则仓库返回的名称与请求不一致', 502);
  return rule;
}

export async function updateInstalledRules(store, http, repository, catalog, name) {
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
            const rule = await downloadOfficialRule(http, repository, remote.name);
            if (!newerRuleVersion(rule.version, local.version))
              return { ...result, status: 'latest' };
            replacements.set(local.name.toLowerCase(), rule);
            return { ...result, status: 'updated', version: rule.version };
          } catch (error) {
            return { ...result, status: 'failed', message: error.message };
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
