import { HttpError, checkedUrl, readLimited } from '../../lib/http.js';
import { ruleHeaders, absoluteUrl } from '../rules/engine.js';
import { extractMedia, mediaType } from './extract-media.js';
import { resolveHhjx } from './adapters/hhjx.js';
import { resolveSevenSefun } from './adapters/sevensefun.js';
import { createResolutionLogger } from './diagnostics.js';

// Resolve pages locally; only dynamic players and challenges need Chromium.
export class LocalSourceResolver {
  constructor(http, { browserResolver } = {}) {
    this.http = http;
    this.browserResolver = browserResolver;
  }
  async resolve(rule, source, options = {}) {
    const { signal, sessionOwner } = options;
    const log = createResolutionLogger(options);
    const originalUrl = absoluteUrl(source, rule.baseURL);
    if (!originalUrl) throw new HttpError('播放地址无效');
    checkedUrl(originalUrl, { allowPrivate: this.http.allowPrivate });
    signal?.throwIfAborted();
    log(
      '规则',
      `使用规则 · ${rule.name || '当前来源'} · 旧版 iframe 解析${rule.useLegacyParser === true ? '开启' : '关闭'} · 原生去广告${rule.adBlocker === true ? '开启' : '关闭'}`,
    );
    log(
      '规则',
      `请求配置 · Referer ${rule.referer || '使用默认值'} · User-Agent ${rule.userAgent ? '使用规则配置' : '使用默认值'}`,
    );
    log('解析', `开始静态提取 · ${originalUrl}`);
    let playbackUrl;
    try {
      const result = await this.resolveStatic(rule, originalUrl, signal, sessionOwner, options);
      if (result.type !== 'iframe') {
        const session = this.browserResolver?.mediaSession?.(
          rule,
          result.url,
          result.headers,
          sessionOwner,
        ) || { url: result.url, headers: result.headers, cookies: [], requestHeaders: [] };
        if (this.browserResolver?.validate) {
          log('视频验证', `验证静态提取的视频 · ${result.url}`);
          const probeSignal = AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(5000),
          ]);
          result.type = await this.browserResolver.validate(
            result,
            { ...session, adBlocker: rule.adBlocker === true },
            probeSignal,
            options,
          );
          log('视频验证', `静态视频验证通过 · ${result.type} · ${result.url}`);
        }
        signal?.throwIfAborted();
        return { ...result, ...session, type: result.type };
      }
      playbackUrl = result.browserUrl;
      log('解析', '静态提取未得到可播放视频，切换 Chromium 动态嗅探');
    } catch (error) {
      signal?.throwIfAborted();
      log('静态解析', `静态提取或验证失败 · ${error.message}`, 'warn');
      if (!this.browserResolver || ![422, 502, 504].includes(error.status)) throw error;
    }
    if (!this.browserResolver) throw new HttpError('此来源需要动态解析，请安装 Chromium', 422);
    return this.browserResolver.resolve(rule, originalUrl, {
      ...options,
      ...(playbackUrl && { playbackUrl }),
    });
  }
  async resolveStatic(rule, originalUrl, signal, sessionOwner, options = {}) {
    const log = createResolutionLogger(options);
    let headers = ruleHeaders(rule);
    let url = originalUrl;
    let fallback = originalUrl;
    let browserUrl;
    const visited = new Set();
    for (let depth = 0; depth < 4; depth++) {
      signal?.throwIfAborted();
      checkedUrl(url, { allowPrivate: this.http.allowPrivate });
      const type = mediaType(url);
      if (type) {
        log('静态解析', `识别媒体直链 · ${type} · ${url}`);
        return { type, url, headers, originalUrl };
      }
      if (visited.has(url)) {
        log('静态解析', `遇到重复页面，停止静态跳转 · ${url}`, 'warn');
        break;
      }
      visited.add(url);
      let result;
      try {
        log('页面加载', `开始加载 · 第 ${depth + 1}/4 层 · ${url}`);
        result = await this.http.request(url, {
          ...(this.browserResolver?.requestOptions?.(rule, url, headers, sessionOwner) || {
            headers,
          }),
          signal,
        });
        signal?.throwIfAborted();
      } catch (error) {
        log('页面加载', `加载失败 · ${url} · ${error.message}`, 'warn');
        if (signal?.aborted || depth === 0 || error.status === 403) throw error;
        break;
      }
      const response = result.response;
      log(
        '页面加载',
        `收到响应 · HTTP ${response.status} · ${response.headers.get('content-type') || '未知内容类型'} · ${result.url}`,
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (depth === 0) throw new HttpError(`来源返回 HTTP ${response.status}`, 502);
        break;
      }
      const contentType = response.headers.get('content-type') || '';
      if (/mpegurl|^video\/|^audio\//i.test(contentType)) {
        await response.body?.cancel();
        const kind = /mpegurl/i.test(contentType) ? 'hls' : 'video';
        log('静态解析', `响应类型匹配媒体 · ${kind} · ${result.url}`);
        return {
          type: kind,
          url: result.url,
          headers,
          originalUrl,
        };
      }
      const raw = await readLimited(response);
      log('页面加载', `页面读取完成 · ${result.url}`);
      if (raw.trimStart().startsWith('#EXTM3U')) {
        log('静态解析', `响应内容匹配 HLS 播放列表 · ${result.url}`);
        return {
          type: 'hls',
          url: result.url,
          headers,
          originalUrl,
        };
      }
      const dynamic = await resolveHhjx(this.http, raw, result.url, headers, {
        ...options,
        signal,
      });
      signal?.throwIfAborted();
      if (dynamic)
        return {
          type: dynamic.type,
          url: dynamic.url,
          headers: dynamic.headers,
          originalUrl,
        };
      const playerPage = await resolveSevenSefun(this.http, raw, result.url, headers, {
        ...options,
        signal,
      });
      signal?.throwIfAborted();
      if (playerPage) {
        checkedUrl(playerPage.url, { allowPrivate: this.http.allowPrivate });
        url = playerPage.url;
        headers = playerPage.headers;
        continue;
      }
      const extracted = extractMedia(raw, result.url, rule, options);
      if (!extracted) break;
      checkedUrl(extracted.url, { allowPrivate: this.http.allowPrivate });
      if (extracted.type !== 'iframe')
        return {
          ...extracted,
          headers:
            extracted.legacy && !rule.referer
              ? Object.fromEntries(
                  Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'referer'),
                )
              : headers,
          originalUrl,
        };
      fallback = extracted.url;
      log('静态解析', `继续解析 iframe / 播放器页面 · ${fallback}`);
      if (extracted.browserUrl) browserUrl = extracted.browserUrl;
      url = extracted.url;
    }
    log('静态解析', `静态扫描结束，未找到媒体直链 · 已扫描 ${visited.size} 个页面`);
    return { type: 'iframe', url: fallback, originalUrl, ...(browserUrl && { browserUrl }) };
  }
}
