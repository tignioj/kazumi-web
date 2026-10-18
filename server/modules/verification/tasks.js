import { randomBytes } from 'node:crypto';
import { HttpError } from '../../lib/http.js';

const id = () => randomBytes(24).toString('base64url');
// Keep browser ownership and task lifetimes here; native verification runs in Kazumi.
export class VerificationTasks {
  constructor({ ttlMs = 5 * 60 * 1000, timeoutMs = 45000, maxTasks = 16 } = {}) {
    this.ttlMs = Math.max(50, Number(ttlMs) || 300000);
    this.timeoutMs = Math.max(50, Number(timeoutMs) || 45000);
    this.maxTasks = Math.max(1, Math.min(64, Number(maxTasks) || 16));
    this.tasks = new Map();
    this.closed = false;
  }

  async start(owner, run, { signal } = {}) {
    if (this.closed) throw new HttpError('验证服务已关闭', 503);
    if (
      this.tasks.size >= this.maxTasks ||
      [...this.tasks.values()].filter((task) => task.owner === owner).length >= 4
    )
      throw new HttpError('验证任务繁忙，请完成或取消现有验证后重试', 429);
    const controller = new AbortController();
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const task = {
      id: id(),
      owner,
      controller,
      challenges: [],
      status: 'running',
      expiresAt: Date.now() + this.ttlMs,
      published: false,
      attempts: new Map(),
      io: Promise.resolve(),
      queued: 0,
    };
    this.tasks.set(task.id, task);
    const abort = () => controller.abort(signal?.reason || new HttpError('请求已取消', 499));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const failWaiters = () => {
      for (const challenge of task.challenges.splice(0)) challenge.reject(controller.signal.reason);
    };
    controller.signal.addEventListener('abort', failWaiters, { once: true });
    task.timeout = setTimeout(
      () => controller.abort(new HttpError('片源请求超时，请重试', 504)),
      this.timeoutMs,
    );
    task.expiry = setTimeout(
      () => this.remove(task, new HttpError('验证会话已过期，请重试', 410)),
      this.ttlMs,
    );
    task.expiry.unref?.();
    task.done = Promise.resolve()
      .then(async () => {
        controller.signal.throwIfAborted();
        return run({
          signal: controller.signal,
          sessionOwner: owner,
          onVerification: (input) => {
            controller.signal.throwIfAborted();
            if (task.challenges.length >= 8)
              throw new HttpError('待验证来源过多，请减少搜索来源', 429);
            clearTimeout(task.timeout);
            const sourceKey = `${input.ruleName}:${input.originalUrl}`;
            const attempt = (task.attempts.get(sourceKey) || 0) + 1;
            task.attempts.set(sourceKey, attempt);
            const pending = new Promise((resolve, reject) => {
              task.challenges.push({ ...input, id: id(), attempt, resolve, reject });
            });
            task.status = 'waiting';
            if (!task.published) {
              task.published = true;
              readyResolve({
                type: 'verification',
                verificationId: task.id,
                expiresAt: task.expiresAt,
              });
            }
            return pending;
          },
        });
      })
      .then((result) => {
        controller.signal.throwIfAborted();
        task.status = 'completed';
        task.result = result;
        if (!task.published) {
          readyResolve(result);
          this.remove(task);
        }
      })
      .catch((error) => {
        task.status = 'failed';
        task.error = error.status ? error.message : '验证后的请求未能完成，请重试或更换来源';
        if (!task.published) {
          readyReject(error);
          this.remove(task);
        }
      })
      .finally(() => {
        clearTimeout(task.timeout);
        controller.signal.removeEventListener('abort', failWaiters);
      });
    try {
      return await ready;
    } finally {
      // Once 202 is delivered the task belongs to its explicit verification
      // session, rather than the now-finished HTTP response.
      signal?.removeEventListener('abort', abort);
    }
  }

  get(owner, taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.owner !== owner) throw new HttpError('验证会话不存在或已过期，请重试', 404);
    if (Date.now() >= task.expiresAt) {
      this.remove(task, new HttpError('验证会话已过期，请重试', 410));
      throw new HttpError('验证会话已过期，请重试', 410);
    }
    return task;
  }

  async locked(task, work) {
    if (task.queued >= 3) throw new HttpError('验证操作过于频繁，请稍后再试', 429);
    task.queued++;
    const pending = task.io.then(() => {
      task.controller.signal.throwIfAborted();
      return work();
    });
    task.io = pending.catch(() => {});
    try {
      return await pending;
    } finally {
      task.queued--;
    }
  }

  state(task) {
    return {
      status: task.status,
      expiresAt: task.expiresAt,
      ...(task.status === 'completed' ? { result: task.result } : {}),
      ...(task.status === 'failed' ? { error: task.error } : {}),
    };
  }

  resume(task, challenge) {
    if (task.challenges[0] !== challenge) return;
    task.challenges.shift();
    task.status = task.challenges.length ? 'waiting' : 'running';
    if (!task.challenges.length)
      task.timeout = setTimeout(
        () => task.controller.abort(new HttpError('验证后的片源请求超时，请重试', 504)),
        this.timeoutMs,
      );
    challenge.resolve();
  }

  async snapshot(owner, taskId) {
    const task = this.get(owner, taskId);
    if (task.status !== 'waiting') return this.state(task);
    return this.locked(task, async () => {
      const challenge = task.challenges[0];
      if (!challenge) return this.state(task);
      const remote = await challenge.snapshot();
      if (remote.status === 'completed') {
        this.resume(task, challenge);
        return this.state(task);
      }
      if (remote.status === 'failed') {
        challenge.reject(new HttpError(remote.error || '原版验证未完成，请重试', 422));
        return { ...this.state(task), status: 'failed', error: remote.error };
      }
      return {
        ...this.state(task),
        challenge: {
          id: challenge.id,
          ruleName: challenge.ruleName,
          originalUrl: challenge.originalUrl,
          url: challenge.originalUrl,
          reason: 'challenge',
          attempt: challenge.attempt,
          mode: 'image',
          image: remote.image || '',
          width: remote.width || 320,
          height: remote.height || 120,
        },
      };
    });
  }

  async action(owner, taskId, input) {
    const task = this.get(owner, taskId);
    return this.locked(task, async () => {
      const challenge = task.challenges[0];
      if (!challenge || input?.challengeId !== challenge.id)
        throw new HttpError('验证画面已更新，请重试', 409);
      const action = input.action;
      if (!action || !['answer', 'continue', 'refresh'].includes(action.type))
        throw new HttpError('不支持的验证操作');
      if (
        action.type === 'answer' &&
        (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 64)
      )
        throw new HttpError('验证码无效');
      const remote = await challenge.action(action);
      if (remote.status === 'completed') this.resume(task, challenge);
      return { ok: true };
    });
  }

  remove(task, reason) {
    this.tasks.delete(task.id);
    clearTimeout(task.timeout);
    clearTimeout(task.expiry);
    if (reason && !task.controller.signal.aborted) task.controller.abort(reason);
  }

  cancel(owner, taskId) {
    this.remove(this.get(owner, taskId), new HttpError('验证已取消', 499));
  }

  close() {
    this.closed = true;
    for (const task of this.tasks.values()) this.remove(task, new HttpError('验证服务已关闭', 503));
  }
}
