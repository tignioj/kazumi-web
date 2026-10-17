import { HttpError } from '../lib/http.js';

export const secureRequests = (req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.get('sec-fetch-site') === 'cross-site')
      return next(new HttpError('拒绝跨站修改请求', 403));
    if (req.get('origin')) {
      let origin;
      try {
        origin = new URL(req.get('origin'));
      } catch {
        return next(new HttpError('请求 Origin 无效', 403));
      }
      if (origin.host !== req.get('host')) return next(new HttpError('拒绝跨站修改请求', 403));
    }
    if (req.method !== 'DELETE' && !req.is('application/json'))
      return next(new HttpError('请使用 application/json 请求', 415));
  }
  next();
};
