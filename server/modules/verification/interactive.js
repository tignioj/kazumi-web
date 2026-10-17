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
  async function interactive(req, res, run) {
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort(new HttpError('片源请求已取消', 499));
    };
    res.once('close', cancel);
    try {
      const result = await verification.start(verificationOwner(req, res, true), run, {
        signal: controller.signal,
      });
      if (!res.destroyed) res.status(result?.type === 'verification' ? 202 : 200).json(result);
    } finally {
      res.off('close', cancel);
    }
  }
  return interactive;
}
