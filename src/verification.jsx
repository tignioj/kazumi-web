import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';

let sessionPromise;
const requests = [];
const listeners = new Set();
const publish = () => listeners.forEach((listener) => listener(requests[0] || null));
const abortError = () => new DOMException('请求已取消。', 'AbortError');
const endpoint = (id) => `/api/verification/${encodeURIComponent(id)}`;

async function readResponse(response) {
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

function externalUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function VerificationDialog({ request }) {
  const dialogRef = useRef(null);
  const transport = useRef(null);
  const latest = useRef(null);
  const gesture = useRef(null);
  const [state, setState] = useState({ status: 'running', expiresAt: request.expiresAt });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [terminalError, setTerminalError] = useState(null);
  const [text, setText] = useState('');
  const [now, setNow] = useState(Date.now());
  const challenge = state.challenge;
  const canInteract = state.status === 'waiting' && !!challenge && !busy && !terminalError;
  const sourceUrl = externalUrl(challenge?.originalUrl || challenge?.url);
  const expiry = Number(state.expiresAt) || Date.parse(state.expiresAt);
  const secondsLeft = Number.isFinite(expiry)
    ? Math.max(0, Math.ceil((expiry - now) / 1000))
    : null;
  const cancel = () =>
    request.finish(terminalError || new Error('已取消验证，可以重新搜索或解析。'));
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const dialog = dialogRef.current;
    const focused = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    const onPageHide = () => request.finish(abortError());
    window.addEventListener('pagehide', onPageHide);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(clock);
      window.removeEventListener('pagehide', onPageHide);
      dialog.close();
      document.body.style.overflow = overflow;
      if (focused?.isConnected) focused.focus?.();
    };
  }, [request]);

  useEffect(() => {
    const life = {
      stopped: false,
      controller: new AbortController(),
      queue: Promise.resolve(),
      timer: null,
      actionBusy: false,
      terminal: false,
    };
    transport.current = life;
    const fail = (reason) => {
      if (life.stopped || life.terminal) return;
      life.terminal = true;
      clearTimeout(life.timer);
      setTerminalError(reason);
      setError('');
    };
    const fetchState = async () => {
      const response = await fetch(endpoint(request.id), {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: life.controller.signal,
      });
      const next = await readResponse(response);
      if (life.stopped || life.terminal) return;
      latest.current = next;
      setState(next);
      if (next.status === 'completed') {
        life.terminal = true;
        request.finish(null, next.result);
      } else if (next.status === 'failed') {
        fail(new Error(next.error || '验证未完成，请重新搜索或解析。'));
      }
    };
    const enqueue = (operation) => {
      life.queue = life.queue.then(async () => {
        if (!life.stopped && !life.terminal) await operation();
      });
      // Keep the serial queue usable after a rejected action.
      life.queue = life.queue.catch((reason) => {
        if (life.stopped || reason.name === 'AbortError') return;
        fail(reason);
      });
      return life.queue;
    };
    const schedule = () => {
      clearTimeout(life.timer);
      if (!life.stopped && !life.terminal)
        life.timer = setTimeout(() => enqueue(fetchState).then(schedule), 1100);
    };
    life.send = async (action, challengeId) => {
      if (life.actionBusy || life.stopped || life.terminal) return false;
      life.actionBusy = true;
      setBusy(true);
      setError('');
      clearTimeout(life.timer);
      let accepted = false;
      await enqueue(async () => {
        if (latest.current?.status !== 'waiting' || latest.current.challenge?.id !== challengeId)
          return;
        try {
          const response = await fetch(`${endpoint(request.id)}/action`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeId, action }),
            signal: life.controller.signal,
          });
          await readResponse(response);
          accepted = true;
        } catch (reason) {
          if ([404, 410].includes(reason.status)) throw reason;
          if (!life.stopped) setError(reason.message || '操作没有送达，请重试。');
        }
        await fetchState();
      });
      life.actionBusy = false;
      if (!life.stopped) setBusy(false);
      schedule();
      return accepted;
    };
    enqueue(fetchState).then(schedule);
    return () => {
      life.stopped = true;
      clearTimeout(life.timer);
      life.controller.abort();
    };
  }, [request]);

  useEffect(() => {
    setText('');
    setError('');
    gesture.current = null;
  }, [challenge?.id]);

  useEffect(() => {
    if (!Number.isFinite(expiry) || now < expiry || terminalError) return;
    const reason = new Error('验证会话已过期，请关闭后重新搜索或解析。');
    if (transport.current) {
      transport.current.terminal = true;
      transport.current.controller.abort();
      clearTimeout(transport.current.timer);
    }
    setTerminalError(reason);
  }, [expiry, now, terminalError]);

  const send = (action) => {
    if (!canInteract) return Promise.resolve(false);
    return transport.current?.send(action, challenge.id) || Promise.resolve(false);
  };
  const point = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          challenge.width - 1,
          Math.round(((event.clientX - bounds.left) / bounds.width) * challenge.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          challenge.height - 1,
          Math.round(((event.clientY - bounds.top) / bounds.height) * challenge.height),
        ),
      ),
    };
  };
  const addPoint = (event) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = point(event);
    const previous = active.points.at(-1);
    if (Math.hypot(next.x - previous.x, next.y - previous.y) >= 2) active.points.push(next);
    if (active.points.length > 64)
      active.points = active.points.filter(
        (_, index) => index === 0 || index % 2 === 1 || index === active.points.length - 1,
      );
  };
  const submitText = async (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    if (await send({ type: challenge.mode === 'image' ? 'answer' : 'text', text })) setText('');
  };

  return (
    <dialog
      ref={dialogRef}
      className="verification-dialog"
      aria-labelledby="verification-title"
      aria-describedby="verification-description"
      onCancel={(event) => {
        event.preventDefault();
        cancelRef.current();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="verification-header">
        <div>
          <h2 id="verification-title">
            {challenge?.reason === 'manual' ? '检查来源页面' : '来源网站需要验证'}
          </h2>
          <p>{challenge?.ruleName || '正在准备验证会话'}</p>
        </div>
        <button className="icon-button" aria-label="取消验证" onClick={cancel} autoFocus>
          <X size={20} />
        </button>
      </header>
      <p id="verification-description" className="verification-description">
        {challenge?.reason === 'manual'
          ? '自动解析尚未找到视频。请检查下方页面，完成所需操作后继续解析。'
          : '请亲自完成下方验证码，验证通过后会继续刚才的搜索或播放。'}
      </p>
      <div className="verification-meta">
        <span>
          {secondsLeft !== null
            ? `会话剩余 ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`
            : '验证会话已保留'}
        </span>
        {sourceUrl && (
          <a className="text-button" href={sourceUrl} target="_blank" rel="noreferrer">
            打开来源网站 <ExternalLink size={13} />
          </a>
        )}
      </div>
      {challenge?.attempt > 1 && !terminalError && (
        <p className="verification-help" role="status">
          来源仍要求验证，请检查后重试。
        </p>
      )}
      {terminalError ? (
        <div className="notice" role="alert">
          <CircleAlert size={19} />
          <span>{terminalError.message}</span>
        </div>
      ) : (
        <>
          {state.status === 'running' || !challenge ? (
            <div className="verification-loading" role="status">
              <LoaderCircle size={23} className="spin" />
              <span>正在处理，请稍候…</span>
            </div>
          ) : (
            <>
              <div
                className={`verification-preview ${challenge.mode === 'image' ? 'verification-image' : ''}`}
              >
                {challenge.image ? (
                  <img
                    src={challenge.image}
                    width={challenge.width}
                    height={challenge.height}
                    alt={
                      challenge.mode === 'image'
                        ? '来源网站的验证码'
                        : '来源网站验证页面，可点击或拖动操作'
                    }
                    draggable="false"
                    className={challenge.mode === 'page' ? 'verification-interactive' : ''}
                    aria-disabled={!canInteract}
                    onPointerDown={(event) => {
                      if (!canInteract || challenge.mode !== 'page' || event.button !== 0) return;
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      gesture.current = {
                        pointerId: event.pointerId,
                        challengeId: challenge.id,
                        points: [point(event)],
                      };
                    }}
                    onPointerMove={(event) => {
                      if (gesture.current) addPoint(event);
                    }}
                    onPointerUp={(event) => {
                      const active = gesture.current;
                      if (!active || active.pointerId !== event.pointerId) return;
                      addPoint(event);
                      gesture.current = null;
                      if (event.currentTarget.hasPointerCapture(event.pointerId))
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      if (active.challengeId !== challenge.id) return;
                      const points = active.points;
                      const moved = points.some(
                        (p) => Math.hypot(p.x - points[0].x, p.y - points[0].y) >= 4,
                      );
                      send(moved ? { type: 'drag', points } : { type: 'click', ...points[0] });
                    }}
                    onPointerCancel={() => {
                      gesture.current = null;
                    }}
                  />
                ) : (
                  <div className="verification-loading" role="status">
                    <LoaderCircle className="spin" size={21} />
                    正在获取验证画面…
                  </div>
                )}
              </div>
              {challenge.mode === 'page' && (
                <>
                  <p className="verification-help">
                    点击或拖动上方页面完成验证。需要输入时，先点击页面中的输入框，再在下方填写并发送。
                  </p>
                  <div className="verification-tools">
                    <button
                      className="button quiet"
                      disabled={!canInteract}
                      onClick={() => send({ type: 'key', key: 'Tab' })}
                    >
                      切换输入框
                    </button>
                    <button
                      className="button quiet"
                      disabled={!canInteract}
                      onClick={() => send({ type: 'key', key: 'Backspace' })}
                    >
                      退格
                    </button>
                    <button
                      className="button quiet"
                      disabled={!canInteract}
                      onClick={() => send({ type: 'key', key: 'Enter' })}
                    >
                      回车
                    </button>
                    <button
                      className="button quiet"
                      disabled={!canInteract}
                      aria-label="来源页面向上滚动"
                      onClick={() => send({ type: 'scroll', deltaY: -400 })}
                    >
                      <ArrowUp size={16} />
                      上滚
                    </button>
                    <button
                      className="button quiet"
                      disabled={!canInteract}
                      aria-label="来源页面向下滚动"
                      onClick={() => send({ type: 'scroll', deltaY: 400 })}
                    >
                      <ArrowDown size={16} />
                      下滚
                    </button>
                  </div>
                </>
              )}
              <form className="verification-input" onSubmit={submitText}>
                <label htmlFor="verification-answer">
                  {challenge.mode === 'image' ? '验证码' : '发送到选中输入框的内容'}
                </label>
                <div>
                  <input
                    id="verification-answer"
                    autoComplete="off"
                    spellCheck="false"
                    maxLength={challenge.mode === 'image' ? 64 : 256}
                    value={text}
                    disabled={!canInteract}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <button
                    className="button primary"
                    type="submit"
                    disabled={!canInteract || !text.trim()}
                  >
                    {challenge.mode === 'image' ? '提交验证码' : '发送文字'}
                  </button>
                </div>
              </form>
              {error && (
                <div className="notice" role="alert">
                  <CircleAlert size={19} />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </>
      )}
      <footer className="verification-actions">
        {challenge && !terminalError && (
          <button
            className="button quiet"
            disabled={!canInteract}
            onClick={() => send({ type: 'refresh' })}
          >
            <RefreshCw size={15} />
            刷新验证
          </button>
        )}
        <div>
          <button className="button quiet" onClick={cancel}>
            {terminalError ? '关闭' : '取消验证'}
          </button>
          {challenge?.mode === 'page' && !terminalError && (
            <button
              className="button primary"
              disabled={!canInteract}
              onClick={() => send({ type: 'continue' })}
            >
              {busy && <LoaderCircle size={15} className="spin" />}验证完成，继续
            </button>
          )}
        </div>
      </footer>
    </dialog>
  );
}

export function VerificationHost() {
  const [request, setRequest] = useState(() => requests[0] || null);
  useEffect(() => {
    listeners.add(setRequest);
    setRequest(requests[0] || null);
    return () => listeners.delete(setRequest);
  }, []);
  return request ? <VerificationDialog key={request.id} request={request} /> : null;
}
