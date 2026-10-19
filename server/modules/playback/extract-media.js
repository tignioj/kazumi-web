import { JSDOM } from 'jsdom';
import { absoluteUrl } from '../rules/engine.js';
import { jsonObjectAt } from './player-json.js';
import { legacyIframeMedia } from './legacy-parser.js';

export function mediaType(url) {
  // An HTML parser's query or fragment can contain a media URL of its own.
  const path = url.split(/[?#]/, 1)[0];
  if (/\.m3u8$/i.test(path)) return 'hls';
  if (/\.(?:mp4|m4v|webm|mov|mp3|m4a|ogg|ogv)$/i.test(path)) return 'video';
  return null;
}

export function extractMedia(html, pageUrl, { useLegacyParser = false } = {}) {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    if (useLegacyParser) {
      for (const iframe of document.querySelectorAll('iframe[src]')) {
        const media = legacyIframeMedia(iframe.getAttribute('src'), pageUrl);
        if (media) return { ...media, legacy: true };
      }
    }
    for (const node of document.querySelectorAll(
      'video[src],video source[src],audio[src],audio source[src]',
    )) {
      const url = absoluteUrl(node.getAttribute('src'), pageUrl);
      if (url)
        return {
          type: /mpegurl/i.test(node.getAttribute('type') || '')
            ? 'hls'
            : mediaType(url) || 'video',
          url,
        };
    }
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      const patterns = /(?:player_[A-Za-z0-9_]+|playerConfig|player_data)\s*=\s*\{/g;
      for (const match of text.matchAll(patterns)) {
        const data = jsonObjectAt(text, match.index + match[0].lastIndexOf('{'));
        if (!data || typeof data.url !== 'string') continue;
        let raw = data.url;
        try {
          if (Number(data.encrypt) === 2) raw = Buffer.from(raw, 'base64').toString('utf8');
          if ([1, 2].includes(Number(data.encrypt))) raw = decodeURIComponent(raw);
        } catch {
          continue;
        }
        // Player identifiers (ali_*, Doki-*, etc.) are inputs to the site's
        // parser, not relative web pages. Keep the original page for sniffing.
        if (!/^(?:(?:https?:)?\/\/|\/|\.\.?\/)/i.test(raw) && !mediaType(raw)) continue;
        const url = absoluteUrl(raw, pageUrl);
        if (url) {
          const type = mediaType(url) || (/m3u8|hls/i.test(data.from || '') ? 'hls' : 'iframe');
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
        if (url) return { type: mediaType(url), url };
      }
    }
    const iframe = document.querySelector('iframe[src]');
    const url = iframe && absoluteUrl(iframe.getAttribute('src'), pageUrl);
    return url ? { type: 'iframe', url } : null;
  } finally {
    dom.window.close();
  }
}
