import ipaddr from 'ipaddr.js';

export const DEFAULT_NETWORK_SETTINGS = {
  videoProxy: false,
  imageProxy: false,
  bangumiProxy: false,
  rulesProxy: false,
  archiveProxy: false,
  url: '',
  username: '',
  password: '',
  bangumiEch: false,
  imageAcceleration: 'direct',
  echDohUrl: 'https://1.1.1.1/dns-query',
  proxies: [],
  scopeProxies: {},
  routingRules: [],
};

export const PROXY_SCOPES = {
  video: 'videoProxy',
  image: 'imageProxy',
  bangumi: 'bangumiProxy',
  rules: 'rulesProxy',
  archive: 'archiveProxy',
};

// Transport settings are scoped by request purpose, including every redirect.
export function proxySettingsFor(settings, scope, { url, hostname } = {}) {
  if (!hostname && url) {
    try {
      hostname = new URL(url).hostname;
    } catch {}
  }
  hostname = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const knownScope = Object.hasOwn(PROXY_SCOPES, scope ?? '');
  const rule =
    knownScope && hostname
      ? settings?.routingRules?.find(
          (rule) =>
            rule.enabled &&
            (rule.scope === 'all' || rule.scope === scope) &&
            matchesHost(rule, hostname),
        )
      : null;
  const enabled = rule
    ? rule.action === 'proxy'
    : knownScope && settings?.[PROXY_SCOPES[scope]] === true;
  const proxyId = rule?.proxyId || settings?.scopeProxies?.[scope] || 'default';
  const proxy =
    proxyId === 'default' ? settings : settings?.proxies?.find((proxy) => proxy.id === proxyId);
  return {
    url: proxy?.url || '',
    username: proxy?.username || '',
    password: proxy?.password || '',
    enabled,
    bangumiEch: scope === 'bangumi' && settings?.bangumiEch === true,
    echDohUrl: settings?.echDohUrl,
    routing: {
      scope,
      hostname,
      action: enabled ? 'proxy' : 'direct',
      proxyId: enabled ? proxyId : null,
      proxyName: enabled ? (proxyId === 'default' ? '默认代理' : proxy?.name) : null,
      ruleId: rule?.id || null,
      ruleName: rule?.name || null,
    },
  };
}

