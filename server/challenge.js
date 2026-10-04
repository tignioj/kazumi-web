import { JSDOM } from 'jsdom';
import { HttpError } from './http.js';

export function verificationRequired() {
  const error = new HttpError('来源要求人机验证，请完成验证后继续，或更换来源', 422);
  error.code = 'VERIFICATION_REQUIRED';
  return error;
}

// This fixed function also runs inside Chromium. Rule values are data only:
// XPath and literal text are supported; rule JavaScript and regex are never run.
export function inspectChallengeDocument({ config, live = false }, sourceDocument) {
  const document = sourceDocument || globalThis.document;
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    if (!live) return !node.hidden && !node.closest('[hidden]');
    const style = document.defaultView.getComputedStyle(node);
    return (
      style.visibility !== 'hidden' && style.display !== 'none' && node.getClientRects().length > 0
    );
  };
  const select = (expression) => {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > 1000)
      return null;
    try {
      const result = document.evaluate(expression, document, null, 7, null);
      for (let index = 0; index < result.snapshotLength; index++) {
        const node = result.snapshotItem(index);
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (visible(element)) return element;
      }
    } catch {
      // A malformed optional verification selector must not break an otherwise
      // usable source rule or become a browser automation selector.
    }
    return null;
  };
  const body = document.body?.cloneNode(true);
  body?.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
  const text = body?.textContent || '';
  let detected = false;
  let captcha;
  if (config?.enabled) {
    if ([2, 'text'].includes(config.captchaDetectType)) {
      detected =
        typeof config.captchaDetectValue === 'string' &&
        !!config.captchaDetectValue &&
        text.includes(config.captchaDetectValue);
    } else if (![3, 'regex'].includes(config.captchaDetectType)) {
      const selectors = config.captchaDetectValue
        ? [config.captchaDetectValue]
        : [config.captchaImage, config.captchaButton];
      detected = selectors.some((selector) => !!select(selector));
    }
    const image = select(config.captchaImage);
    const input = select(config.captchaInput);
    const submit = select(config.captchaButton);
    if (
      image?.tagName === 'IMG' &&
      input &&
      ['INPUT', 'TEXTAREA'].includes(input.tagName) &&
      !input.disabled &&
      !input.readOnly &&
      (!config.captchaButton || submit)
    ) {
      captcha = {
        image: config.captchaImage,
        input: config.captchaInput,
        ...(submit ? { submit: config.captchaButton } : {}),
      };
      detected = true;
    }
  }
  // Conservative fixed markers. A generic empty search or upstream HTTP error
  // is not evidence that a person can solve a challenge.
  const known = document.querySelectorAll(
    '#challenge-running,#challenge-stage,#cf-challenge-running,form#challenge-form,iframe[src*="recaptcha"][title*="challenge"],iframe[src*="hcaptcha.com"][title*="challenge"]',
  );
  detected ||= [...known].some(visible);
  detected ||=
    /(?:verify (?:that )?you are human|complete the security check|请完成人机验证|请完成安全验证|请输入验证码|拖动滑块完成验证)/i.test(
      text,
    );
  return { detected, ...(captcha ? { captcha } : {}) };
}

export function hasChallenge(raw, rule) {
  const dom = new JSDOM(raw);
  try {
    return inspectChallengeDocument({ config: rule.antiCrawlerConfig }, dom.window.document)
      .detected;
  } finally {
    dom.window.close();
  }
}

export async function inspectBrowserChallenge(page, rule) {
  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(inspectChallengeDocument, {
        config: rule.antiCrawlerConfig,
        live: true,
      });
      if (result.detected) {
        // Image-answer shortcuts operate on the top-level page. Challenges in
        // nested frames remain usable through the screenshot and pointer UI.
        return frame === page.mainFrame() ? result : { detected: true };
      }
    } catch {
      // Frames can navigate while challenge widgets load or finish.
    }
  }
  return { detected: false };
}
