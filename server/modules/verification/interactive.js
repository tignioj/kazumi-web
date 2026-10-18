import { randomBytes } from 'node:crypto';
import { HttpError } from '../../lib/http.js';

const ownerCookie = 'kazumi-verification-owner';

export function verificationOwner(req, res, create = false) {
  const value = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ownerCookie}=`))
    ?.slice(ownerCookie.length + 1);
  if (value && /^[A-Za-z0-9_-]{32}$/.test(value)) return value;
  if (!create) return '';
  const owner = randomBytes(24).toString('base64url');
  res.cookie(ownerCookie, owner, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/api',
  });
  return owner;
}

export function createInteractive(verification) {
  async function interactive(req, res, run, { stream = false, onTimeout } = {}) {
    const controller = new AbortController();
    let task;
    const cancel = () => {
      if (!res.writableEnded) {
        controller.abort(new HttpError('片源请求已取消', 499));
        if (task) verification.remove(task, controller.signal.reason);
      }
    };
    const write = (event) => {
      controller.signal.throwIfAborted();
      if (!res.headersSent) {
        res.set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
      }
      res.write(`${JSON.stringify(event)}\n`);
    };
    res.once('close', cancel);
    try {
      const owner = verificationOwner(req, res, true);
      let result = await verification.start(
        owner,
        (options) =>
          run({
            ...options,
            ...(stream ? { onResult: (result) => write({ type: 'result', result }) } : {}),
          }),
        { signal: controller.signal, onTimeout },
      );
      if (stream) {
        if (result?.type === 'verification') {
          task = verification.get(owner, result.verificationId);
          if (controller.signal.aborted) verification.remove(task, controller.signal.reason);
          write(result);
          await task.done;
          if (task.status === 'failed') throw new HttpError(task.error, 422);
          result = task.result;
        }
        write({ type: 'complete', result });
        res.end();
      } else if (!res.destroyed) {
        res.status(result?.type === 'verification' ? 202 : 200).json(result);
      }
    } catch (error) {
      if (!stream || !res.headersSent) throw error;
      if (!res.destroyed) {
        write({
          type: 'error',
          error: error.status ? error.message : '搜索中断，请重试未完成的片源',
        });
        res.end();
      }
    } finally {
      res.off('close', cancel);
    }
  }
  return interactive;
}
