import { awaitVerification } from './verification.js';

export async function readSearchStream(
  response,
  {
    signal,
    onResult,
    onDiagnostic,
    interruptedMessage = '搜索连接已中断，已保留收到的结果，请重试未完成的片源。',
  },
) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const verification = new AbortController();
  let pending = '';
  let complete = false;
  let verificationError;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'result') onResult?.(event.result);
    if (event.type === 'diagnostic') onDiagnostic?.(event.diagnostic);
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'verification') {
      void awaitVerification(
        event,
        AbortSignal.any([verification.signal, ...(signal ? [signal] : [])]),
      ).catch((error) => {
        if (!complete) {
          verificationError = error;
          cancel();
        }
      });
    }
    if (event.type === 'complete') {
      complete = true;
      return event.result;
    }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      if (verificationError) throw verificationError;
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (verificationError) throw verificationError;
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop();
      if (done && pending) lines.push(pending);
      for (const line of lines) {
        const result = consume(line);
        if (complete) return result;
      }
      if (done) throw new Error(interruptedMessage);
    }
  } finally {
    complete = true;
    signal?.removeEventListener('abort', cancel);
    verification.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
