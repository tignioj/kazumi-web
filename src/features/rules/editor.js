export const formatRule = (rule) => JSON.stringify(rule, null, 2);

export function createRuleDraft() {
  return {
    name: '',
    version: '1.0',
    api: '9',
    type: 'anime',
    author: '',
    enabled: true,
    baseURL: '',
    searchMode: 'xpath',
    searchURL: '',
    searchList: '//article',
    searchName: '//a',
    searchResult: '//a',
    chapterMode: 'xpath',
    chapterRoads: '//ul',
    chapterResult: '//a',
    antiCrawlerConfig: { enabled: false },
  };
}

export function parseRuleDocument(content) {
  let rule;
  try {
    rule = JSON.parse(content);
  } catch (error) {
    throw new Error(`规则 JSON 格式错误：${error.message}`);
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule))
    throw new Error('规则编辑器需要单个 JSON 对象；批量规则请使用「导入规则」。');
  return rule;
}

export function ruleField(rule, path, fallback = '') {
  return path.split('.').reduce((value, key) => value?.[key], rule) ?? fallback;
}

// Copy only the edited branch so fields outside the form survive a round trip.
export function withRuleField(rule, path, value) {
  const [key, ...rest] = path.split('.');
  return {
    ...rule,
    [key]: rest.length ? withRuleField(rule?.[key], rest.join('.'), value) : value,
  };
}

export function applyJsonFields(rule, fields) {
  for (const [path, content] of Object.entries(fields)) {
    let value;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`${path} JSON 格式错误：${error.message}`);
    }
    if (
      !path.endsWith('.request.body') &&
      (!value || typeof value !== 'object' || Array.isArray(value))
    )
      throw new Error(`${path} 必须是 JSON 对象`);
    rule = withRuleField(rule, path, value);
  }
  return rule;
}
