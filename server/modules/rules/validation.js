import { JSDOM } from 'jsdom';
import { HttpError, checkedUrl } from '../../lib/http.js';
import { normalizeJsonPath, prepareApiRequest, renderTemplate } from './engine.js';

export const RULE_API_VERSION = 9;
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
  if (validate) assertRuleCompatible(rule, options);
  return rule;
}

// A level is an upper bound, not a promise that every feature of that level runs
// in Web. Keep this report separate from the JSON that is stored and exported.
export function ruleCompatibility(input, { dynamicResolver = true } = {}) {
  const issues = [];
  const requirements = [];
  let requiredApi = 1;
  let rule;
  const issue = (field, message, code = 'INVALID_RULE_CONFIG') =>
    issues.push({ code, field, message });
  try {
    rule = normalizeRule(input, { validate: false });
  } catch (error) {
    return {
      compatible: false,
      api: null,
      requiredApi,
      requirements,
      issues: [{ code: 'INVALID_RULE_CONFIG', field: '', message: error.message }],
    };
  }
  const check = (field, operation) => {
    try {
      operation();
    } catch (error) {
      issue(field, `${field}：${error.message}`);
    }
  };
  const string = (value, field, fallback = '') => {
    if (value == null) return fallback;
    if (typeof value !== 'string') {
      issue(field, `${field} 必须是文本`);
      return fallback;
    }
    return value;
  };
  const object = (value, field, required = false) => {
    if (value == null && !required) return {};
    if (!isObject(value)) {
      issue(field, `${field} 必须是 JSON 对象`);
      return {};
    }
    return value;
  };
  const level = (value) => {
    requiredApi = Math.max(requiredApi, value);
  };
  for (const field of [
    'enabled',
    'muliSources',
    'useWebview',
    'useNativePlayer',
    'usePost',
    'useLegacyParser',
    'adBlocker',
  ]) {
    if (rule[field] != null && typeof rule[field] !== 'boolean')
      issue(field, `${field} 必须是布尔值`);
  }
  for (const field of [
    'searchURL',
    'searchList',
    'searchName',
    'searchResult',
    'chapterRoads',
    'chapterResult',
    'referer',
    'userAgent',
  ])
    string(rule[field], field);
  for (const field of ['searchMode', 'chapterMode']) {
    if (!['xpath', 'api'].includes(rule[field])) issue(field, `${field} 必须是 xpath 或 api`);
  }
  if (rule.usePost === true) level(2);
  if (rule.useLegacyParser === true || (typeof rule.referer === 'string' && rule.referer.trim()))
    level(3);
  if (rule.adBlocker === true) level(5);
  if (typeof rule.referer === 'string' && rule.referer.trim())
    check('referer', () => checkedUrl(rule.referer, { allowPrivate: true }));
  if (typeof rule.userAgent === 'string' && /[\r\n]/.test(rule.userAgent))
    issue('userAgent', 'userAgent 不能包含换行');

  let dom;
  const xpath = (value, field, required = false) => {
    const expression = string(value, field).trim();
    if (!expression) {
      if (required) issue(field, `${field} XPath 不能为空`);
      return;
    }
    if (expression === '//') return;
    check(field, () => {
      dom ??= new JSDOM('<html><body></body></html>');
      const result = dom.window.document.evaluate(expression, dom.window.document, null, 0, null);
      if (result.resultType < 4 && !(field === 'searchName' && result.resultType === 2))
        throw new HttpError('XPath 必须选择节点；searchName 也可以返回文本');
    });
  };
  const path = (value, field, fallback, optional = false) => {
    let expression = string(value, field, fallback);
    if (optional) expression = expression.trim();
    if (!optional || expression) check(field, () => normalizeJsonPath(expression));
  };
  const request = (value, field, active, variables) => {
    const config = object(value, field, active);
    const method = string(config.method, `${field}.method`, 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method))
      issue(`${field}.method`, `${field}.method 仅支持 GET/POST`);
    const url = string(config.url, `${field}.url`);
    if (active && !url.trim()) issue(`${field}.url`, `${field}.url 不能为空`);
    for (const key of ['headers', 'query']) object(config[key], `${field}.${key}`);
    if (!['none', 'json', 'form'].includes(config.bodyType ?? 'none'))
      issue(`${field}.bodyType`, `${field}.bodyType 必须是 none、json 或 form`);
    if (config.bodyType === 'form' && config.body != null)
      object(config.body, `${field}.body`, true);
    if (url && isObject(config.headers ?? {}) && isObject(config.query ?? {}))
      check(field, () => {
        const prepared = prepareApiRequest(config, variables);
        new Headers(prepared.headers);
      });
  };
  try {
    if (rule.searchMode === 'xpath') {
      const url = string(rule.searchURL, 'searchURL');
      if (!url.trim()) issue('searchURL', 'searchURL 不能为空');
      else
        check('searchURL', () =>
          checkedUrl(renderTemplate(url, { keyword: 'validation' }, true), { allowPrivate: true }),
        );
      for (const field of ['searchList', 'searchName', 'searchResult'])
        xpath(rule[field], field, true);
    }
    if (rule.chapterMode === 'xpath')
      for (const field of ['chapterRoads', 'chapterResult']) xpath(rule[field], field, true);

    if (rule.searchApiConfig != null || rule.searchMode === 'api') {
      const active = rule.searchMode === 'api';
      const config = object(rule.searchApiConfig, 'searchApiConfig', active);
      if (active) level(8);
      request(config.request, 'searchApiConfig.request', active, { keyword: 'validation' });
      path(config.listPath, 'searchApiConfig.listPath', '$.data[*]');
      path(config.namePath, 'searchApiConfig.namePath', '$.name');
      path(config.sourcePath, 'searchApiConfig.sourcePath', '$.url');
      const template = string(config.sourceTemplate, 'searchApiConfig.sourceTemplate').trim();
      if (template) {
        if (active) level(9);
        if (!template.includes('@source'))
          issue('searchApiConfig.sourceTemplate', '详情页地址模板必须引用 @source');
        else
          check('searchApiConfig.sourceTemplate', () =>
            checkedUrl(new URL(template.replaceAll('@source', 'validation'), rule.baseURL).href, {
              allowPrivate: true,
            }),
          );
      }
    }
    if (rule.chapterApiConfig != null || rule.chapterMode === 'api') {
      const active = rule.chapterMode === 'api';
      const config = object(rule.chapterApiConfig, 'chapterApiConfig', active);
      if (active) level(8);
      request(config.request, 'chapterApiConfig.request', active, { source: 'validation' });
      const format = config.format ?? 'nested';
      if (!['nested', 'delimited'].includes(format))
        issue('chapterApiConfig.format', 'chapterApiConfig.format 必须是 nested 或 delimited');
      const variables = object(config.variables, 'chapterApiConfig.variables');
      const scope = {
        source: 'validation',
        episodeUrl: 'validation',
        roadIndex: 0,
        roadNumber: 1,
        episodeIndex: 0,
        episodeNumber: 1,
      };
      for (const [key, value] of Object.entries(variables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          issue('chapterApiConfig.variables', `无效的模板变量名 ${key}`);
        path(value, `chapterApiConfig.variables.${key}`, '');
        scope[key] = 'validation';
      }
      if (format === 'delimited') {
        for (const field of ['roadNamesPath', 'roadEpisodesPath'])
          path(config[field], `chapterApiConfig.${field}`, '');
        for (const [field, fallback] of [
          ['roadSeparator', '$$$'],
          ['episodeSeparator', '#'],
          ['fieldSeparator', '$'],
        ]) {
          if (!string(config[field], `chapterApiConfig.${field}`, fallback))
            issue(`chapterApiConfig.${field}`, '章节分隔符不能为空');
        }
      } else {
        for (const [field, fallback, optional] of [
          ['roadsPath', '$.data.roads[*]', true],
          ['roadNamePath', '$.name', true],
          ['episodesPath', '$.episodes[*]', false],
          ['episodeNamePath', '$.name', false],
          ['episodeUrlPath', '$.url', true],
        ])
          path(config[field], `chapterApiConfig.${field}`, fallback, optional);
        if (config.episodeUrlPath?.trim?.() === '' && config.episodePage == null)
          issue('chapterApiConfig.episodeUrlPath', '必须配置播放入口地址路径或播放页地址模板');
      }
      if (config.episodePage != null) {
        const page = object(config.episodePage, 'chapterApiConfig.episodePage', true);
        const url = string(page.url, 'chapterApiConfig.episodePage.url');
        if (!url.trim()) issue('chapterApiConfig.episodePage.url', '播放页地址模板不能为空');
        const query = object(page.query, 'chapterApiConfig.episodePage.query');
        check('chapterApiConfig.episodePage', () => {
          checkedUrl(new URL(renderTemplate(url, scope, true), rule.baseURL).href, {
            allowPrivate: true,
          });
          prepareApiRequest(
            { url: new URL(renderTemplate(url, scope, true), rule.baseURL).href, query },
            scope,
          );
        });
      }
    }
    if (rule.antiCrawlerConfig != null) {
      const config = object(rule.antiCrawlerConfig, 'antiCrawlerConfig');
      if (config.enabled != null && typeof config.enabled !== 'boolean')
        issue('antiCrawlerConfig.enabled', 'antiCrawlerConfig.enabled 必须是布尔值');
      for (const field of [
        'captchaImage',
        'captchaInput',
        'captchaButton',
        'captchaDetectValue',
        'captchaScript',
      ])
        string(config[field], `antiCrawlerConfig.${field}`);
      const type = config.captchaType ?? 1;
      const detect = config.captchaDetectType ?? 1;
      const detectValue =
        typeof config.captchaDetectValue === 'string' ? config.captchaDetectValue.trim() : '';
      if (![1, 2, 3].includes(type))
        issue('antiCrawlerConfig.captchaType', 'captchaType 必须是 1、2 或 3');
      if (![1, 2, 3, 'xpath', 'text', 'regex'].includes(detect))
        issue(
          'antiCrawlerConfig.captchaDetectType',
          'captchaDetectType 必须是 xpath、text 或 regex 对应的检测类型',
        );
      if (config.enabled === true) {
        level(6);
        requirements.push('dynamicResolver');
        if (!dynamicResolver)
          issue(
            'antiCrawlerConfig',
            '该规则需要 Chromium 人工验证，请启用动态解析并安装 Chromium',
            'DYNAMIC_RESOLVER_REQUIRED',
          );
        if (type === 2)
          issue(
            'antiCrawlerConfig.captchaType',
            'Web 暂不支持自动点击验证，请改用人工验证规则',
            'UNSUPPORTED_CAPABILITY',
          );
        if (type === 3)
          issue(
            'antiCrawlerConfig.captchaScript',
            'Web 不支持执行规则自定义验证脚本',
            'UNSUPPORTED_CAPABILITY',
          );
        if (type === 3 || detectValue) level(7);
        if (detectValue && [3, 'regex'].includes(detect))
          issue(
            'antiCrawlerConfig.captchaDetectType',
            'Web 不支持规则正则验证码检测',
            'UNSUPPORTED_CAPABILITY',
          );
        if (type === 1)
          for (const field of ['captchaImage', 'captchaInput', 'captchaButton'])
            xpath(config[field], `antiCrawlerConfig.${field}`, true);
        if ([1, 'xpath'].includes(detect))
          xpath(config.captchaDetectValue, 'antiCrawlerConfig.captchaDetectValue');
      }
    }
  } finally {
    dom?.window.close();
  }
  if (Number(rule.api) > RULE_API_VERSION)
    issue('api', `规则 API 版本不受支持（最高 ${RULE_API_VERSION}）`, 'UNSUPPORTED_API');
  if (Number(rule.api) < requiredApi)
    issue(
      'api',
      `规则使用的功能至少要求 API ${requiredApi}，当前声明 API ${rule.api}`,
      'API_LEVEL_MISMATCH',
    );
  return { compatible: issues.length === 0, api: rule.api, requiredApi, requirements, issues };
}

export function assertRuleCompatible(rule, options) {
  const compatibility = ruleCompatibility(rule, options);
  if (!compatibility.compatible) {
    const error = new HttpError(compatibility.issues.map((issue) => issue.message).join('；'));
    error.code = 'RULE_INCOMPATIBLE';
    error.compatibility = compatibility;
    throw error;
  }
  return compatibility;
}
