import { HttpError, checkedUrl } from '../../lib/http.js';

// Version is reported by the pinned core service; this is only the storage envelope.
export const RULE_API_VERSION = 8;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeRule(input, { validate = true, ...options } = {}) {
  if (!isObject(input)) throw new HttpError('每条规则必须是 JSON 对象');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)
    throw new HttpError('规则名称不能为空且不能超过 100 个字符');
  const api = input.api ?? 1;
  if (
    !['string', 'number'].includes(typeof api) ||
    !Number.isInteger(Number(api)) ||
    Number(api) < 1
  )
    throw new HttpError(`规则 API 版本不受支持（最高 ${RULE_API_VERSION}）`);
  const rule = {
    type: 'anime',
    version: '',
    searchMode: 'xpath',
    chapterMode: 'xpath',
    ...input,
    name: input.name.trim(),
    api: String(Number(api)),
    enabled: input.enabled ?? true,
  };
  if (rule.version == null) rule.version = '';
  else if (typeof rule.version === 'number' && Number.isFinite(rule.version))
    rule.version = String(rule.version);
  if (typeof rule.version !== 'string' || rule.version.length > 100)
    throw new HttpError('version 必须是文本或有限数字，长度不能超过 100 个字符');
  rule.version = rule.version.trim();
  for (const field of ['type', 'author']) {
    if (rule[field] != null && typeof rule[field] !== 'string')
      throw new HttpError(`${field} 必须是文本`);
  }
  rule.type ??= 'anime';
  rule.author ??= '';
  if (typeof rule.baseURL !== 'string') throw new HttpError('规则缺少 baseURL');
  checkedUrl(rule.baseURL, { allowPrivate: true });

  return rule;
}

export function ruleCompatibility(input) {
  try {
    const rule = normalizeRule(input, { validate: false });
    return {
      compatible: true,
      api: rule.api,
      requiredApi: Number(rule.api),
      requirements: [],
      issues: [],
    };
  } catch (error) {
    return {
      compatible: false,
      api: null,
      requiredApi: null,
      requirements: [],
      issues: [{ code: 'INVALID_RULE_CONFIG', field: '', message: error.message }],
    };
  }
}

export async function assertRuleCompatible(rule, { core } = {}) {
  if (!core) throw new HttpError('Kazumi 核心服务未配置', 503);
  try {
    const [normalized] = await core.validate(rule);
    return ruleCompatibility(normalized);
  } catch (error) {
    if (error.status === 400) {
      error.code = 'RULE_INCOMPATIBLE';
      error.compatibility = { compatible: false, issues: [{ message: error.message }] };
    }
    throw error;
  }
}
