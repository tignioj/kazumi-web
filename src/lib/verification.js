let sessionPromise;

const requests = [];

const listeners = new Set();

const publish = () => listeners.forEach((listener) => listener(requests[0] || null));

export const abortError = () => new DOMException('请求已取消。', 'AbortError');

export const endpoint = (id) => `/api/verification/${encodeURIComponent(id)}`;

export function verificationFailure(state) {
  const error = new Error(state.error || '验证未完成，请重新搜索或解析。');
  if (state.trace !== undefined) error.trace = state.trace;
  return error;
}

export async function readResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('验证服务返回了无法识别的内容，请重新发起请求。');
  }
  if (!response.ok) {
    const error = new Error(
      data.error ||
        ([404, 410].includes(response.status)
          ? '验证会话已过期，请重新搜索或解析。'
          : `验证请求失败（${response.status}）`),
    );
    error.status = response.status;
    if (data.trace !== undefined) error.trace = data.trace;
    throw error;
  }
  return data;
}

export function ensureVerificationSession() {
  if (!sessionPromise) {
    sessionPromise = fetch('/api/verification-session', { credentials: 'same-origin' })
      .then(readResponse)
      .catch((error) => {
        sessionPromise = undefined;
        throw error;
      });
  }
  return sessionPromise;
}

function dispose(id) {
  return fetch(endpoint(id), {
    method: 'DELETE',
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
}

export function awaitVerification(data, signal) {
  if (typeof data.verificationId !== 'string' || !data.verificationId)
    return Promise.reject(new Error('验证服务没有返回有效的会话，请重新发起请求。'));
  if (signal?.aborted) {
    dispose(data.verificationId);
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const request = {
      id: data.verificationId,
      expiresAt: data.expiresAt,
      finish(error, result) {
        const index = requests.indexOf(request);
        if (index < 0) return;
        requests.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        dispose(request.id);
        publish();
        if (error) reject(error);
        else resolve(result);
      },
    };
    const onAbort = () => request.finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    requests.push(request);
    publish();
  });
}

export function getVerificationRequest() {
  return requests[0] || null;
}

export function subscribeVerification(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
