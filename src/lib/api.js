import { awaitVerification, ensureVerificationSession } from './verification.js';
import { readSearchStream } from './search-stream.js';

export async function api(path, { onResult, onDiagnostic, ...options } = {}) {
  if (['/rules/search', '/rules/chapters', '/resolve', '/rules/test'].includes(path)) {
    await ensureVerificationSession();
    options.signal?.throwIfAborted();
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(onResult || onDiagnostic ? { Accept: 'application/x-ndjson' } : {}),
      ...options.headers,
    },
  });
  if (response.ok && response.headers.get('content-type')?.includes('application/x-ndjson'))
    return readSearchStream(response, {
      signal: options.signal,
      onResult,
      onDiagnostic,
      ...(path === '/rules/test'
        ? { interruptedMessage: '规则测试连接已中断，请重新测试。' }
        : path === '/resolve'
          ? { interruptedMessage: '解析连接已中断，请重新解析或切换线路。' }
          : {}),
    });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('服务返回了无法识别的内容，请稍后重试。');
  }
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    if (data.trace !== undefined) error.trace = data.trace;
    throw error;
  }
  if (response.status === 202 && data.type === 'verification')
    return awaitVerification(data, options.signal);
  return data;
}
