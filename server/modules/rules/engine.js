import { JSDOM } from 'jsdom';
import { sourceFailure } from './errors.js';
import { JSONPath } from 'jsonpath-plus';
import { HttpError, checkedUrl, readLimited } from '../../lib/http.js';
import {
  hasChallenge,
  hasChallengeHeaders,
  inspectStaticChallenge,
  verificationRequired,
} from '../verification/challenge.js';
import { hasAutomaticCaptcha } from '../verification/automation.js';

const scalar = (value) => (value == null ? '' : String(value).trim());
export function absoluteUrl(value, base) {
  if (!scalar(value)) return '';
  try {
    return checkedUrl(new URL(scalar(value), base).href, { allowPrivate: true }).href;
  } catch {
    return '';
  }
}

// Match the pinned Kazumi episode identity rules without changing signed media URLs.
export function normalizeEpisodeUrl(value, base) {
  const resolved = absoluteUrl(value, base);
  if (!resolved) return '';
  const url = new URL(resolved),
    origin = new URL(base);
  if (url.host === origin.host) url.protocol = origin.protocol;
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!url.search) url.search = '';
  if (!url.hash) url.hash = '';
  // Dart Uri decodes only unreserved characters and canonicalizes the other
  // escapes. This is episode identity normalization, never media URL rewriting.
  return url.href.replace(/%(?:[a-f\d]{2})?/gi, (escape) => {
    if (escape.length === 1) return '%25';
    const character = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /^[A-Za-z\d._~-]$/.test(character) ? character : escape.toUpperCase();
  });
}

export function normalizeJsonPath(expression) {
  // Match Kazumi's deliberately small JSONPath grammar. Filters/scripts and
  // recursive descent are excluded, even though jsonpath-plus supports them.
  if (typeof expression !== 'string' || !expression.startsWith('$'))
    throw new HttpError(`不支持的 JSONPath: ${expression}`);
  let remaining = expression.slice(1);
  let path = '$';
  while (remaining) {
    const token =
      /^(\.[A-Za-z0-9_$-]+|\[\s*(\d+|\*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\])/.exec(remaining);
    if (!token) throw new HttpError(`不支持的 JSONPath: ${expression}`);
    path += token[2] === undefined ? token[1] : `[${token[2]}]`;
    remaining = remaining.slice(token[0].length);
  }
  return path;
}

export function readPath(document, expression) {
  const path = normalizeJsonPath(expression);
  if (document == null) return [];
  return JSONPath({ path, json: document, eval: false }) ?? [];
}
const first = (document, expression) => readPath(document, expression)[0];

export function renderTemplate(template, variables, encode = false) {
  return String(template).replace(/(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (!Object.hasOwn(variables, name)) throw new HttpError(`缺少模板变量 @${name}`);
    const value = String(variables[name] ?? '');
    return encode ? encodeURIComponent(value) : value;
  });
}
export function renderValue(value, variables) {
  if (typeof value === 'string') {
    const exact = /^@([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (exact) {
      if (!Object.hasOwn(variables, exact[1])) throw new HttpError(`缺少模板变量 ${value}`);
      return variables[exact[1]];
    }
    return renderTemplate(value, variables);
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, variables));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, variables)]),
    );
  return value;
}

const encodeQueryComponent = (value) =>
  encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll('%20', '+');

// Dio's default ListFormat.multi repeats scalar keys and indexes collections.
// Null is a bare key; empty maps/lists emit no parameters. Query brackets stay
// literal, while form brackets are percent-encoded.
function encodeParameters(parameters, query = false) {
  const parts = [];
  const left = query ? '[' : '%5B';
  const right = query ? ']' : '%5D';
  const collection = (value) => value !== null && typeof value === 'object';
  const visit = (value, path) => {
    if (Array.isArray(value))
      value.forEach((item, index) =>
        visit(item, collection(item) ? `${path}${left}${index}${right}` : path),
      );
    else if (collection(value))
      for (const [key, item] of Object.entries(value))
        visit(
          item,
          path ? `${path}${left}${encodeQueryComponent(key)}${right}` : encodeQueryComponent(key),
        );
    else parts.push(value == null ? path : `${path}=${encodeQueryComponent(value)}`);
  };
  visit(parameters, '');
  return parts.join('&');
}

