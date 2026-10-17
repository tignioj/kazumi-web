import { HttpError } from '../lib/http.js';

export function createApiRateLimit() {
  const clients = new Map();
  return (req, res, next) => {
    if (
      req.path === '/health' ||
      req.path === '/media' ||
      (['GET', 'HEAD'].includes(req.method) && req.path === '/image') ||
      (['GET', 'HEAD'].includes(req.method) &&
        /^\/downloads\/[^/]+\/(?:files\/[^/]+|download)$/.test(req.path))
    )
      return next();
    const key = req.ip;
    let entry = clients.get(key);
    if (!entry || entry.until < Date.now()) {
      entry = { until: Date.now() + 60000, count: 0 };
      clients.set(key, entry);
    }
    if (clients.size > 1000) clients.delete(clients.keys().next().value);
    if (++entry.count > 240) return next(new HttpError('请求过于频繁，请稍后重试', 429));
    next();
  };
}
