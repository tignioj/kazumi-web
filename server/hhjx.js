import { JSDOM } from 'jsdom';
import { HttpError, checkedUrl } from './http.js';
import { jsonObjectAt } from './player-json.js';

// This player obtains the media URL through its public JSON endpoint. Calling
// that endpoint here keeps mobile devices on our media proxy instead of an iframe.
export async function resolveHhjx(http, html, pageUrl, headers, { signal } = {}) {
  const page = new URL(pageUrl);
  if (page.hostname !== 'hhjx.hhplayer.com') return null;
  const dom = new JSDOM(html);
  let bootstrap;
  try {
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      const match = /\bwindow\.__HHJX_BOOTSTRAP__\s*=\s*\{/.exec(text);
      if (!match) continue;
      bootstrap = jsonObjectAt(text, match.index + match[0].lastIndexOf('{'));
      break;
    }
  } finally {
    dom.window.close();
  }
  if (
    !bootstrap ||
    typeof bootstrap.url !== 'string' ||
    !bootstrap.url ||
    bootstrap.url.length > 8000 ||
    typeof bootstrap.key !== 'string' ||
    !bootstrap.key ||
    bootstrap.key.length > 256 ||
    !Number.isSafeInteger(bootstrap.t) ||
    bootstrap.t <= 0 ||
    bootstrap.error
  )
    throw new HttpError('来源播放器参数无效，请重新解析或切换线路', 422);

  const parse = async (clientFallback) => {
    const result = await http.json(new URL('/api/parse', page).href, {
      ...(signal && { signal }),
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        origin: page.origin,
        referer: page.href,
      },
      body: JSON.stringify({
        url: bootstrap.url,
        t: bootstrap.t,
        key: bootstrap.key,
        client_fallback: clientFallback,
        ...(bootstrap.act === 99 ? { act: 99 } : {}),
      }),
    });
    if (
      result?.code !== 200 ||
      typeof result.url !== 'string' ||
      !result.url.trim() ||
      result.url.length > 8000
    )
      throw new HttpError('来源播放器未返回有效视频地址，请重试或切换线路', 502);
    return result;
  };

  let result = await parse(false);
  // The provider offers a server fallback for its browser-only Youku resolver.
  if (result.ext === 'youku') result = await parse(true);
  if (result.ext && result.ext !== 'hls_rewrite')
    throw new HttpError('此线路仍需要来源网页解析，请切换线路或打开来源页面', 422);

  let target = checkedUrl(result.url, { allowPrivate: http.allowPrivate });
  if (page.protocol === 'https:' && target.protocol === 'http:') target.protocol = 'https:';
  const hls = /(?:\.m3u8|\/m3u8)(?:[?#]|$)/i.test(target.href);
  if (result.ext === 'hls_rewrite') {
    if (
      !hls ||
      typeof bootstrap.ts_key !== 'string' ||
      !bootstrap.ts_key ||
      bootstrap.ts_key.length > 256
    )
      throw new HttpError('来源播放器的 HLS 参数无效，请重新解析', 422);
    const playlist = new URL('/getts', page);
    playlist.search = new URLSearchParams({
      url: target.href,
      t: String(bootstrap.t),
      key: bootstrap.ts_key,
    }).toString();
    target = playlist;
  }

  // HHJX declares no-referrer for its media. In particular, the QQ MP4 CDN
  // returns 404 if we accidentally inherit the source site's Referer.
  const mediaHeaders = { ...headers };
  delete mediaHeaders.referer;
  return { type: hls ? 'hls' : 'video', url: target.href, headers: mediaHeaders };
}
