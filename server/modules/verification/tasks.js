import { randomBytes } from 'node:crypto';
import { HttpError } from '../../lib/http.js';

const id = () => randomBytes(24).toString('base64url');
const KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'Escape',
  'Space',
]);
const locator = (page, selector) => page.locator(`xpath=${selector}`).first();

// Only pixels and bounded human input cross this boundary. Source HTML, cookies,
// browser debugging endpoints and arbitrary evaluation are never exposed.
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

  async snapshot(owner, taskId) {
    const task = this.get(owner, taskId);
    if (task.status !== 'waiting') return this.state(task);
    return this.locked(task, async () => {
      const challenge = task.challenges[0];
      if (!challenge) return this.state(task);
      const { page, captcha } = challenge;
      let mode = 'page';
      let dimensions = page.viewportSize() || { width: 1280, height: 720 };
      let bytes;
      // A solved form may disappear before the user presses Continue. Fall back
      // to the live page so that the user can still resume the original request.
      if (captcha?.image && captcha.input && captcha.submit) {
        try {
          const element = locator(page, captcha.image);
          if (await element.isVisible()) {
            bytes = await element.screenshot({ type: 'jpeg', quality: 80, timeout: 2500 });
            const bounds = await element.boundingBox();
            if (bounds) dimensions = { width: bounds.width, height: bounds.height };
            mode = 'image';
          }
        } catch {
          /* The page remains available for manual verification. */
        }
      }
      if (!bytes)
        bytes = await page.screenshot({ type: 'jpeg', quality: 75, scale: 'css', timeout: 5000 });
      return {
        ...this.state(task),
        challenge: {
          id: challenge.id,
          ruleName: challenge.ruleName,
          reason: challenge.reason === 'manual' ? 'manual' : 'challenge',
          attempt: challenge.attempt,
          originalUrl: challenge.originalUrl,
          url: page.url(),
          mode,
          ...dimensions,
          image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        },
      };
    });
  }

  async action(owner, taskId, challengeId, action) {
    const task = this.get(owner, taskId);
    return this.locked(task, async () => {
      const challenge = task.challenges[0];
      if (!challenge || challenge.id !== challengeId || task.status !== 'waiting')
        throw new HttpError('验证画面已更新，请稍候再试', 409);
      if (!action || typeof action !== 'object' || Array.isArray(action))
        throw new HttpError('验证操作无效');
      const { page, captcha } = challenge;
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      const point = (value) => {
        if (
          !value ||
          !Number.isFinite(value.x) ||
          !Number.isFinite(value.y) ||
          value.x < 0 ||
          value.y < 0 ||
          value.x >= viewport.width ||
          value.y >= viewport.height
        )
          throw new HttpError('操作位置超出验证画面');
      };
      const text = (maximum) => {
        if (
          typeof action.text !== 'string' ||
          !action.text.length ||
          action.text.length > maximum ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(action.text)
        )
          throw new HttpError(`输入内容须为 1 至 ${maximum} 个字符`);
      };
      const resume = () => {
        task.challenges.shift();
        task.status = task.challenges.length ? 'waiting' : 'running';
        if (!task.challenges.length) {
          clearTimeout(task.timeout);
          task.timeout = setTimeout(
            () => task.controller.abort(new HttpError('验证后的片源请求超时，请重试', 504)),
            this.timeoutMs,
          );
        }
        challenge.resolve();
      };
      switch (action.type) {
        case 'click':
          point(action);
          await page.mouse.click(action.x, action.y);
          break;
        case 'drag':
          if (
            !Array.isArray(action.points) ||
            action.points.length < 2 ||
            action.points.length > 64
          )
            throw new HttpError('拖动轨迹须包含 2 至 64 个位置');
          action.points.forEach(point);
          await page.mouse.move(action.points[0].x, action.points[0].y);
          await page.mouse.down();
          try {
            for (const position of action.points.slice(1))
              await page.mouse.move(position.x, position.y);
          } finally {
            await page.mouse.up();
          }
          break;
        case 'text':
          text(256);
          await page.keyboard.insertText(action.text);
          break;
        case 'key':
          if (!KEYS.has(action.key)) throw new HttpError('不支持的验证按键');
          await page.keyboard.press(action.key);
          break;
        case 'scroll':
          if (!Number.isFinite(action.deltaY) || Math.abs(action.deltaY) > 1500)
            throw new HttpError('滚动距离无效');
          await page.mouse.wheel(0, action.deltaY);
          break;
        case 'answer':
          text(64);
          if (!captcha?.input || !captcha.submit) throw new HttpError('请在验证画面内输入答案');
          await locator(page, captcha.input).fill(action.text, { timeout: 5000 });
          await locator(page, captcha.submit).click({ timeout: 5000 });
          resume();
          break;
        case 'refresh':
          if (captcha?.image && (await locator(page, captcha.image).isVisible()))
            await locator(page, captcha.image).click({ timeout: 5000 });
          else await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
          break;
        case 'continue':
          resume();
          break;
        default:
          throw new HttpError('不支持的验证操作');
      }
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
