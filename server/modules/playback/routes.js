import { inputText } from '../../lib/validation.js';

export function registerResolveRoute(app, { store, media, downloads, interactive }) {
  app.post('/api/resolve', async (req, res) => {
    const ruleName = inputText(req.body?.ruleName, '规则名称', 100);
    const source = inputText(req.body?.url, '播放地址', 8000);
    const cached = downloads.findComplete(ruleName, source);
    if (cached)
      return res.json({
        type: cached.type,
        url: cached.playbackUrl,
        originalUrl: source,
        cached: true,
        downloadId: cached.id,
      });
    const rule = store.get(ruleName);
    await interactive(req, res, (options) => media.resolve(rule, source, options));
  });
}

export function registerMediaProxyRoute(app, { media }) {
  app.get('/api/media', async (req, res) => media.proxy(req, res));
}