function matchesHost(rule, hostname) {
  switch (rule.matchType) {
    case 'all':
      return true;
    case 'domain':
      return hostname === rule.value;
    case 'domainSuffix':
      return hostname === rule.value || hostname.endsWith(`.${rule.value}`);
    case 'domainKeyword':
      return hostname.includes(rule.value);
    case 'cidr':
      try {
        const address = ipaddr.process(hostname);
        const [network, prefix] = ipaddr.parseCIDR(rule.value);
        return address.kind() === network.kind() && address.match(network, prefix);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function normalizedHost(value) {
  const host = new URL(`http://${value}`).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    !host ||
    /[\s/@:?#*]/.test(value) ||
    host.length > 253 ||
    host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    throw new Error('分流规则的域名无效，请填写不含协议、端口或路径的域名');
  return host;
}

function normalizeProxy(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('代理配置格式无效');
  const result = {};
  for (const key of ['url', 'username', 'password']) {
    const value = input[key] === undefined ? (previous[key] ?? '') : input[key];
    if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/.test(value))
      throw new Error('代理地址或认证信息无效');
    result[key] = key === 'url' ? value.trim() : value;
  }
  if (result.username.includes(':')) throw new Error('代理用户名不能包含冒号');
  if (result.password && !result.username) throw new Error('填写代理密码时需要提供用户名');
  if (result.url) {
    let url;
    try {
      url = new URL(result.url);
    } catch {
      throw new Error('代理地址无效，请填写完整地址，例如 http://127.0.0.1:7890');
    }
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname)
      throw new Error('代理仅支持 HTTP、HTTPS 或 SOCKS5');
    if (url.port === '0') throw new Error('代理端口必须在 1 到 65535 之间');
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
      throw new Error('代理地址不能包含路径、参数或认证信息，请在下方填写用户名与密码');
    if (
      url.protocol === 'socks5:' &&
      [result.username, result.password].some(
        (value) => new TextEncoder().encode(value).length > 255,
      )
    )
      throw new Error('SOCKS5 用户名与密码不能超过 255 字节');
    result.url = url.href;
  }
  return result;
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new Error('代理或分流规则的 ID 无效');
  return value;
}

function displayName(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 100 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('代理或分流规则的名称无效');
  return value.trim() || fallback;
}

export function normalizeNetworkSettings(input, previous = DEFAULT_NETWORK_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('网络设置格式无效');
  if (input.enabled !== undefined) throw new Error('全局代理已移除，请分别设置各类请求的代理');
  const result = {};
  for (const key of Object.values(PROXY_SCOPES)) {
    result[key] = input[key] === undefined ? previous[key] : input[key];
    if (typeof result[key] !== 'boolean') throw new Error('请选择是否启用各类请求的代理');
  }
  Object.assign(result, normalizeProxy(input, previous));
  const proxies = input.proxies === undefined ? (previous.proxies ?? []) : input.proxies;
  if (!Array.isArray(proxies) || proxies.length > 16) throw new Error('最多配置 16 个额外代理');
  const ids = new Set(['default']);
  result.proxies = proxies.map((proxy, index) => {
    const id = identifier(proxy?.id);
    if (ids.has(id)) throw new Error('代理 ID 不可重复');
    ids.add(id);
    const normalized = normalizeProxy(
      proxy,
      previous.proxies?.find((item) => item.id === id),
    );
    if (!normalized.url) throw new Error('请填写额外代理的地址');
    return { id, name: displayName(proxy.name, `代理 ${index + 1}`), ...normalized };
  });
  const scopeProxies =
    input.scopeProxies === undefined ? (previous.scopeProxies ?? {}) : input.scopeProxies;
  if (
    !scopeProxies ||
    typeof scopeProxies !== 'object' ||
    Array.isArray(scopeProxies) ||
    Object.keys(scopeProxies).some((key) => !Object.hasOwn(PROXY_SCOPES, key))
  )
    throw new Error('默认代理类型无效');
  result.scopeProxies = {};
  const requireProxy = (id) => {
    if (!ids.has(id)) throw new Error('所选代理不存在，请先调整引用它的默认策略或分流规则');
    if (id === 'default' && !result.url) throw new Error('启用网络代理前请填写代理地址');
  };
  for (const [scope, id] of Object.entries(scopeProxies)) {
    if (!ids.has(id)) throw new Error('默认策略引用了不存在的代理');
    if (id !== 'default') result.scopeProxies[scope] = id;
  }
  for (const [scope, key] of Object.entries(PROXY_SCOPES))
    if (result[key]) requireProxy(result.scopeProxies[scope] || 'default');
  const rules =
    input.routingRules === undefined ? (previous.routingRules ?? []) : input.routingRules;
  if (!Array.isArray(rules) || rules.length > 200) throw new Error('最多配置 200 条分流规则');
  const ruleIds = new Set();
  result.routingRules = rules.map((rule, index) => {
    const id = identifier(rule?.id);
    if (ruleIds.has(id)) throw new Error('分流规则 ID 不可重复');
    ruleIds.add(id);
    const enabled = rule.enabled === undefined ? true : rule.enabled;
    if (typeof enabled !== 'boolean') throw new Error('请选择是否启用分流规则');
    if (rule.scope !== 'all' && !Object.hasOwn(PROXY_SCOPES, rule.scope ?? ''))
      throw new Error('分流规则的请求类型无效');
    if (!['all', 'domain', 'domainSuffix', 'domainKeyword', 'cidr'].includes(rule.matchType))
      throw new Error('分流匹配方式无效');
    if (!['proxy', 'direct'].includes(rule.action)) throw new Error('分流出口无效');
    let value = rule.value;
    if (typeof value !== 'string' || value.length > 253 || /[\x00-\x20\x7f]/.test(value))
      throw new Error('分流匹配内容无效');
    if (rule.matchType === 'all') value = '';
    else if (rule.matchType === 'cidr') {
      try {
        const [address, prefix] = ipaddr.parseCIDR(value);
        value = `${address.toString()}/${prefix}`;
      } catch {
        throw new Error('IP 网段无效，请填写如 203.0.113.0/24 或 2001:db8::/32');
      }
    } else if (rule.matchType === 'domainKeyword') {
      if (!value || /[/:?#@*]/.test(value)) throw new Error('域名关键字无效');
      value = value.toLowerCase();
    } else value = normalizedHost(value.replace(/^(?:\*\.|\.)/, ''));
    const proxyId = rule.action === 'proxy' ? rule.proxyId || 'default' : 'default';
    if (rule.action === 'proxy') {
      if (!ids.has(proxyId)) throw new Error('分流规则引用了不存在的代理');
      if (enabled) requireProxy(proxyId);
    }
    return {
      id,
      name: displayName(rule.name, `分流规则 ${index + 1}`),
      enabled,
      scope: rule.scope,
      matchType: rule.matchType,
      value,
      action: rule.action,
      proxyId,
    };
  });
  result.bangumiEch =
    input.bangumiEch === undefined
      ? (previous.bangumiEch ?? DEFAULT_NETWORK_SETTINGS.bangumiEch)
      : input.bangumiEch;
  if (typeof result.bangumiEch !== 'boolean') throw new Error('请选择是否启用 Bangumi ECH');
  result.imageAcceleration = input.imageAcceleration ?? previous.imageAcceleration;
  if (
    input.imageAcceleration === null ||
    !['mirror', 'ech', 'direct'].includes(result.imageAcceleration)
  )
    throw new Error('封面请求方式仅支持镜像、ECH 或直连');
  const echDohUrl =
    input.echDohUrl === undefined
      ? (previous.echDohUrl ?? DEFAULT_NETWORK_SETTINGS.echDohUrl)
      : input.echDohUrl;
  if (typeof echDohUrl !== 'string' || echDohUrl.length > 2048 || /[\r\n\0]/.test(echDohUrl))
    throw new Error('ECH DNS 地址无效');
  let endpoint;
  try {
    endpoint = new URL(echDohUrl.trim());
  } catch {
    throw new Error('ECH DNS 地址无效，请填写完整的 HTTPS 地址');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error('ECH DNS 仅支持不含认证信息和片段的 HTTPS 地址');
  result.echDohUrl = endpoint.href;
  return result;
}
