import { JSDOM } from 'jsdom';
import { HttpError } from './http.js';
import { jsonObjectAt } from './player-json.js';

const ORIGIN = 'https://www.7sefun.top';
const INDEX_PATH = '/addons/dp/player/index.php';
const ART_PATH = '/addons/dp/player/art.php';

function playerMetadata(html) {
  const dom = new JSDOM(html);
  try {
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      for (const match of text.matchAll(/\bplayer_[A-Za-z0-9_]+\s*=\s*\{/g)) {
        const data = jsonObjectAt(text, match.index + match[0].lastIndexOf('{'));
        if (data?.from === 'ndx') return data;
      }
    }
    return null;
  } finally {
    dom.window.close();
  }
}

function redirectLiteral(html) {
  const dom = new JSDOM(html);
  try {
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) {
      // Recognize the observed standalone redirect without evaluating JavaScript
      // or accepting concatenations, function calls, or escaped script contents.
      const match =
        /^\s*window\.location\.href\s*=\s*(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')\s*;?\s*$/.exec(
          script.textContent,
        );
      if (match) return match[1] ?? match[2];
    }
    return null;
  } finally {
    dom.window.close();
  }
}

export async function resolveSevenSefun(http, html, pageUrl, headers, { signal } = {}) {
  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  const episode = /^\/vodplay\/(\d+)-\d+-\d+\.html$/.exec(page.pathname);
  if (page.origin !== ORIGIN || page.username || page.password || !episode) return null;
  const data = playerMetadata(html);
  if (!data) return null;

  let token = data.url;
  try {
    if (typeof token !== 'string' || ![0, 1, 2].includes(Number(data.encrypt))) throw new Error();
    if (Number(data.encrypt) === 2) token = Buffer.from(token, 'base64').toString('utf8');
    if ([1, 2].includes(Number(data.encrypt))) token = decodeURIComponent(token);
  } catch {
    throw new HttpError('7sefun 播放标识无效', 422);
  }
  if (String(data.id) !== episode[1] || !/^ali_[A-Za-z0-9_-]{1,200}$/.test(token))
    throw new HttpError('7sefun 播放标识无效', 422);

  // ndx.js uses this public player entry point. Its ali_* value is an opaque
  // source identifier, not a relative URL under /vodplay/.
  const entry = new URL(INDEX_PATH, page);
  const parameters = { key: '0', id: String(data.id), uid: '0', from: 'ndx', url: token };
  entry.search = new URLSearchParams(parameters).toString();
  const result = await http.text(entry.href, {
    headers,
    ...(signal && { signal }),
    maxBytes: 1024 * 1024,
  });
  const entryPage = new URL(result.url);
  if (
    entryPage.origin !== page.origin ||
    entryPage.pathname !== INDEX_PATH ||
    entryPage.username ||
    entryPage.password
  )
    throw new HttpError('7sefun 播放器跳转无效', 422);

  const literal = redirectLiteral(result.text);
  let target;
  try {
    if (!literal) throw new Error();
    target = new URL(literal, entryPage);
  } catch {
    throw new HttpError('7sefun 播放器未返回可用地址', 422);
  }
  if (
    target.origin !== page.origin ||
    target.pathname !== ART_PATH ||
    target.username ||
    target.password ||
    Object.entries(parameters).some(
      ([name, value]) =>
        target.searchParams.getAll(name).length !== 1 || target.searchParams.get(name) !== value,
    )
  )
    throw new HttpError('7sefun 播放器跳转无效', 422);
  return { url: target.href, headers };
}
