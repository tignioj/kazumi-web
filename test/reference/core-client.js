import { randomUUID } from 'node:crypto';
import { HttpError } from '../../server/lib/http.js';

// This is a wire adapter. Selectors, templates and website parsing run in Kazumi.
export class KazumiCoreClient {
  constructor({
    url = process.env.KAZUMI_CORE_URL || 'http://127.0.0.1:7331',
    fetcher = fetch,
  } = {}) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password)
      throw new Error('KAZUMI_CORE_URL 必须是 HTTP 服务地址');
    this.fetcher = fetcher;
  }

  async request(path, body = {}, { signal, timeout = 35000 } = {}) {
    signal?.throwIfAborted();
    try {
      const response = await this.fetcher(new URL(path, this.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]),
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new HttpError(data.error || 'Kazumi 核心服务请求失败', response.status);
        error.code = data.code;
        throw error;
      }
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.status) throw error;
      throw new HttpError(
        error.name === 'TimeoutError'
          ? 'Kazumi 核心服务响应超时，请重试'
          : '无法连接 Kazumi 核心服务，请检查服务状态',
        error.name === 'TimeoutError' ? 504 : 503,
      );
    }
  }

  async validate(content, options) {
    return (await this.request('/validate', { content }, options)).rules;
  }

  async run(path, rule, input, options = {}) {
    const requestId = randomUUID();
    const body = { rule, ...input, owner: options.sessionOwner || 'download', requestId };
    const cancel = () => {
      void this.request('/cancel', { requestId }, { timeout: 3000 }).catch(() => {});
    };
    options.signal?.throwIfAborted();
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await this.request(path, body, options);
    } catch (error) {
      if (error.status === 504) cancel();
      if (error.code !== 'CAPTCHA_REQUIRED' || !options.onVerification) throw error;
      const captcha = await this.request(
        '/captcha/start',
        { rule, owner: body.owner, keyword: input.keyword },
        options,
      );
      const snapshot = () => this.request('/captcha/status', { id: captcha.id }, options);
      try {
        await options.onVerification({
          ruleName: rule.name,
          originalUrl: captcha.url,
          snapshot,
          action: (action) => this.request('/captcha/action', { id: captcha.id, action }, options),
        });
        return await this.request(path, body, options);
      } finally {
        await this.request('/captcha/cancel', { id: captcha.id }, { timeout: 3000 }).catch(
          () => {},
        );
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  async search(rule, keyword, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.run('/search', rule, { keyword }, options)).items;
      } catch (error) {
        // Searches are read-only, including API rules that use POST. Retry a
        // dropped connection once; certificate, HTTP and parsing errors persist.
        if (attempt || !['SOURCE_CONNECTION_ERROR', 'SOURCE_CONNECT_TIMEOUT'].includes(error.code))
          throw error;
        options?.signal?.throwIfAborted();
      }
    }
  }

  async chapters(rule, url, options) {
    return (await this.run('/chapters', rule, { url }, options)).roads;
  }

  resolve(rule, url, options) {
    return this.run('/resolve', rule, { url }, options);
  }
}
