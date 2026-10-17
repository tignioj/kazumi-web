import {
  awaitVerification,
  ensureVerificationSession,
} from '../features/verification/VerificationHost.jsx';

export async function api(path, options = {}) {
  if (['/rules/search', '/rules/chapters', '/resolve'].includes(path)) {
    await ensureVerificationSession();
    options.signal?.throwIfAborted();
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('服务返回了无法识别的内容，请稍后重试。');
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  if (response.status === 202 && data.type === 'verification')
    return awaitVerification(data, options.signal);
  return data;
}
