import { JSDOM } from 'jsdom';
import { absoluteUrl } from '../rules/engine.js';
import { jsonObjectAt } from './player-json.js';
import { legacyIframeMedia } from './legacy-parser.js';
import { createResolutionLogger } from './diagnostics.js';

export function mediaType(url) {
  // An HTML parser's query or fragment can contain a media URL of its own.
  const path = url.split(/[?#]/, 1)[0];
  if (/\.m3u8$/i.test(path)) return 'hls';
  if (/\.(?:mp4|m4v|webm|mov|mp3|m4a|ogg|ogv)$/i.test(path)) return 'video';
  return null;
}

export function extractMedia(html, pageUrl, { useLegacyParser = false } = {}, options = {}) {
  const log = createResolutionLogger(options);
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    if (useLegacyParser) {
      log('规则匹配', '按旧版规则扫描 iframe 查询参数中的媒体地址');
      for (const iframe of document.querySelectorAll('iframe[src]')) {
        const media = legacyIframeMedia(iframe.getAttribute('src'), pageUrl);
        if (media) {
          log('规则匹配', `旧版 iframe 规则匹配成功 · ${media.type} · ${media.url}`);
          return { ...media, legacy: true };
        }
      }
      log('规则匹配', '旧版 iframe 规则未匹配到媒体地址');
    }
    log('规则匹配', '扫描 video / audio / source 标签');
    for (const node of document.querySelectorAll(
      'video[src],video source[src],audio[src],audio source[src]',
    )) {
      const url = absoluteUrl(node.getAttribute('src'), pageUrl);
      if (url) {
        log('规则匹配', `媒体标签匹配成功 · ${url}`);
        return {
          type: /mpegurl/i.test(node.getAttribute('type') || '')
            ? 'hls'
            : mediaType(url) || 'video',
          url,
        };
      }
    }
    log('规则匹配', '媒体标签未匹配，扫描播放器配置和脚本中的媒体地址');
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      const patterns = /(?:player_[A-Za-z0-9_]+|playerConfig|player_data)\s*=\s*\{/g;
      for (const match of text.matchAll(patterns)) {
        const data = jsonObjectAt(text, match.index + match[0].lastIndexOf('{'));
        if (!data || typeof data.url !== 'string') continue;
        let raw = data.url;
        log('规则匹配', `发现播放器配置 · encrypt=${Number(data.encrypt) || 0}`);
        try {
          if (Number(data.encrypt) === 2) raw = Buffer.from(raw, 'base64').toString('utf8');
          if ([1, 2].includes(Number(data.encrypt))) raw = decodeURIComponent(raw);
        } catch {
          log('规则匹配', '播放器配置地址解码失败，继续扫描', 'warn');
          continue;
        }
        // Player identifiers (ali_*, Doki-*, etc.) are inputs to the site's
        // parser, not relative web pages. Keep the original page for sniffing.
        if (!/^(?:(?:https?:)?\/\/|\/|\.\.?\/)/i.test(raw) && !mediaType(raw)) {
          log('规则匹配', '播放器配置为站点播放标识，需要动态解析');
          continue;
        }
        const url = absoluteUrl(raw, pageUrl);
        if (url) {
          const type = mediaType(url) || (/m3u8|hls/i.test(data.from || '') ? 'hls' : 'iframe');
          log('规则匹配', `播放器配置匹配成功 · ${type} · ${url}`);
          return {
            type,
            url,
            ...(type === 'iframe' ? { browserUrl: url } : {}),
          };
        }
      }
      // Recognize literal media URLs without executing any source JavaScript.
      const literal =
        /["']((?:https?:)?(?:\\?\/){2}[^"'\s<>]+?\.(?:m3u8|mp4|webm)(?:\?[^"'\s<>]*)?)["']/i.exec(
          text,
        )?.[1];
      if (literal) {
        const url = absoluteUrl(literal.replace(/\\\//g, '/').replaceAll('&amp;', '&'), pageUrl);
        if (url) {
          log('规则匹配', `脚本媒体地址匹配成功 · ${url}`);
          return { type: mediaType(url), url };
        }
      }
    }
    const iframe = document.querySelector('iframe[src]');
    const url = iframe && absoluteUrl(iframe.getAttribute('src'), pageUrl);
    log('规则匹配', url ? `发现 iframe 页面 · ${url}` : '本页未匹配到媒体地址或 iframe');
    return url ? { type: 'iframe', url } : null;
  } finally {
    dom.window.close();
  }
}
