import { HttpError } from '../../lib/http.js';

export function createOfficialRulesCatalog(http) {
  const repository = (
    process.env.RULES_REPOSITORY || 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/'
  ).replace(/\/?$/, '/');
  let catalogCache;
  let generation = 0;
  const details = new Map();
  const pending = new Map();
  async function officialRules(refresh = false) {
    if (!refresh && catalogCache && catalogCache.expires > Date.now()) return catalogCache.rules;
    if (refresh) {
      generation++;
      details.clear();
      pending.clear();
    }
    const rules = await http.json(`${repository}index.json`);
    if (!Array.isArray(rules)) throw new HttpError('规则仓库索引无效', 502);
    catalogCache = {
      rules: rules.filter((rule) => typeof rule?.name === 'string' && rule.name.trim()),
      expires: Date.now() + 60 * 60 * 1000,
    };
    return catalogCache.rules;
  }
  async function officialRule(name, refresh = false) {
    const key = name.toLowerCase();
    const cached = details.get(key);
    if (!refresh && cached?.expires > Date.now()) return structuredClone(cached.rule);
    if (refresh || !pending.has(key)) {
      const started = generation;
      const operation = Promise.resolve()
        .then(() => http.json(`${repository}${encodeURIComponent(name)}.json`))
        .then((rule) => {
          if (started === generation && pending.get(key) === operation) {
            if (details.size >= 500) details.delete(details.keys().next().value);
            details.set(key, { rule: structuredClone(rule), expires: Date.now() + 60 * 60 * 1000 });
          }
          return rule;
        })
        .finally(() => {
          if (pending.get(key) === operation) pending.delete(key);
        });
      pending.set(key, operation);
    }
    return structuredClone(await pending.get(key));
  }
  return { repository, officialRules, officialRule };
}
