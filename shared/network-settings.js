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
};

export const PROXY_SCOPES = {
  video: 'videoProxy',
  image: 'imageProxy',
  bangumi: 'bangumiProxy',
  rules: 'rulesProxy',
  archive: 'archiveProxy',
};

// Transport settings are scoped by request purpose, including every redirect.
export function proxySettingsFor(settings, scope) {
  return {
    ...settings,
    enabled: settings?.[PROXY_SCOPES[scope]] === true,
    bangumiEch: scope === 'bangumi' && settings?.bangumiEch === true,
  };
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
  for (const key of ['url', 'username', 'password']) {
    const value = input[key] === undefined ? previous[key] : input[key];
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
  } else if (Object.values(PROXY_SCOPES).some((key) => result[key])) {
    throw new Error('启用网络代理前请填写代理地址');
  }
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
