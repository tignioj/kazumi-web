import { randomBytes } from 'node:crypto';
import { cleanHeaders, HttpError } from '../../lib/http.js';

// Browser cookies remain on the server. Playwright uses an initial dot for
// domain cookies and -1 for cookies that expire with the browser session.
export function cookiesForUrl(cookies = [], target, now = Date.now()) {
  const url = new URL(target);
  const host = url.hostname.toLowerCase();
  return cookies
    .filter((cookie) => {
      if (!cookie || typeof cookie.domain !== 'string') return false;
      const domain = cookie.domain.toLowerCase().replace(/^\./, '');
      const domainCookie = cookie.hostOnly === false || cookie.domain.startsWith('.');
      if (host !== domain && !(domainCookie && host.endsWith(`.${domain}`))) return false;
      const path = cookie.path?.startsWith('/') ? cookie.path : '/';
      if (
        url.pathname !== path &&
        !(
          url.pathname.startsWith(path) &&
          (path.endsWith('/') || url.pathname[path.length] === '/')
        )
      )
        return false;
      if (cookie.secure && url.protocol !== 'https:') return false;
      if (Number.isFinite(cookie.expires) && cookie.expires >= 0 && cookie.expires <= now / 1000)
        return false;
      return (
        typeof cookie.name === 'string' &&
        /^[!#$%&'*+.^_`|~\w-]+$/.test(cookie.name) &&
        typeof cookie.value === 'string' &&
        !/[;\x00-\x1f\x7f]/.test(cookie.value)
      );
    })
    .sort((a, b) => (b.path?.length || 1) - (a.path?.length || 1))
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}

export function headersForSession(session, target, now = Date.now()) {
  const url = new URL(target);
  const sameOrigin = url.origin === new URL(session.url).origin;
  const captured =
    session.requestHeaders?.find((entry) => entry.url === url.href) ||
    (!sameOrigin &&
      session.requestHeaders?.find((entry) => new URL(entry.url).origin === url.origin));
  const headers = cleanHeaders(captured ? captured.headers : session.headers);
  if (!captured && !sameOrigin) {
    for (const name of Object.keys(headers)) {
      if (!['user-agent', 'accept', 'accept-language'].includes(name)) delete headers[name];
    }
  }
  // The player decides Range for each request. The browser's probe range and
  // cookies must not be replayed across every HLS segment or key host.
  delete headers.range;
  delete headers.cookie;
  if (!captured && !sameOrigin) delete headers.authorization;
  const cookie = cookiesForUrl(session.cookies, url, now);
  if (cookie) headers.cookie = cookie;
  return headers;
}

export class MediaSessionStore {
  constructor({ maxSessions = 128, ttlMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.sessions = new Map();
    this.maxSessions = Math.max(1, maxSessions);
    this.ttlMs = Math.max(1000, ttlMs);
    this.now = now;
  }
  prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expires * 1000 <= now) this.sessions.delete(id);
    }
  }
  create(input) {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    const sessionId = randomBytes(24).toString('base64url');
    const session = {
      url: new URL(input.url).href,
      headers: cleanHeaders(input.headers),
      cookies: (input.cookies || []).slice(0, 500).map((cookie) => ({ ...cookie })),
      requestHeaders: (input.requestHeaders || []).slice(-128).map((entry) => ({
        url: new URL(entry.url).href,
        headers: cleanHeaders(entry.headers),
      })),
      expires: Math.floor((this.now() + this.ttlMs) / 1000),
    };
    this.sessions.set(sessionId, session);
    return { sessionId, ...session };
  }
  get(sessionId) {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError('播放会话已过期，请重新打开剧集', 403);
    return session;
  }
  close() {
    this.sessions.clear();
  }
}
