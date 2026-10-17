import express from 'express';
import { resolve } from 'node:path';

export function registerFrontend(app, dist) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return res.status(404).json({ error: '页面不存在' });
    res.set('Cache-Control', 'no-cache').sendFile(resolve(dist, 'index.html'), (error) => {
      if (error && !res.headersSent)
        res.status(404).json({ error: '前端尚未构建，请先执行 npm run build 或使用 npm run dev' });
      else if (error) next(error);
    });
  });
}
