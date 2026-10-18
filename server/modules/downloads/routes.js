import { inputText } from '../../lib/validation.js';
import { verificationOwner } from '../verification/interactive.js';

export function registerDownloadRoutes(app, { downloads, store }) {
  app.get('/api/download-settings', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(downloads.settings);
  });
  app.put('/api/download-settings', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await downloads.saveSettings(req.body));
  });
  app.get('/api/downloads', (req, res) => {
    res.set('Cache-Control', 'no-store').json(downloads.list());
  });
  app.post('/api/downloads', async (req, res) => {
    res
      .status(202)
      .set('Cache-Control', 'no-store')
      .json(await downloads.create(req.body));
  });
  app.post('/api/downloads/batch', async (req, res) => {
    const rule = store.get(inputText(req.body?.ruleName, '规则名称', 100));
    res
      .status(202)
      .set('Cache-Control', 'no-store')
      .json(
        await downloads.createBatch(req.body, rule, {
          sessionOwner: verificationOwner(req, res, true),
        }),
      );
  });
  app.delete('/api/downloads', async (req, res) => {
    await downloads.clear();
    res.json({ ok: true });
  });
  app.delete('/api/downloads/batch', async (req, res) => {
    await downloads.removeBatch(req.body?.ids);
    res.json({ ok: true });
  });
  app.delete('/api/downloads/:id', async (req, res) => {
    await downloads.remove(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/downloads/:id/pause', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await downloads.pause(req.params.id));
  });
  app.post('/api/downloads/:id/resume', async (req, res) => {
    res
      .status(202)
      .set('Cache-Control', 'no-store')
      .json(
        await downloads.resume(req.params.id, { sessionOwner: verificationOwner(req, res, true) }),
      );
  });
  app.get('/api/downloads/:id/files/:name', async (req, res, next) => {
    const file = await downloads.file(req.params.id, req.params.name);
    res.type(file.contentType).set('Cache-Control', 'no-store');
    res.sendFile(file.path, { dotfiles: 'deny' }, (error) => {
      if (error) next(error);
    });
  });
  app.get('/api/downloads/:id/download', async (req, res) => {
    await downloads.serveDownload(req, res, req.params.id);
  });
}
