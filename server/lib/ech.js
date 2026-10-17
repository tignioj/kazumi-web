import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOSTS = new Set(['api.bgm.tv', 'next.bgm.tv', 'lain.bgm.tv']);
const MAX_RESPONSE = 8 * 1024 ** 2;
const DEFAULT_BINARY = fileURLToPath(
  new URL(`../../bin/kazumi-ech${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url),
);

export function isEchTarget(value) {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    !url.password &&
    HOSTS.has(url.hostname)
  );
}

export function parseEchConfig(data) {
  if (data.Status !== 0) throw new Error('ECH DNS 查询失败');
  for (const answer of data.Answer || []) {
    if (answer.type !== 65) continue;
    const match = /(?:^|\s)ech="?([A-Za-z0-9+/]+={0,2})"?(?=\s|$)/.exec(answer.data || '');
    if (match) {
      const bytes = Buffer.from(match[1], 'base64');
      if (bytes.length < 4 || bytes.length > 65536 || bytes.toString('base64') !== match[1])
        throw new Error('ECH DNS 配置格式无效');
      return { value: match[1], ttl: Math.max(5, Math.min(300, Number(answer.TTL) || 60)) };
    }
  }
  throw new Error('DNS 未返回可用的 Cloudflare ECH 配置');
}

function execute(binary, input, signal, children) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    const chunks = [];
    let size = 0;
    let stderr = '';
    let failure;
    const stop = (error) => {
      failure ||= error instanceof Error ? error : new Error(String(error));
      child.kill();
    };
    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 ** 2) stop(new Error('ECH 工具响应过大'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(0, 4096);
    });
    child.stdin.on('error', (error) => stop(error));
    child.on('error', (error) => {
      failure = new Error(
        error.code === 'ENOENT'
          ? '找不到 ECH 工具，请先运行 npm run build:ech，或设置 ECH_HELPER_PATH'
          : `无法启动 ECH 工具：${error.message}`,
      );
    });
    child.on('close', (code) => {
      children.delete(child);
      signal.removeEventListener('abort', abort);
      if (failure) {
        failure.echAccepted = stderr.includes('ECH_ACCEPTED');
        return reject(failure);
      }
      if (code !== 0) return reject(new Error(`ECH 工具退出：${stderr || code}`));
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (output.error) {
          const error = new Error(`ECH 请求失败：${output.error}`);
          error.echAccepted = output.echAccepted === true;
          throw error;
        }
        if (output.echAccepted !== true) throw new Error('服务器未接受 ECH，已停止请求');
        resolve(output);
      } catch (error) {
        reject(error);
      }
    });
    if (signal.aborted) abort();
    child.stdin.end(JSON.stringify(input));
  });
}

export function createEchTransport({ lookup, queryConfig, binary = DEFAULT_BINARY }) {
  const children = new Set();
  let config;
  let configRequest;
  let closed = false;
  let active = 0;
  async function getConfig(signal) {
    if (config?.expires > Date.now()) return config.value;
    // Shared DNS discovery has its own bounded lifetime. A cancelled image
    // request must not cancel discovery for the other requests using it.
    configRequest ||= queryConfig()
      .then(parseEchConfig)
      .then(({ value, ttl }) => (config = { value, expires: Date.now() + ttl * 1000 }))
      .finally(() => (configRequest = null));
    let abort;
    try {
      const result = await Promise.race([
        configRequest,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
      return result.value;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  return {
    async request(url, { method = 'GET', headers, body, signal, timeout = 20000 }) {
      if (closed) throw new Error('ECH 通道已关闭');
      signal.throwIfAborted();
      if (!isEchTarget(url)) throw new Error('ECH 仅支持指定的 Bangumi HTTPS 域名');
      const target = new URL(url);
      target.hash = '';
      if (active >= 16) throw new Error('ECH 请求繁忙，请稍后重试');
      active++;
      try {
        if (
          body != null &&
          typeof body !== 'string' &&
          !Buffer.isBuffer(body) &&
          !(body instanceof Uint8Array) &&
          !(body instanceof URLSearchParams)
        )
          throw new Error('ECH 不支持流式请求体');
        const bytes =
          body == null
            ? Buffer.alloc(0)
            : Buffer.from(body instanceof URLSearchParams ? body.toString() : body);
        if (bytes.length > 1024 ** 2) throw new Error('ECH 请求体超过 1 MiB');
        const [echConfig, addresses] = await Promise.all([
          getConfig(signal),
          new Promise((resolve, reject) => {
            lookup(target.hostname, { all: true }, (error, values) =>
              error ? reject(error) : resolve(values.map(({ address }) => address)),
            );
          }),
        ]);
        signal.throwIfAborted();
        if (closed) throw new Error('ECH 通道已关闭');
        const output = await execute(
          binary,
          {
            url: target.href,
            method,
            headers,
            body: bytes.toString('base64'),
            addresses,
            echConfig,
            timeoutMs: Math.min(60000, Math.max(1, timeout)),
          },
          signal,
          children,
        );
        if (!Number.isInteger(output.status) || output.status < 200 || output.status > 599)
          throw new Error('ECH 工具返回无效状态码');
        const responseBody = Buffer.from(output.body || '', 'base64');
        if (responseBody.length > MAX_RESPONSE) throw new Error('ECH 响应超过 8 MiB');
        const responseHeaders = new Headers();
        for (const [name, values] of Object.entries(output.headers || {}))
          for (const value of values) responseHeaders.append(name, value);
        const empty = method === 'HEAD' || [204, 205, 304].includes(output.status);
        return new Response(empty ? null : responseBody, {
          status: output.status,
          headers: responseHeaders,
        });
      } finally {
        active--;
      }
    },
    close() {
      closed = true;
      for (const child of children) child.kill();
    },
  };
}