export function prepareApiRequest(config, variables) {
  if (!config?.url) throw new HttpError('API 请求缺少 URL');
  const method = String(config.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new HttpError('API 规则仅支持 GET 或 POST');
  const url = checkedUrl(renderTemplate(config.url, variables, true), { allowPrivate: true });
  const query = encodeParameters(
    Object.fromEntries(
      Object.entries(config.query || {}).map(([key, value]) => [
        renderTemplate(key, variables),
        renderValue(value, variables),
      ]),
    ),
    true,
  );
  // Dio appends its query map to the URL's own query, including duplicate keys.
  if (query) url.search += `${url.search ? '&' : '?'}${query}`;
  const headers = Object.fromEntries(
    Object.entries(config.headers || {}).map(([key, value]) => [
      renderTemplate(key, variables).toLowerCase(),
      String(renderValue(value, variables)),
    ]),
  );
  let body;
  if (method === 'POST' && config.bodyType === 'json') {
    body = JSON.stringify(renderValue(config.body, variables));
    headers['content-type'] ??= 'application/json';
  }
  if (method === 'POST' && config.bodyType === 'form') {
    body = encodeParameters(renderValue(config.body || {}, variables));
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
  }
  return { url: url.href, method, headers, body };
}

function xpath(document, context, expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new HttpError('XPath 不能为空');
  // xpath_selector 3.0.2 tokenizes bare // into no selectors, so execution
  // returns its original context. Official rules use it for a single road.
  if (expression.trim() === '//') return [context];
  // In the Flutter implementation // is scoped to each selected fragment.
  // xpath_selector returns the selected element for a text() location step,
  // even if it has only child elements. Preserve literals inside predicates.
  const selector = expression.replace(
    /('[^']*'|"[^"]*")|(\/{1,2})text\(\s*\)(?=\s*(?:\/|\||$))/g,
    (match, literal, axis) => literal ?? `${axis}self::*`,
  );
  const query = context !== document && selector.startsWith('//') ? `.${selector}` : selector;
  try {
    const result = document.evaluate(query, context, null, 0, null);
    if (result.resultType === 2) return [result.stringValue];
    const items = [];
    let node;
    while ((node = result.iterateNext())) items.push(node);
    return items;
  } catch {
    throw new HttpError(`XPath 无效: ${expression}`);
  }
}
const nodeText = (node) =>
  scalar(
    typeof node === 'string'
      ? node
      : (node?.nodeType === 2 ? node.ownerElement : node)?.textContent,
  );
const nodeUrl = (node) =>
  scalar((node?.nodeType === 2 ? node.ownerElement : node)?.getAttribute?.('href') ?? '');

function detectChallenge(document, rule, raw) {
  if (inspectStaticChallenge(document, rule, raw).detected) throw verificationRequired();
}

export function parseXPathSearch(raw, rule) {
  const dom = new JSDOM(raw);
  try {
    const document = dom.window.document;
    detectChallenge(document, rule, raw);
    return xpath(document, document, rule.searchList)
      .map((node) => {
        const name = nodeText(xpath(document, node, rule.searchName)[0]);
        const url = normalizeEpisodeUrl(
          nodeUrl(xpath(document, node, rule.searchResult)[0]),
          rule.baseURL,
        );
        return { name, url };
      })
      .filter((item) => item.name && item.url);
  } finally {
    dom.window.close();
  }
}

export function parseXPathChapters(raw, rule) {
  const dom = new JSDOM(raw);
  try {
    const document = dom.window.document;
    detectChallenge(document, rule, raw);
    return xpath(document, document, rule.chapterRoads)
      .map((node, roadIndex) => ({
        name: `播放线路${roadIndex + 1}`,
        episodes: xpath(document, node, rule.chapterResult)
          .map((episode, index) => ({
            name: nodeText(episode).replace(/\s+/g, '') || `第${index + 1}集`,
            url: normalizeEpisodeUrl(nodeUrl(episode), rule.baseURL),
          }))
          .filter((episode) => episode.url),
      }))
      .filter((road) => road.episodes.length)
      .map((road, index) => ({ ...road, name: `播放线路${index + 1}` }));
  } finally {
    dom.window.close();
  }
}

export function parseApiSearch(data, config = {}) {
  for (const path of [
    config.listPath ?? '$.data[*]',
    config.namePath ?? '$.name',
    config.sourcePath ?? '$.url',
  ])
    normalizeJsonPath(path);
  if (config.sourceTemplate != null && typeof config.sourceTemplate !== 'string')
    throw new HttpError('详情页地址模板必须是文本');
  const template = (config.sourceTemplate || '').trim();
  if (template && !template.includes('@source'))
    throw new HttpError('详情页地址模板必须引用 @source');
  return readPath(data, config.listPath ?? '$.data[*]')
    .map((node) => {
      const source = scalar(first(node, config.sourcePath ?? '$.url'));
      return {
        name: scalar(first(node, config.namePath ?? '$.name')),
        // API 9 templates allow @source immediately after text (GV@source).
        // Encode the ID once; without a template preserve opaque API identifiers.
        url:
          source &&
          (template ? template.replaceAll('@source', encodeURIComponent(source)) : source),
      };
    })
    .filter((item) => item.name && item.url);
}

export function parseApiChapters(data, config = {}, source, baseURL) {
  const variables = { source };
  for (const [key, path] of Object.entries(config.variables || {})) {
    variables[key] = first(data, path);
    if (variables[key] == null) throw new HttpError(`章节响应变量 ${key} 未匹配到值`);
  }
  function episodeUrl(rawUrl, roadIndex, episodeIndex) {
    if (!config.episodePage) return normalizeEpisodeUrl(rawUrl, baseURL);
    const scope = {
      ...variables,
      episodeUrl: rawUrl,
      roadIndex,
      roadNumber: roadIndex + 1,
      episodeIndex,
      episodeNumber: episodeIndex + 1,
    };
    if (!config.episodePage.url) throw new HttpError('播放页地址模板不能为空');
    const url = new URL(renderTemplate(config.episodePage.url, scope, true), baseURL);
    for (const [key, value] of Object.entries(config.episodePage.query || {}))
      url.searchParams.set(renderTemplate(key, scope), String(renderValue(value, scope)));
    return normalizeEpisodeUrl(url.href, baseURL);
  }
  if (config.format === 'delimited') {
    const roadSeparator = config.roadSeparator ?? '$$$';
    const episodeSeparator = config.episodeSeparator ?? '#';
    const fieldSeparator = config.fieldSeparator ?? '$';
    if (!roadSeparator || !episodeSeparator || !fieldSeparator)
      throw new HttpError('章节分隔符不能为空');
    const names = scalar(first(data, config.roadNamesPath)).split(roadSeparator);
    return scalar(first(data, config.roadEpisodesPath))
      .split(roadSeparator)
      .map((group, roadIndex) => ({
        name: names[roadIndex]?.trim() || '',
        episodes: group
          .split(episodeSeparator)
          .map((entry, episodeIndex) => {
            const separator = entry.indexOf(fieldSeparator);
            if (separator < 0) return null;
            return {
              name: entry.slice(0, separator).trim() || `第${episodeIndex + 1}集`,
              url: episodeUrl(
                entry.slice(separator + fieldSeparator.length).trim(),
                roadIndex,
                episodeIndex,
              ),
            };
          })
          .filter((episode) => episode?.url),
      }))
      .filter((road) => road.episodes.length)
      .map((road, index) => ({ ...road, name: road.name || `播放线路${index + 1}` }));
  }
  const roadsPath = (config.roadsPath ?? '$.data.roads[*]').trim();
  const roadNamePath = (config.roadNamePath ?? '$.name').trim();
  const episodeUrlPath = (config.episodeUrlPath ?? '$.url').trim();
  const nodes = roadsPath ? readPath(data, roadsPath) : [data];
  return nodes
    .map((road, roadIndex) => ({
      name: (roadsPath && roadNamePath ? scalar(first(road, roadNamePath)) : '') || '',
      episodes: readPath(road, config.episodesPath ?? '$.episodes[*]')
        .map((episode, episodeIndex) => ({
          name:
            scalar(first(episode, config.episodeNamePath ?? '$.name')) || `第${episodeIndex + 1}集`,
          url: episodeUrl(
            !episodeUrlPath ? '' : scalar(first(episode, episodeUrlPath)),
            roadIndex,
            episodeIndex,
          ),
        }))
        .filter((episode) => episode.url),
    }))
    .filter((road) => road.episodes.length)
    .map((road, index) => ({ ...road, name: road.name || `播放线路${index + 1}` }));
}

export function ruleHeaders(rule) {
  return {
    ...(rule.userAgent ? { 'user-agent': rule.userAgent } : {}),
    referer: rule.referer || `${rule.baseURL.replace(/\/$/, '')}/`,
  };
}

export class RuleEngine {
  constructor(http, { browserResolver } = {}) {
    this.http = http;
    this.browserResolver = browserResolver;
  }
  async execute(
    request,
    rule,
    { signal, onVerification, sessionOwner, detectChallengeHeaders = false } = {},
  ) {
    signal?.throwIfAborted();
    const headers = { ...ruleHeaders(rule), ...request.headers };
    const options = {
      ...request,
      ...(this.browserResolver?.requestOptions?.(rule, request.url, headers, sessionOwner) || {
        headers,
      }),
      signal,
    };
    // Challenge pages commonly use 403 or 429. Read their bounded body before
    // deciding whether an interactive retry is warranted.
    if (
      (onVerification ||
        hasAutomaticCaptcha(rule) ||
        (detectChallengeHeaders && rule.antiCrawlerConfig?.enabled === true)) &&
      this.http.request
    ) {
      const { response } = await this.http.request(request.url, options);
      if (!response.ok && detectChallengeHeaders && hasChallengeHeaders(response.headers, rule)) {
        await response.body?.cancel();
        throw verificationRequired();
      }
      const raw = await readLimited(response);
      signal?.throwIfAborted();
      if (!response.ok && !hasChallenge(raw, rule))
        throw new HttpError(`上游返回 HTTP ${response.status}`, 502);
      return raw;
    }
    const response = await this.http.text(request.url, options);
    signal?.throwIfAborted();
    return response.text;
  }
  async parseRequest(request, rule, parse, options, responseType = 'html') {
    try {
      const raw = await this.execute(request, rule, options);
      if (responseType === 'json' && hasChallenge(raw, rule)) throw verificationRequired();
      return parse(raw);
    } catch (error) {
      options?.signal?.throwIfAborted();
      if (
        error.code !== 'VERIFICATION_REQUIRED' ||
        (!options?.onVerification && !hasAutomaticCaptcha(rule)) ||
        !this.browserResolver
      )
        throw sourceFailure(error);
      return this.browserResolver.read(
        rule,
        {
          ...request,
          headers: { ...ruleHeaders(rule), ...request.headers },
        },
        { ...options, responseType, parse },
      );
    }
  }
  async search(rule, keyword, options = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.searchOnce(rule, keyword, options);
      } catch (error) {
        if (error.status === 499) throw error;
        options.signal?.throwIfAborted();
        if (attempt || !['SOURCE_CONNECTION_ERROR', 'SOURCE_CONNECT_TIMEOUT'].includes(error.code))
          throw error;
      }
    }
  }
  async searchOnce(rule, keyword, options = {}) {
    if (rule.searchMode === 'api') {
      const request = prepareApiRequest(rule.searchApiConfig?.request, { keyword });
      return this.parseRequest(
        request,
        rule,
        (raw) => parseApiSearch(JSON.parse(raw), rule.searchApiConfig),
        options,
        'json',
      );
    }
    const url = new URL(
      String(rule.searchURL || '').replaceAll('@keyword', encodeURIComponent(keyword)),
    );
    const request = { url: url.href, method: 'GET' };
    if (rule.usePost) {
      request.method = 'POST';
      request.body = encodeParameters(Object.fromEntries(url.searchParams));
      request.headers = { 'content-type': 'application/x-www-form-urlencoded' };
      request.url = url.href;
    }
    return this.parseRequest(request, rule, (raw) => parseXPathSearch(raw, rule), {
      ...options,
      detectChallengeHeaders: true,
    });
  }
  async chapters(rule, source, options = {}) {
    if (rule.chapterMode === 'api') {
      const request = prepareApiRequest(rule.chapterApiConfig?.request, { source });
      return this.parseRequest(
        request,
        rule,
        (raw) => parseApiChapters(JSON.parse(raw), rule.chapterApiConfig, source, rule.baseURL),
        options,
        'json',
      );
    }
    const url = normalizeEpisodeUrl(source, rule.baseURL);
    if (!url) throw new HttpError('章节地址无效');
    return this.parseRequest({ url }, rule, (raw) => parseXPathChapters(raw, rule), options);
  }
}
