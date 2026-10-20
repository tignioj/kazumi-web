import { chromium } from 'playwright';
import { HttpError, checkedUrl, readLimited } from '../../lib/http.js';
import { createBrowserEgress } from '../../lib/browser-egress.js';
import { headersForSession } from './session-store.js';
import { legacyIframeMedia } from './legacy-parser.js';
import { RuleSessionStore } from '../verification/session-store.js';
import {
  hasChallengeHeaders,
  inspectBrowserChallenge,
  verificationRequired,
} from '../verification/challenge.js';
import { automateRuleCaptcha, hasAutomaticCaptcha } from '../verification/automation.js';

const MAX_PLAYLIST_BYTES = 1024 * 1024;
const HEADER_NAMES = new Set([
  'user-agent',
  'referer',
  'origin',
  'authorization',
  'accept',
  'accept-language',
]);
const SEGMENT = /\.(?:ts|m4s|m4a|aac|key)(?:[?#]|$)/i;
const AD_URL =
  /(?:doubleclick\.net|googlesyndication\.com|(?:^|[\/_.-])(?:ads?|advert(?:isement)?|preroll|vast)(?:[\/_.-]|$))/i;

function forwardHeaders(input) {
  return Object.fromEntries(
    Object.entries(input)
      .filter(
        ([name, value]) =>
          HEADER_NAMES.has(name.toLowerCase()) &&
          typeof value === 'string' &&
          !/[\r\n]/.test(value),
      )
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function mediaKind(url, contentType = '') {
  // Player HTML often embeds the real media URL in ?url=...; only its own
  // path can supply an extension hint, otherwise it becomes a false candidate.
  const path = url.split(/[?#]/, 1)[0];
  if (SEGMENT.test(path)) return null;
  if (/mpegurl/i.test(contentType) || /\.m3u8$/i.test(path)) return 'hls';
  if (/^(?:video|audio)\//i.test(contentType) && !/mp2t|aac/i.test(contentType)) return 'video';
  return /\.(?:mp4|m4v|webm|mov|mp3|ogg|ogv)$/i.test(path) ? 'video' : null;
}

function playableBytes(bytes, contentType) {
  if (!bytes.length) return false;
  // Check the bytes, not just a CDN's Content-Type: many error pages claim video/mp4.
  if (/^\s*(?:<!doctype|<html|<\?xml|\{|\[)/i.test(bytes.toString('utf8', 0, 128))) return false;
  if (
    bytes.length >= 12 &&
    ['ftyp', 'styp', 'moov', 'mdat', 'free', 'wide'].includes(bytes.toString('ascii', 4, 8))
  )
    return true;
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return true;
  if (bytes.subarray(0, 4).toString() === 'OggS' || bytes.subarray(0, 3).toString() === 'ID3')
    return true;
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return true;
  return (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0 &&
    /audio\//i.test(contentType)
  );
}

async function prefix(response, limit = 4096) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = Buffer.from(value).subarray(0, limit - size);
      chunks.push(part);
      size += part.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function abortable(promise, signal) {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function waitForVerification(page, onVerification, details, signal) {
  const context = page.context();
  const pending = new Set();
  const started = (request) => {
    if (['document', 'xhr', 'fetch'].includes(request.resourceType())) pending.add(request);
  };
  const finished = (request) => pending.delete(request);
  context.on('request', started);
  context.on('requestfinished', finished);
  context.on('requestfailed', finished);
  try {
    await abortable(
      Promise.resolve().then(() => onVerification({ page, ...details })),
      signal,
    );
    signal.throwIfAborted();
    // Image captcha forms often submit with AJAX. Wait for work started during
    // the user's action before classifying an unchanged screen as a bad answer.
    const settleUntil = Date.now() + 4000;
    await delay(400, signal);
    while (pending.size && Date.now() < settleUntil) await delay(100, signal);
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
    signal.throwIfAborted();
  } finally {
    context.off('request', started);
    context.off('requestfinished', finished);
    context.off('requestfailed', finished);
  }
}

// Runs in every frame before source scripts. It observes calls the player already
// makes; it never downloads an unknown response body solely to identify media.
function installObservers({ legacy = false } = {}) {
  const send = (data) => {
    try {
      Promise.resolve(window.__kazumiMedia(data)).catch(() => {});
    } catch {
      /* closing frame */
    }
  };
  const originalText = Response.prototype.text;
  Response.prototype.text = async function (...args) {
    const text = await originalText.apply(this, args);
    if (text.trimStart().startsWith('#EXTM3U')) send({ url: this.url, type: 'hls' });
    return text;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (
          (!this.responseType || this.responseType === 'text') &&
          this.responseText.trimStart().startsWith('#EXTM3U')
        )
          send({ url: this.responseURL, type: 'hls' });
      } catch {
        /* non-text response */
      }
    });
    return originalOpen.apply(this, args);
  };
  const scan = () => {
    if (legacy) {
      for (const iframe of document.querySelectorAll('iframe[src]'))
        send({ url: iframe.src, iframe: true });
    }
    for (const video of document.querySelectorAll('video,audio')) {
      const rect = video.getBoundingClientRect();
      const owner = video.closest('[id],[class]');
      const ad = /(?:^|[\s_-])(?:ad|ads|advert|preroll)(?:[\s_-]|$)/i.test(
        `${owner?.id || ''} ${owner?.className || ''}`,
      );
      for (const url of [
        video.currentSrc,
        video.src,
        ...Array.from(video.querySelectorAll('source'), (node) => node.src),
      ]) {
        if (/^https?:\/\//i.test(url))
          send({ url, dom: true, ad, area: Math.max(0, rect.width * rect.height) });
      }
    }
  };
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      scan();
    });
  }).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });
  document.addEventListener('loadedmetadata', scan, true);
  document.addEventListener('DOMContentLoaded', scan, { once: true });
}

export class BrowserResolver {
  constructor(http, options = {}) {
    this.http = http;
    this.options = { timeout: 20000, maxConcurrency: 2, settleTime: 150, ...options };
    this.options.timeout =
      Number.isFinite(Number(this.options.timeout)) && Number(this.options.timeout) > 0
        ? Math.min(30000, Math.floor(Number(this.options.timeout)))
        : 20000;
    this.options.maxConcurrency =
      Number.isFinite(Number(this.options.maxConcurrency)) &&
      Number(this.options.maxConcurrency) >= 1
        ? Math.min(4, Math.floor(Number(this.options.maxConcurrency)))
        : 2;
    this.options.settleTime =
      Number.isFinite(Number(this.options.settleTime)) && Number(this.options.settleTime) >= 0
        ? Math.min(2000, Math.floor(Number(this.options.settleTime)))
        : 150;
    this.active = new Set();
    this.browser = null;
    this.starting = null;
    this.egress = null;
    this.closed = false;
    this.idleTimer = null;
    this.idleTimeout = Math.max(
      50,
      Number(options.idleTimeout ?? process.env.BROWSER_IDLE_TIMEOUT_MS ?? 30000) || 30000,
    );
    this.ruleSessions = new RuleSessionStore(options.ruleSessionOptions);
  }

  async getBrowser() {
    if (this.closed) throw new HttpError('动态解析服务已关闭', 503);
    clearTimeout(this.idleTimer);
    if (this.browser?.isConnected()) return this.browser;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const egress = await (this.options.egressFactory || createBrowserEgress)({
        allowPrivate: this.http.allowPrivate,
        dnsOverHttpsUrl: this.options.dnsOverHttpsUrl ?? process.env.DNS_OVER_HTTPS_URL,
        getProxySettings: this.http.getProxySettings,
        resolver: this.options.resolver,
      });
      this.egress = egress;
      try {
        const browser = await (
          this.options.browserFactory || ((config) => chromium.launch(config))
        )({
          headless: true,
          timeout: 15000,
          ...this.options.launchOptions,
          // Every browser socket, including loopback, must pass the DNS-pinning proxy.
          proxy: { server: egress.url },
          args: [
            ...(this.options.launchOptions?.args || []),
            '--proxy-bypass-list=<-loopback>',
            '--disable-quic',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-background-networking',
            '--disable-component-update',
          ],
        });
        if (this.closed) {
          await browser.close();
          throw new HttpError('动态解析服务已关闭', 503);
        }
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
          void egress.close();
        });
        return browser;
      } catch (error) {
        await egress.close();
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          /executable|install|browser.*not found/i.test(error.message)
            ? '动态解析浏览器未安装，请安装 Chromium 或更新部署镜像'
            : '动态解析浏览器启动失败，请检查服务日志和浏览器运行环境',
          503,
        );
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  requestOptions(rule, url, headers, owner) {
    return this.ruleSessions.requestOptions(rule, url, headers, owner);
  }

  get available() {
    // This reports enabled capability. Playwright can launch its separately
    // installed headless shell even when chromium.executablePath() is absent.
    // Missing binaries are reported by the first dynamic request.
    return !this.closed;
  }

  mediaSession(rule, url, headers, owner) {
    return this.ruleSessions.mediaSession(rule, url, headers, owner);
  }

  async rememberContext(rule, owner, context, page) {
    const storageState = await context.storageState();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    if (!this.closed) this.ruleSessions.set(rule, owner, storageState, userAgent);
  }

  async createContext(browser, rule, interactive = false, sessionOwner, requestUserAgent) {
    const saved = this.ruleSessions.get(rule, sessionOwner);
    const context = await browser.newContext({
      serviceWorkers: 'block',
      acceptDownloads: false,
      viewport: { width: 1000, height: 700 },
      ...(rule.userAgent ? { userAgent: rule.userAgent } : {}),
      ...(requestUserAgent ? { userAgent: requestUserAgent } : {}),
      ...(saved ? { storageState: saved.storageState, userAgent: saved.userAgent } : {}),
    });
    try {
      await context.routeWebSocket(/.*/, (socket) => {
        try {
          socket.close();
        } catch {
          /* closing context */
        }
      });
      // DNS and socket pinning are additionally enforced by the shared egress
      // proxy, including every redirect and frame/subresource request.
      await context.route('**/*', async (route) => {
        try {
          checkedUrl(route.request().url(), { allowPrivate: this.http.allowPrivate });
          if (!interactive && ['image', 'font'].includes(route.request().resourceType()))
            return await route.abort();
          // Chromium keeps strict TLS checks on direct routes. For a target
          // explicitly routed through a proxy, replay just this request using
          // the context's cookie jar and the same DNS-pinning egress. Redirects
          // return to routing so a direct next hop cannot inherit relaxed TLS.
          if (
            this.http.getProxySettings?.(route.request().url())?.enabled &&
            route.request().url().startsWith('https:')
          ) {
            if (route.request().resourceType() === 'media') return await route.abort();
            const response = await context.request.fetch(route.request(), {
              headers: await route.request().allHeaders(),
              ignoreHTTPSErrors: true,
              maxRedirects: 0,
              timeout: this.options.timeout,
            });
            try {
              await route.fulfill({ response });
            } finally {
              await response.dispose();
            }
          } else await route.continue();
        } catch {
          await route.abort().catch(() => {});
        }
      });
      return context;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  async navigateRequest(page, request, rule) {
    let pending = true;
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const requestUrl = new URL(request.url);
    requestUrl.hash = '';
    const override = async (route) => {
      const current = route.request();
      if (
        pending &&
        current.isNavigationRequest() &&
        current.frame() === page.mainFrame() &&
        current.url() === requestUrl.href
      ) {
        pending = false;
        return route.fallback({
          method: request.method || 'GET',
          headers: { ...current.headers(), ...request.headers, 'user-agent': userAgent },
          ...(request.body !== undefined ? { postData: request.body } : {}),
        });
      }
      await route.fallback();
    };
    await page.route('**/*', override);
    try {
      return await page.goto(request.url, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.timeout,
        ...(rule.referer ? { referer: rule.referer } : {}),
      });
    } finally {
      await page.unroute('**/*', override).catch(() => {});
    }
  }

  // Recovery for searches and chapters retains the page, cookies, localStorage,
  // origin and egress IP throughout manual verification and result parsing.
  async read(
    rule,
    request,
    {
      signal: callerSignal,
      onVerification,
      parse,
      responseType = 'html',
      sessionOwner,
      detectChallengeHeaders = false,
    } = {},
  ) {
    checkedUrl(request.url, { allowPrivate: this.http.allowPrivate });
    // Playwright navigation header overrides also apply to redirects. Unlike
    // the HTTP client's per-hop policy, they cannot safely carry caller-supplied
    // credentials across origins. Browser-managed cookies remain supported.
    if (
      Object.keys(request.headers || {}).some((name) =>
        ['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
      )
    )
      throw new HttpError('该来源请求含认证信息，暂不支持在 Web 内验证，请打开原站或更换来源', 422);
    if (this.closed) throw new HttpError('动态解析服务已关闭', 503);
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () =>
      controller.abort(
        callerSignal.reason instanceof HttpError
          ? callerSignal.reason
          : new HttpError('来源请求已取消', 499),
      );
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    try {
      await this.acquire(controller);
    } catch (error) {
      callerSignal?.removeEventListener('abort', cancel);
      throw error;
    }
    let deadline;
    const arm = () => {
      clearTimeout(deadline);
      deadline = setTimeout(
        () => controller.abort(new HttpError('来源页面加载超时，请重试或更换来源', 504)),
        this.options.timeout,
      );
    };
    let context;
    let closing;
    const close = () => {
      if (context && !closing) closing = context.close().catch(() => {});
      return closing;
    };
    signal.addEventListener('abort', close, { once: true });
    arm();
    try {
      signal.throwIfAborted();
      const browser = await abortable(this.getBrowser(), signal);
      const requestUserAgent = Object.entries(request.headers || {}).find(
        ([key]) => key.toLowerCase() === 'user-agent',
      )?.[1];
      context = await this.createContext(browser, rule, true, sessionOwner, requestUserAgent);
      signal.throwIfAborted();
      const page = await context.newPage();
      context.on('page', (popup) => {
        if (popup !== page) void popup.close().catch(() => {});
      });
      let pageStatus;
      let headerChallenge = false;
      page.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          pageStatus = response.status();
          headerChallenge =
            pageStatus >= 400 &&
            detectChallengeHeaders &&
            hasChallengeHeaders(response.headers(), rule);
        }
      });
      await this.navigateRequest(page, request, rule);
      let attempts = 0;
      let replayed = false;
      while (!signal.aborted) {
        const challenge = headerChallenge
          ? { detected: true, frame: page.mainFrame() }
          : await inspectBrowserChallenge(page, rule);
        // A response header triggers one verification attempt. Completion may
        // replace the document through AJAX without another navigation.
        headerChallenge = false;
        let parseError;
        if (!challenge.detected) {
          try {
            if (pageStatus >= 400 && !attempts)
              throw new HttpError(`上游返回 HTTP ${pageStatus}`, 502);
            const raw =
              responseType === 'json'
                ? await page.locator('body').innerText()
                : await page.content();
            const result = parse ? await parse(raw) : raw;
            if (attempts && !replayed && Array.isArray(result) && !result.length) {
              replayed = true;
              await this.navigateRequest(page, request, rule);
              continue;
            }
            await this.rememberContext(rule, sessionOwner, context, page);
            signal.throwIfAborted();
            return result;
          } catch (error) {
            if (error.code !== 'VERIFICATION_REQUIRED') {
              // API endpoints sometimes navigate to a landing page after the
              // challenge. Replay the original GET/POST with the same cookies.
              if (
                responseType === 'json' &&
                attempts &&
                !replayed &&
                error instanceof SyntaxError
              ) {
                replayed = true;
                await this.navigateRequest(page, request, rule);
                continue;
              }
              throw error;
            }
            parseError = error;
          }
        }
        if (hasAutomaticCaptcha(rule) && attempts < 5) {
          attempts++;
          clearTimeout(deadline);
          try {
            await waitForVerification(
              page,
              () =>
                automateRuleCaptcha(page, rule, {
                  signal,
                  timeout: this.options.timeout,
                  frame: challenge.frame,
                }),
              {},
              signal,
            );
          } finally {
            if (!signal.aborted) arm();
          }
          if ((await inspectBrowserChallenge(page, rule)).detected) {
            replayed = true;
            await this.navigateRequest(page, request, rule);
          }
          continue;
        }
        if (!onVerification || attempts >= 5) throw parseError || verificationRequired();
        attempts++;
        clearTimeout(deadline);
        await waitForVerification(
          page,
          onVerification,
          {
            ruleName: rule.name,
            originalUrl: request.url,
            reason: 'challenge',
            ...(challenge.captcha ? { captcha: challenge.captcha } : {}),
          },
          signal,
        );
        signal.throwIfAborted();
        arm();
      }
      throw signal.reason;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpError || error instanceof SyntaxError) throw error;
      throw new HttpError('来源验证页面无法加载，请重试或更换来源', 502);
    } finally {
      clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', cancel);
      signal.removeEventListener('abort', close);
      await close();
      this.active.delete(controller);
      this.scheduleIdle();
    }
  }

  async validate(candidate, session, signal) {
    let url = candidate.url;
    let kind = candidate.type;
    for (let depth = 0; depth < 4; depth++) {
      checkedUrl(url, { allowPrivate: this.http.allowPrivate });
      const headers = headersForSession(session, url);
      const { response, url: finalUrl } = await this.http.request(url, {
        headers: { ...headers, ...(kind === 'hls' ? {} : { range: 'bytes=0-4095' }) },
        signal,
        headersForUrl: (target) => ({
          ...headersForSession(session, target),
          ...(kind === 'hls' ? {} : { range: 'bytes=0-4095' }),
        }),
      });
      if (![200, 206].includes(response.status)) {
        await response.body?.cancel();
        throw new HttpError(`动态解析的视频验证失败：上游返回 HTTP ${response.status}`, 502);
      }
      const contentType = response.headers.get('content-type') || '';
      if (kind === 'hls' || /mpegurl/i.test(contentType)) {
        const raw = await readLimited(response, MAX_PLAYLIST_BYTES);
        const text = raw;
        if (!text.trimStart().startsWith('#EXTM3U'))
          throw new HttpError('动态解析返回了无效的 HLS 播放列表', 422);
        const lines = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const encryption = lines.find((line) => line.startsWith('#EXT-X-KEY:'));
        if (encryption && !/METHOD=NONE(?:,|$)/.test(encryption)) {
          const method = /METHOD=([^,]+)/.exec(encryption)?.[1];
          const format = /KEYFORMAT="([^"]+)"/.exec(encryption)?.[1];
          if (method !== 'AES-128' || (format && format !== 'identity'))
            throw new HttpError('该视频使用暂不支持的加密或 DRM 播放方式，请切换线路', 422);
          const keyPath = /URI="([^"]+)"/.exec(encryption)?.[1];
          if (!keyPath) throw new HttpError('HLS 加密播放列表缺少密钥地址', 422);
          const keyUrl = new URL(keyPath, finalUrl).href;
          checkedUrl(keyUrl, { allowPrivate: this.http.allowPrivate });
          const key = await this.http.request(keyUrl, {
            headers: headersForSession(session, keyUrl),
            signal,
            headersForUrl: (next) => headersForSession(session, next),
          });
          if (!key.response.ok) {
            await key.response.body?.cancel();
            throw new HttpError('已找到视频，但服务端无法读取 HLS 解密密钥', 502);
          }
          if ((await prefix(key.response, 17)).length !== 16)
            throw new HttpError('HLS 解密密钥格式无效', 422);
        }
        const variant = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF:'));
        if (variant >= 0) {
          const next = lines.slice(variant + 1).find((line) => !line.startsWith('#'));
          if (!next) throw new HttpError('动态解析返回了空的 HLS 播放列表', 422);
          url = new URL(next, finalUrl).href;
          kind = 'hls';
          continue;
        }
        const part =
          lines.find((line) => !line.startsWith('#')) ||
          /#EXT-X-PART:[^\n]*URI="([^"]+)"/.exec(text)?.[1];
        const initialization = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(text)?.[1];
        if (!part) throw new HttpError('动态解析返回了空的 HLS 播放列表', 422);
        // Confirm a real segment can be fetched, but stop after a small prefix.
        const target = new URL(initialization || part, finalUrl).href;
        checkedUrl(target, { allowPrivate: this.http.allowPrivate });
        const probe = await this.http.request(target, {
          headers: { ...headersForSession(session, target), range: 'bytes=0-4095' },
          signal,
          headersForUrl: (next) => ({ ...headersForSession(session, next), range: 'bytes=0-4095' }),
        });
        if (![200, 206].includes(probe.response.status)) {
          const status = probe.response.status;
          let reason = `上游返回 HTTP ${status}`;
          if (status === 403) {
            // Some CDNs explain a region block only in their HTML error body.
            // Inspect a bounded prefix without exposing that body or client IP.
            const body = await prefix(probe.response).catch(() => Buffer.alloc(0));
            if (/\bthe region has been denied\b/i.test(body.toString('utf8')))
              reason += '，当前网络出口地区受限，请检查服务器或网关的代理分流';
          } else await probe.response.body?.cancel();
          throw new HttpError(`已找到视频，但无法通过服务端读取 HLS 分片：${reason}`, 502);
        }
        const bytes = await prefix(probe.response);
        if (
          !bytes.length ||
          /text\/html|application\/(?:json|javascript)/i.test(
            probe.response.headers.get('content-type') || '',
          ) ||
          /^\s*(?:<!doctype|<html|<\?xml)/i.test(bytes.toString('utf8', 0, 128))
        )
          throw new HttpError('HLS 分片返回了无效内容', 422);
        return 'hls';
      }
      const bytes = await prefix(response);
      if (bytes.toString('utf8').trimStart().startsWith('#EXTM3U')) {
        // A source may serve extensionless HLS with text/plain or octet-stream.
        kind = 'hls';
        continue;
      }
      if (!playableBytes(bytes, contentType))
        throw new HttpError('动态解析的视频地址没有返回可识别的媒体内容', 422);
      return 'video';
    }
    throw new HttpError('HLS 播放列表嵌套过深', 422);
  }

  async resolve(
    rule,
    originalUrl,
    { signal: callerSignal, onVerification, playbackUrl, sessionOwner } = {},
  ) {
    checkedUrl(originalUrl, { allowPrivate: this.http.allowPrivate });
    if (playbackUrl) checkedUrl(playbackUrl, { allowPrivate: this.http.allowPrivate });
    if (this.closed) throw new HttpError('动态解析服务已关闭', 503);
    const controller = new AbortController();
    const { signal } = controller;
    const cancel = () =>
      controller.abort(
        callerSignal.reason instanceof HttpError
          ? callerSignal.reason
          : new HttpError('视频解析已取消', 499),
      );
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    try {
      await this.acquire(controller);
    } catch (error) {
      callerSignal?.removeEventListener('abort', cancel);
      throw error;
    }
    let deadline;
    let manualOffered = false;
    let manualPending = false;
    let candidateSeen = false;
    let automaticVerification = false;
    let validationError;
    const armDeadline = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        if (onVerification && !manualOffered && !candidateSeen && !automaticVerification)
          manualPending = true;
        else
          controller.abort(
            new HttpError(
              validationError
                ? `动态解析超时：已捕获视频，但服务端验证失败：${validationError.message}`
                : '动态解析超时：未找到可播放视频，来源可能需要验证码或不支持当前线路',
              504,
            ),
          );
      }, this.options.timeout);
    };
    armDeadline();
    let context;
    let closingContext;
    const closeContext = () => {
      if (context && !closingContext) closingContext = context.close().catch(() => {});
      return closingContext;
    };
    signal.addEventListener('abort', closeContext, { once: true });
    try {
      signal.throwIfAborted();
      const browser = await abortable(this.getBrowser(), signal);
      context = await this.createContext(
        browser,
        rule,
        !!onVerification || hasAutomaticCaptcha(rule),
        sessionOwner,
      );
      signal.throwIfAborted();
      const candidates = new Map();
      const observed = new Map();
      const mediaRequests = new Set();
      const rejected = new Map();
      const advertisements = new Set();
      let lastCandidate = 0;
      const offer = (url, type, score, extra = {}) => {
        if (
          typeof url !== 'string' ||
          url.length > 12000 ||
          SEGMENT.test(url) ||
          advertisements.has(url)
        )
          return;
        try {
          const parsed = checkedUrl(url, { allowPrivate: this.http.allowPrivate });
          if (AD_URL.test(`${parsed.hostname}${parsed.pathname}`)) return;
        } catch {
          return;
        }
        if (extra.ad) {
          candidates.delete(url);
          rejected.set(url, Date.now());
          advertisements.add(url);
          if (advertisements.size > 512)
            advertisements.delete(advertisements.values().next().value);
          return;
        }
        candidateSeen = true;
        mediaRequests.add(url);
        if (mediaRequests.size > 512) mediaRequests.delete(mediaRequests.values().next().value);
        const old = candidates.get(url);
        if (!old || score > old.score) {
          candidates.set(url, {
            url,
            type: type || old?.type || mediaKind(url) || 'video',
            score,
            ...extra,
          });
          lastCandidate = Date.now();
        }
        if (candidates.size > 64) candidates.delete(candidates.keys().next().value);
      };
      const record = async (request) => {
        try {
          const url = request.url();
          checkedUrl(url, { allowPrivate: this.http.allowPrivate });
          const headers = forwardHeaders(await request.allHeaders());
          observed.set(url, headers);
          if (observed.size > 512) observed.delete(observed.keys().next().value);
          if (request.resourceType() === 'media' || mediaKind(url) || SEGMENT.test(url))
            mediaRequests.add(url);
          if (mediaRequests.size > 512) mediaRequests.delete(mediaRequests.values().next().value);
        } catch {
          /* context may already be closing */
        }
      };
      context.on('request', (request) => {
        void record(request);
      });
      context.on('response', (response) => {
        void (async () => {
          if (signal.aborted || response.status() < 200 || response.status() >= 300) return;
          const url = response.url();
          const contentType = response.headers()['content-type'] || '';
          const type = mediaKind(url, contentType);
          if (type) {
            await record(response.request());
            // A player may refresh its session and retry the same URL after a
            // failed probe. A newly successful response permits another validation.
            rejected.delete(url);
            offer(url, type, /mpegurl|^(?:video|audio)\//i.test(contentType) ? 80 : 65);
          } else if (['fetch', 'xhr'].includes(response.request().resourceType())) {
            // Bounded completed text responses cover players that consume arrayBuffer.
            const length = Number(response.headers()['content-length']);
            if (
              length > 0 &&
              length <= MAX_PLAYLIST_BYTES &&
              /text\/|application\/(?:octet-stream|vnd\.apple\.mpegurl)/i.test(contentType)
            ) {
              const body = await response.body();
              if (
                body.length <= MAX_PLAYLIST_BYTES &&
                body.toString('utf8').trimStart().startsWith('#EXTM3U')
              ) {
                await record(response.request());
                offer(url, 'hls', 85);
              }
            }
          }
        })().catch(() => {});
      });
      await context.exposeBinding('__kazumiMedia', ({ frame }, data) => {
        if (!data || typeof data !== 'object') return;
        if (data.iframe) {
          if (rule.useLegacyParser === true) {
            const media = legacyIframeMedia(data.url, frame.url());
            if (media) offer(media.url, media.type, 120, { legacy: true });
          }
          return;
        }
        let frameScore = 0;
        try {
          if (/play|video|embed/i.test(new URL(frame.url()).pathname)) frameScore = 5;
        } catch {
          /* blank frame */
        }
        offer(
          data.url,
          data.type,
          (data.dom ? 100 + Math.min(20, Number(data.area) / 20000 || 0) : 85) + frameScore,
          { ad: data.ad === true },
        );
      });
      await context.addInitScript(installObservers, { legacy: rule.useLegacyParser === true });
      const page = await context.newPage();
      const closePopups = (owner) =>
        owner.on('popup', (popup) => void popup.close().catch(() => {}));
      closePopups(page);
      const navigationStarted = Date.now();
      let playbackPage;
      let playbackNavigationError;
      let navigationError;
      void page
        .goto(originalUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.options.timeout,
          ...(rule.referer ? { referer: rule.referer } : {}),
        })
        .catch((error) => {
          navigationError = error;
        });
      let lastTrigger = 0;
      let lastChallengeCheck = 0;
      let verificationAttempts = 0;
      while (!signal.aborted) {
        // Some wrappers fail even though their decoded playback page works.
        // Keep the wrapper running for sites that exchange their HTTP source URL
        // through a parser, while trying one decoded page in the same session.
        if (
          playbackUrl &&
          playbackUrl !== originalUrl &&
          !playbackPage &&
          (navigationError || Date.now() - navigationStarted >= 1500) &&
          [...candidates.keys()].every((url) => rejected.has(url))
        ) {
          playbackPage = await context.newPage();
          closePopups(playbackPage);
          void playbackPage
            .goto(playbackUrl, {
              waitUntil: 'domcontentloaded',
              timeout: this.options.timeout,
              referer: rule.referer || originalUrl,
            })
            .catch((error) => {
              playbackNavigationError = error;
            });
        }
        const pages = playbackPage ? [page, playbackPage] : [page];
        if (
          (onVerification || hasAutomaticCaptcha(rule)) &&
          (manualPending || Date.now() - lastChallengeCheck > 700)
        ) {
          lastChallengeCheck = Date.now();
          const inspected = await Promise.all(
            pages.map(async (target) => ({
              page: target,
              challenge: await inspectBrowserChallenge(target, rule),
            })),
          );
          const active = inspected.find((item) => item.challenge.detected) || inspected.at(-1);
          const { challenge } = active;
          if (challenge.detected && hasAutomaticCaptcha(rule)) {
            if (verificationAttempts >= 5) throw verificationRequired();
            verificationAttempts++;
            automaticVerification = true;
            manualPending = false;
            try {
              clearTimeout(deadline);
              try {
                await waitForVerification(
                  active.page,
                  () =>
                    automateRuleCaptcha(active.page, rule, {
                      signal,
                      timeout: this.options.timeout,
                      frame: challenge.frame,
                    }),
                  {},
                  signal,
                );
              } finally {
                if (!signal.aborted) armDeadline();
              }
              if ((await inspectBrowserChallenge(active.page, rule)).detected)
                await active.page.reload({
                  waitUntil: 'domcontentloaded',
                  timeout: this.options.timeout,
                });
            } finally {
              automaticVerification = false;
            }
            rejected.clear();
            validationError = undefined;
            navigationError = undefined;
            continue;
          }
          if (challenge.detected || manualPending) {
            if (verificationAttempts >= 5) throw verificationRequired();
            verificationAttempts++;
            const reason = challenge.detected ? 'challenge' : 'manual';
            manualOffered = true;
            manualPending = false;
            clearTimeout(deadline);
            await waitForVerification(
              active.page,
              onVerification,
              {
                ruleName: rule.name,
                originalUrl,
                reason,
                ...(challenge.captcha ? { captcha: challenge.captcha } : {}),
              },
              signal,
            );
            signal.throwIfAborted();
            rejected.clear();
            validationError = undefined;
            navigationError = undefined;
            armDeadline();
            continue;
          }
        }
        if (Date.now() - lastTrigger > 1200) {
          lastTrigger = Date.now();
          for (const frame of pages.flatMap((target) => target.frames())) {
            void frame
              .evaluate(() => {
                for (const video of document.querySelectorAll('video'))
                  void video.play().catch(() => {});
                const control = document.querySelector(
                  '.vjs-big-play-button,.dplayer-play-icon,.art-icon-play,.plyr__control--overlaid,button[aria-label="Play"],button[aria-label="播放"],button[title="播放"]',
                );
                if (control && !control.dataset.kazumiClicked) {
                  control.dataset.kazumiClicked = '1';
                  control.click();
                }
              })
              .catch(() => {});
          }
        }
        if (candidates.size && Date.now() - lastCandidate >= this.options.settleTime) {
          for (const candidate of [...candidates.values()].sort((a, b) => b.score - a.score)) {
            if (rejected.has(candidate.url)) continue;
            signal.throwIfAborted();
            const cookies = await context.cookies();
            const headers = observed.get(candidate.url) || {
              'user-agent': await page.evaluate(() => navigator.userAgent),
              ...(candidate.legacy && rule.referer ? { referer: rule.referer } : {}),
            };
            const session = {
              url: candidate.url,
              adBlocker: rule.adBlocker === true,
              headers,
              cookies,
              // Include bounded actual requests to extensionless key/segment endpoints,
              // whose type cannot be inferred until the manifest has been read.
              requestHeaders: [
                ...new Set(
                  [...observed.keys()]
                    .filter((url) => !mediaRequests.has(url))
                    .concat([...mediaRequests].filter((url) => observed.has(url))),
                ),
              ]
                .slice(-128)
                .map((url) => ({ url, headers: observed.get(url) })),
            };
            try {
              const type = await abortable(this.validate(candidate, session, signal), signal);
              await this.rememberContext(rule, sessionOwner, context, page);
              signal.throwIfAborted();
              // Return actual CookieJar state; sensitive headers stay server-side.
              return { type, ...session };
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              validationError = error;
              rejected.set(candidate.url, Date.now());
            }
          }
        }
        if (
          navigationError &&
          (!playbackUrl || playbackUrl === originalUrl || playbackNavigationError) &&
          !candidates.size
        )
          throw new HttpError('动态解析无法打开来源页面，请检查片源或网络连接', 502);
        await delay(100, signal);
      }
      throw signal.reason;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpError) throw error;
      throw new HttpError('动态解析失败，请重试或切换播放线路', 502);
    } finally {
      clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', cancel);
      signal.removeEventListener('abort', closeContext);
      await closeContext();
      this.active.delete(controller);
      this.scheduleIdle();
    }
  }

  async acquire(controller) {
    const deadline =
      Date.now() + Math.max(0, Math.min(30000, Number(this.options.queueTimeout ?? 30000)));
    while (this.active.size >= this.options.maxConcurrency) {
      controller.signal.throwIfAborted();
      if (this.closed) throw new HttpError('动态解析服务已关闭', 503);
      if (Date.now() >= deadline) throw new HttpError('动态解析繁忙，请稍后重试', 503);
      await delay(50, controller.signal);
    }
    controller.signal.throwIfAborted();
    if (this.closed) throw new HttpError('动态解析服务已关闭', 503);
    this.active.add(controller);
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.closed || this.active.size || !this.browser) return;
    this.idleTimer = setTimeout(() => {
      if (this.active.size) return;
      const browser = this.browser,
        egress = this.egress;
      this.browser = null;
      this.egress = null;
      void Promise.all([browser?.close(), egress?.close()]).catch(() => {});
    }, this.idleTimeout);
    this.idleTimer.unref();
  }

  async close() {
    clearTimeout(this.idleTimer);
    this.closed = true;
    this.ruleSessions.close();
    for (const controller of this.active)
      controller.abort(new HttpError('动态解析服务已关闭', 503));
    if (this.starting) await this.starting.catch(() => {});
    await this.browser?.close();
    await this.egress?.close();
    this.browser = null;
    this.egress = null;
  }
}
