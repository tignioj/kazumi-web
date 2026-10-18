import { createHash } from 'node:crypto';
import { cookiesForUrl } from '../playback/session-store.js';

// Clearance survives requests but not a service restart, like the native
// CookieJar. Web clients have separate jars keyed by the server-issued owner.
// A changed rule gets a fresh jar, even if its display name stays the same.
export class RuleSessionStore {
  constructor({ maxSessions = 128, ttlMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.sessions = new Map();
    this.maxSessions = Math.max(1, Number(maxSessions) || 128);
    this.ttlMs = Math.max(1000, Number(ttlMs) || 6 * 60 * 60 * 1000);
    this.now = now;
  }
  key(rule, owner = '') {
    return `${owner}:${createHash('sha256').update(JSON.stringify(rule)).digest('hex')}`;
  }
  get(rule, owner) {
    for (const [key, session] of this.sessions)
      if (session.expires <= this.now()) this.sessions.delete(key);
    return this.sessions.get(this.key(rule, owner));
  }
  set(rule, owner, storageState, userAgent) {
    this.get(rule, owner);
    const key = this.key(rule, owner);
    this.sessions.delete(key);
    while (this.sessions.size >= this.maxSessions)
      this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(key, {
      storageState: structuredClone(storageState),
      userAgent,
      expires: this.now() + this.ttlMs,
    });
  }
  requestOptions(rule, target, input, owner) {
    const session = this.get(rule, owner);
    if (!session) return { headers: input };
    const origin = new URL(target).origin;
    const base = Object.fromEntries(
      Object.entries(input || {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const headersForUrl = (url) => {
      const headers = { ...base };
      if (new URL(url).origin !== origin) {
        delete headers.cookie;
        delete headers.authorization;
      }
      const cookie = cookiesForUrl(session.storageState.cookies, url, this.now());
      if (cookie) {
        headers.cookie ??= cookie;
        headers['user-agent'] = session.userAgent;
      }
      return headers;
    };
    return { headers: headersForUrl(target), headersForUrl };
  }
  mediaSession(rule, url, headers, owner) {
    const state = this.get(rule, owner);
    if (!state) return null;
    return {
      url,
      headers: { ...headers, 'user-agent': state.userAgent },
      // Static rule media already forwards its configured Referer to playlist
      // children. Adding cookies must retain that behavior across CDN hosts.
      forwardReferer: true,
      cookies: structuredClone(state.storageState.cookies),
      requestHeaders: [],
    };
  }
  close() {
    this.sessions.clear();
  }
}
