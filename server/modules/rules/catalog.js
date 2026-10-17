import { HttpError } from '../../lib/http.js';

export function createOfficialRulesCatalog(http) {
  const repository = (
    process.env.RULES_REPOSITORY || 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/'
  ).replace(/\/?$/, '/');
  let catalogCache;
  async function officialRules(refresh = false) {
    if (!refresh && catalogCache && catalogCache.expires > Date.now()) return catalogCache.rules;
    const rules = await http.json(`${repository}index.json`);
    if (!Array.isArray(rules)) throw new HttpError('规则仓库索引无效', 502);
    catalogCache = {
      rules: rules.filter((rule) => typeof rule.name === 'string'),
      expires: Date.now() + 60 * 60 * 1000,
    };
    return catalogCache.rules;
  }
  return { repository, officialRules };
}
