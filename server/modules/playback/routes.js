import { inputText } from '../../lib/validation.js';
import { createResolutionLogger } from './diagnostics.js';

export function registerResolveRoute(app, { store, media, downloads, interactive }) {
  app.post('/api/resolve', async (req, res) => {
    const ruleName = inputText(req.body?.ruleName, '规则名称', 100);
    const source = inputText(req.body?.url, '播放地址', 8000);
    const cached = downloads.findComplete(ruleName, source);
    const stream =
      req.accepts('application/x-ndjson') && req.get('accept')?.includes('application/x-ndjson');
    const cachedResult = cached && {
      type: cached.type,
      url: cached.playbackUrl,
      originalUrl: source,
      cached: true,
      downloadId: cached.id,
      nativePlayback: cached.nativePlayback,
    };
    if (cachedResult && !stream) return res.json(cachedResult);
    const rule = cached ? null : store.get(ruleName);
    await interactive(
      req,
      res,
      (options) => {
        if (cached) {
          createResolutionLogger(options)('解析', '命中已完成的视频缓存，使用本地播放地址');
          return cachedResult;
        }
        return media.resolve(rule, source, options);
      },
      {
        stream,
        diagnostics: true,
        errorMessage: '视频解析中断，请重新解析或切换线路',
      },
    );
  });
}

export function registerMediaProxyRoute(app, { media }) {
  app.get('/api/media', async (req, res) => media.proxy(req, res));
}
