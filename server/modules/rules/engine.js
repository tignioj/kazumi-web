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
function selectWithTrace(trace, label, expression, context, select) {
  try {
    const matches = select();
    trace?.select(label, expression, context, matches.length);
    if (!matches.length) trace?.diagnostic(`${context}：${label} 未匹配到节点`);
    return matches;
  } catch (error) {
    trace?.diagnostic(`${context}：${label} 解析失败：${error.message}`);
    throw error;
  }
}
const tracedPath = (document, expression, trace, label, context = '响应') =>
  selectWithTrace(trace, label, expression, context, () => readPath(document, expression));
const first = (document, expression, trace, label, context) =>
  tracedPath(document, expression, trace, label, context)[0];

function traceNode(trace, entry, fragment) {
  if (!trace) return;
  trace.node({ ...entry, fragment });
  if (entry.status === 'skipped') {
    const context =
      entry.kind === 'item'
        ? `搜索节点 ${entry.index}`
        : entry.kind === 'road'
          ? `线路 ${entry.index}`
          : `线路 ${entry.roadIndex} / 剧集 ${entry.index}`;
    trace.diagnostic(`${context}：${entry.reason}，已跳过`);
  }
}
const jsonFragment = (value) => JSON.stringify(value) ?? '';

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

function scopeXPath(selector) {
  let expectsOperand = true;
  // Locate absolute paths without interpreting strings or splitting unions.
  // An absolute path can also start inside a group, predicate or function.
  return selector.replace(
    /'[^']*'|"[^"]*"|[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_.:\-\u0080-\uFFFF]*|(?:\d*\.)?\d+|\/\/|\.\.|\s+|./g,
    (token) => {
      if (/^\s+$/.test(token)) return token;
      if (token === '/' || token === '//') {
        const scoped = expectsOperand ? `.${token}` : token;
        expectsOperand = true;
        return scoped;
      }
      if (token === '*') expectsOperand = !expectsOperand;
      else if (['and', 'or', 'div', 'mod'].includes(token)) expectsOperand = !expectsOperand;
      else expectsOperand = /^[([|,=<>!+\-@$]$/.test(token) || token.endsWith(':');
      return token;
    },
  );
}

function xpathBranches(selector) {
  const branches = [];
  let quote = '',
    depth = 0,
    start = 0;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === "'" || character === '"') quote = character;
    else if (character === '(' || character === '[') depth++;
    else if (character === ')' || character === ']') depth--;
    else if (character === '|' && depth === 0) {
      branches.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(selector.slice(start));
  return branches;
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
  const query = context !== document ? scopeXPath(selector) : selector;
  try {
    const branches = xpathBranches(query);
    const items = [];
    const seen = new Set();
    // Kazumi appends each top-level union branch in order and removes nodes
    // already returned by an earlier branch, rather than sorting the union.
    for (const branch of branches) {
      const result = document.evaluate(branch, context, null, 0, null);
      if (result.resultType === 2) {
        if (branches.length !== 1) throw new Error('XPath union requires nodes');
        return [result.stringValue];
      }
      let node;
      while ((node = result.iterateNext())) {
        // Upstream attribute selections expose their owning element as .node.
        const identity = branches.length > 1 && node.nodeType === 2 ? node.ownerElement : node;
        if (seen.has(identity)) continue;
        seen.add(identity);
        items.push(node);
      }
    }
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
const htmlFragment = (node) => {
  const element = node?.nodeType === 2 ? node.ownerElement : node;
  if (element?.nodeType === 9) return element.documentElement?.outerHTML ?? '';
  return typeof element === 'string' ? element : (element?.outerHTML ?? element?.textContent ?? '');
};

function detectChallenge(document, rule, raw) {
  if (inspectStaticChallenge(document, rule, raw).detected) throw verificationRequired();
}

export function parseXPathSearch(raw, rule, trace) {
  const dom = new JSDOM(raw);
  try {
    const document = dom.window.document;
    detectChallenge(document, rule, raw);
    return selectWithTrace(trace, 'searchList', rule.searchList, '响应', () =>
      xpath(document, document, rule.searchList),
    )
      .map((node, index) => {
        const context = `搜索节点 ${index + 1}`;
        const name = nodeText(
          selectWithTrace(trace, 'searchName', rule.searchName, context, () =>
            xpath(document, node, rule.searchName),
          )[0],
        );
        const source = nodeUrl(
          selectWithTrace(trace, 'searchResult', rule.searchResult, context, () =>
            xpath(document, node, rule.searchResult),
          )[0],
        );
        const url = normalizeEpisodeUrl(source, rule.baseURL);
        const reason = [!name && '缺少名称', !source ? '缺少来源' : !url && '来源地址无效']
          .filter(Boolean)
          .join('；');
        traceNode(
          trace,
          {
            kind: 'item',
            index: index + 1,
            status: reason ? 'skipped' : 'accepted',
            reason,
            name,
            url,
          },
          () => htmlFragment(node),
        );
        return { name, url };
      })
      .filter((item) => item.name && item.url);
  } finally {
    dom.window.close();
  }
}

export function parseXPathChapters(raw, rule, trace) {
  const dom = new JSDOM(raw);
  try {
    const document = dom.window.document;
    detectChallenge(document, rule, raw);
    let acceptedRoads = 0;
    return selectWithTrace(trace, 'chapterRoads', rule.chapterRoads, '响应', () =>
      xpath(document, document, rule.chapterRoads),
    )
      .map((node, roadIndex) => {
        const episodes = selectWithTrace(
          trace,
          'chapterResult',
          rule.chapterResult,
          `线路 ${roadIndex + 1}`,
          () => xpath(document, node, rule.chapterResult),
        )
          .map((episode, index) => {
            const name = nodeText(episode).replace(/\s+/g, '') || `第${index + 1}集`;
            const source = nodeUrl(episode);
            const url = normalizeEpisodeUrl(source, rule.baseURL);
            traceNode(
              trace,
              {
                kind: 'episode',
                index: index + 1,
                roadIndex: roadIndex + 1,
                status: url ? 'accepted' : 'skipped',
                reason: url ? '' : source ? '剧集地址无效' : '缺少 URL',
                name,
                url,
              },
              () => htmlFragment(episode),
            );
            return { name, url };
          })
          .filter((episode) => episode.url);
        if (episodes.length) acceptedRoads++;
        traceNode(
          trace,
          {
            kind: 'road',
            index: roadIndex + 1,
            status: episodes.length ? 'accepted' : 'skipped',
            reason: episodes.length ? '' : '无有效剧集',
            name: `播放线路${episodes.length ? acceptedRoads : roadIndex + 1}`,
          },
          () => htmlFragment(node),
        );
        return { name: `播放线路${roadIndex + 1}`, episodes };
      })
      .filter((road) => road.episodes.length)
      .map((road, index) => ({ ...road, name: `播放线路${index + 1}` }));
  } finally {
    dom.window.close();
  }
}

export function parseApiSearch(data, config = {}, trace) {
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
  return tracedPath(data, config.listPath ?? '$.data[*]', trace, 'listPath')
    .map((node, index) => {
      const context = `搜索节点 ${index + 1}`;
      const source = scalar(
        first(node, config.sourcePath ?? '$.url', trace, 'sourcePath', context),
      );
      const item = {
        name: scalar(first(node, config.namePath ?? '$.name', trace, 'namePath', context)),
        // API 9 templates allow @source immediately after text (GV@source).
        // Encode the ID once; without a template preserve opaque API identifiers.
        url:
          source &&
          (template ? template.replaceAll('@source', encodeURIComponent(source)) : source),
      };
      const reason = [!item.name && '缺少名称', !item.url && '缺少来源'].filter(Boolean).join('；');
      traceNode(
        trace,
        {
          kind: 'item',
          index: index + 1,
          status: reason ? 'skipped' : 'accepted',
          reason,
          ...item,
        },
        () => jsonFragment(node),
      );
      return item;
    })
    .filter((item) => item.name && item.url);
}

export function parseApiChapters(data, config = {}, source, baseURL, trace) {
  const variables = { source };
  const invalidEpisodeReason = (rawUrl) =>
    config.episodePage ? '剧集地址模板生成的地址无效' : rawUrl ? '剧集地址无效' : '缺少 URL';
  for (const [key, path] of Object.entries(config.variables || {})) {
    variables[key] = first(data, path, trace, `variables.${key}`);
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
    const names = scalar(first(data, config.roadNamesPath, trace, 'roadNamesPath')).split(
      roadSeparator,
    );
    const rawEpisodes = scalar(first(data, config.roadEpisodesPath, trace, 'roadEpisodesPath'));
    if (!rawEpisodes) trace?.diagnostic('响应：章节内容为空');
    let acceptedRoads = 0;
    return rawEpisodes
      .split(roadSeparator)
      .map((group, roadIndex) => {
        const name = names[roadIndex]?.trim() || '';
        const episodes = group
          .split(episodeSeparator)
          .map((entry, episodeIndex) => {
            const separator = entry.indexOf(fieldSeparator);
            if (separator < 0) {
              traceNode(
                trace,
                {
                  kind: 'episode',
                  index: episodeIndex + 1,
                  roadIndex: roadIndex + 1,
                  status: 'skipped',
                  reason: '缺少字段分隔符',
                },
                () => entry,
              );
              return null;
            }
            const rawUrl = entry.slice(separator + fieldSeparator.length).trim();
            const episode = {
              name: entry.slice(0, separator).trim() || `第${episodeIndex + 1}集`,
              url: episodeUrl(rawUrl, roadIndex, episodeIndex),
            };
            traceNode(
              trace,
              {
                kind: 'episode',
                index: episodeIndex + 1,
                roadIndex: roadIndex + 1,
                status: episode.url ? 'accepted' : 'skipped',
                reason: episode.url ? '' : invalidEpisodeReason(rawUrl),
                ...episode,
              },
              () => entry,
            );
            return episode;
          })
          .filter((episode) => episode?.url);
        if (episodes.length) acceptedRoads++;
        traceNode(
          trace,
          {
            kind: 'road',
            index: roadIndex + 1,
            status: episodes.length ? 'accepted' : 'skipped',
            reason: episodes.length ? '' : '无有效剧集',
            name: name || `播放线路${episodes.length ? acceptedRoads : roadIndex + 1}`,
          },
          () => group,
        );
        return { name, episodes };
      })
      .filter((road) => road.episodes.length)
      .map((road, index) => ({ ...road, name: road.name || `播放线路${index + 1}` }));
  }
  const roadsPath = (config.roadsPath ?? '$.data.roads[*]').trim();
  const roadNamePath = (config.roadNamePath ?? '$.name').trim();
  const episodeUrlPath = (config.episodeUrlPath ?? '$.url').trim();
  const nodes = roadsPath ? tracedPath(data, roadsPath, trace, 'roadsPath') : [data];
  if (!roadsPath) trace?.select('roadsPath', '', '响应（单线路）', 1);
  let acceptedRoads = 0;
  return nodes
    .map((road, roadIndex) => {
      const context = `线路 ${roadIndex + 1}`;
      const name =
        (roadsPath && roadNamePath
          ? scalar(first(road, roadNamePath, trace, 'roadNamePath', context))
          : '') || '';
      const episodes = tracedPath(
        road,
        config.episodesPath ?? '$.episodes[*]',
        trace,
        'episodesPath',
        context,
      )
        .map((episode, episodeIndex) => {
          const episodeContext = `${context} / 剧集 ${episodeIndex + 1}`;
          const name =
            scalar(
              first(
                episode,
                config.episodeNamePath ?? '$.name',
                trace,
                'episodeNamePath',
                episodeContext,
              ),
            ) || `第${episodeIndex + 1}集`;
          const rawUrl = !episodeUrlPath
            ? ''
            : scalar(first(episode, episodeUrlPath, trace, 'episodeUrlPath', episodeContext));
          const url = episodeUrl(rawUrl, roadIndex, episodeIndex);
          traceNode(
            trace,
            {
              kind: 'episode',
              index: episodeIndex + 1,
              roadIndex: roadIndex + 1,
              status: url ? 'accepted' : 'skipped',
              reason: url ? '' : invalidEpisodeReason(rawUrl),
              name,
              url,
            },
            () => jsonFragment(episode),
          );
          return { name, url };
        })
        .filter((episode) => episode.url);
      if (episodes.length) acceptedRoads++;
      traceNode(
        trace,
        {
          kind: 'road',
          index: roadIndex + 1,
          status: episodes.length ? 'accepted' : 'skipped',
          reason: episodes.length ? '' : '无有效剧集',
          name: name || `播放线路${episodes.length ? acceptedRoads : roadIndex + 1}`,
        },
        () => jsonFragment(road),
      );
      return { name, episodes };
    })
    .filter((road) => road.episodes.length)
    .map((road, index) => ({ ...road, name: road.name || `播放线路${index + 1}` }));
}

export function ruleHeaders(rule) {
  return {
    ...(rule.userAgent ? { 'user-agent': rule.userAgent } : {}),
    referer: rule.referer || `${rule.baseURL.replace(/\/$/, '')}/`,
  };
}

function requestHeaders(rule, request) {
  // Kazumi's RuleExecutionConfig excludes the playback-only UA and Referer.
  // Keep its literal baseURL + '/' default; API headers override it, and the
  // session store subsequently applies the UA bound to verification cookies.
  return {
    referer: `${rule.baseURL}/`,
    ...Object.fromEntries(
      Object.entries(request.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
    ),
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
    {
      signal,
      onVerification,
      sessionOwner,
      detectChallengeHeaders = false,
      trace,
      responseType = 'html',
    } = {},
  ) {
    signal?.throwIfAborted();
    const headers = requestHeaders(rule, request);
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
      if (!response.ok && !hasChallenge(raw, rule)) {
        trace?.capture(raw, responseType);
        throw new HttpError(`上游返回 HTTP ${response.status}`, 502);
      }
      return raw;
    }
    const response = await this.http.text(request.url, options);
    signal?.throwIfAborted();
    return response.text;
  }
  async parseRequest(request, rule, parse, options, responseType = 'html') {
    const parseResponse = (raw) => {
      options?.trace?.capture(raw, responseType);
      try {
        if (responseType === 'json' && hasChallenge(raw, rule)) throw verificationRequired();
        return parse(raw);
      } catch (error) {
        options?.trace?.diagnostic(
          responseType === 'json' && error instanceof SyntaxError
            ? `API 响应 JSON 语法错误：${error.message}`
            : `响应解析失败：${error.message}`,
        );
        throw error;
      }
    };
    try {
      const raw = await this.execute(request, rule, { ...options, responseType });
      return parseResponse(raw);
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
          headers: requestHeaders(rule, request),
        },
        { ...options, responseType, parse: parseResponse },
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
        (raw) => parseApiSearch(JSON.parse(raw), rule.searchApiConfig, options.trace),
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
    return this.parseRequest(request, rule, (raw) => parseXPathSearch(raw, rule, options.trace), {
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
        (raw) =>
          parseApiChapters(
            JSON.parse(raw),
            rule.chapterApiConfig,
            source,
            rule.baseURL,
            options.trace,
          ),
        options,
        'json',
      );
    }
    const url = normalizeEpisodeUrl(source, rule.baseURL);
    if (!url) throw new HttpError('章节地址无效');
    return this.parseRequest(
      { url },
      rule,
      (raw) => parseXPathChapters(raw, rule, options.trace),
      options,
    );
  }
}
