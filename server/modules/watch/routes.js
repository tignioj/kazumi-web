import { HttpError } from '../../lib/http.js';

export function registerWatchRoutes(app, { watchStore }) {
  app.use('/api/watch-data', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/watch-data', (req, res) => res.json(watchStore.list()));
  app.put('/api/watch-data/library/:id', async (req, res) =>
    res.json(await watchStore.saveLibrary(req.params.id, req.body)),
  );
  app.delete('/api/watch-data/library/:id', async (req, res) =>
    res.json(await watchStore.removeLibrary(req.params.id)),
  );
  app.put('/api/watch-data/history', async (req, res) =>
    res.json(await watchStore.saveHistory(req.body)),
  );
  app.delete('/api/watch-data/history', async (req, res) => {
    if (req.query.key !== undefined && typeof req.query.key !== 'string')
      throw new HttpError('观看记录 key 必须是文本。');
    res.json(await watchStore.removeHistory(req.query.key));
  });
  app.put('/api/watch-data', async (req, res) => res.json(await watchStore.restore(req.body)));
  app.post('/api/watch-data/migrate', async (req, res) =>
    res.json(await watchStore.migrate(req.body)),
  );
}
