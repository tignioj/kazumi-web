import { randomUUID } from 'node:crypto';
import { HttpError } from '../../lib/http.js';

export function hasAutomaticCaptcha(rule) {
  return (
    rule.antiCrawlerConfig?.enabled === true && [2, 3].includes(rule.antiCrawlerConfig.captchaType)
  );
}

// Runs only in the challenged Chromium document. Its bridge can report progress;
// it cannot call Node APIs. A fresh document receives a fresh per-document state.
function runInDocument({ type, button, binding }, script) {
  if (window.__kazumiRuleCaptcha) return window.__kazumiRuleCaptcha.promise;
  let resolve;
  const state = {
    clicked: false,
    finished: false,
    promise: new Promise((done) => {
      resolve = done;
    }),
  };
  window.__kazumiRuleCaptcha = state;
  let poller, observer;
  const notify = (type, message = '') =>
    window[binding]({ type, message: String(message).slice(0, 500) }).catch(() => {});
  const finish = (status, message = '') => {
    if (state.finished) return;
    state.finished = true;
    clearInterval(poller);
    observer?.disconnect();
    void notify(status, message);
    resolve({ status, message: String(message).slice(0, 500) });
  };
  window.KazumiCaptcha = {
    log: (message) => {
      console.debug('[KazumiCaptcha]', String(message));
      void notify('log', message);
    },
    clicked: () => {
      state.clicked = true;
      void notify('clicked');
    },
    done: () => finish('done'),
    // Native fail reports a diagnostic; scripts may still recover and call done.
    fail: (message) => {
      void notify('diagnostic', message);
    },
  };
  if (type === 3) {
    try {
      const result = script();
      if (result === true) window.KazumiCaptcha.done();
      else if (result?.then)
        Promise.resolve(result).catch((error) => finish('failed', error?.message || error));
    } catch (error) {
      finish('failed', error?.message || error);
    }
  } else {
    const inspect = async () => {
      if (state.finished) return;
      try {
        const node = document.evaluate(
          button,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (state.clicked) {
          if (!node) finish('done');
        } else if (node && !node.disabled) {
          state.clicked = true;
          await notify('clicked');
          node.click();
          if (
            !document.evaluate(button, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
              .singleNodeValue
          )
            finish('done');
        }
      } catch (error) {
        finish('failed', error?.message || error);
      }
    };
    observer = new MutationObserver(() => {
      void inspect();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    poller = setInterval(() => {
      void inspect();
    }, 500);
    void inspect();
  }
  return state.promise;
}

export async function automateRuleCaptcha(
  page,
  rule,
  { signal, timeout = 20000, frame = page.mainFrame() } = {},
) {
  signal?.throwIfAborted();
  const config = rule.antiCrawlerConfig;
  const binding = `__kazumiCaptcha_${randomUUID().replaceAll('-', '')}`;
  const input = { type: config.captchaType, button: config.captchaButton, binding };
  const script = config.captchaType === 3 ? `function () {\n${config.captchaScript}\n}` : 'null';
  const expression = `(${runInDocument.toString()})(${JSON.stringify(input)}, ${script})`;
  let complete, fail;
  const result = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  void result.catch(() => {});
  let clicked = false;
  let diagnostic = '';
  let settled = false;
  const finish = (value) => {
    if (!settled) {
      settled = true;
      complete(value);
    }
  };
  const reject = (error) => {
    if (!settled) {
      settled = true;
      fail(error);
    }
  };
  const abort = () =>
    reject(
      signal.reason instanceof HttpError ? signal.reason : new HttpError('来源验证已取消', 499),
    );
  const timer = setTimeout(
    () =>
      reject(
        new HttpError(
          `规则自动验证超时${diagnostic ? `：${diagnostic}` : '，请修改规则或重试'}`,
          504,
        ),
      ),
    timeout,
  );
  signal?.addEventListener('abort', abort, { once: true });
  const execute = () => {
    void frame
      .waitForLoadState('domcontentloaded', { timeout })
      .then(() => {
        if (!settled) return frame.evaluate(expression);
      })
      .then((value) => {
        if (value) finish(value);
      })
      .catch((error) => {
        if (signal?.aborted) return abort();
        if (
          /Execution context was destroyed|Cannot find context|frame was detached|Frame was detached|navigation/i.test(
            error.message,
          )
        )
          return;
        reject(new HttpError('规则自动验证无法执行，请检查脚本或按钮配置', 422));
      });
  };
  const navigated = (target) => {
    if (target !== frame || settled) return;
    if (config.captchaType === 2 && clicked) finish({ status: 'done' });
    else execute();
  };
  const detached = (target) => {
    if (target === frame) finish({ status: 'done' });
  };
  try {
    await page.context().exposeBinding(binding, ({ frame: source }, event) => {
      if (source !== frame || settled) return;
      if (event?.type === 'clicked') clicked = true;
      else if (event?.type === 'diagnostic') diagnostic = String(event.message).slice(0, 500);
      else if (event?.type === 'done') finish({ status: 'done' });
      else if (event?.type === 'failed')
        finish({ status: 'failed', message: String(event.message).slice(0, 500) });
    });
    page.on('framenavigated', navigated);
    page.on('framedetached', detached);
    if (signal?.aborted) abort();
    else execute();
    const outcome = await result;
    if (outcome.status !== 'done') throw new HttpError(`规则自动验证失败：${outcome.message}`, 422);
    if (!frame.isDetached()) await frame.waitForLoadState('domcontentloaded', { timeout });
    signal?.throwIfAborted();
  } finally {
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    page.off('framenavigated', navigated);
    page.off('framedetached', detached);
  }
}
