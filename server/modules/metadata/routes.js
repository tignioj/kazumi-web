import { HttpError } from '../../lib/http.js';
import { inputText, pageNumber } from '../../lib/validation.js';
import { categorySearchOptions } from './service.js';

export function registerMetadataRoutes(app, { metadata, archive }) {
  app.get('/api/catalog', async (req, res) => {
    const sort = req.query.sort || 'trending';
    if (!['rank', 'trending'].includes(sort)) throw new HttpError('排序参数无效');
    res.json(await metadata.catalog(sort, pageNumber(req.query.page)));
  });
  app.get('/api/metadata/status', async (req, res) =>
    res.json(archive ? await archive.status() : { mode: 'remote', ready: true }),
  );
  app.post('/api/metadata/update', async (req, res) => {
    if (!archive) throw new HttpError('当前使用远程资料模式', 409);
    void archive.update().catch((error) => console.warn('[metadata]', error.message));
    res.status(202).json(await archive.status());
  });
  app.get('/api/categories', async (req, res) => {
    res.json(
      await metadata.search('', {
        ...categorySearchOptions(req.query),
        page: pageNumber(req.query.page),
      }),
    );
  });
  app.get('/api/calendar', async (req, res) => res.json(await metadata.calendar()));
  app.get('/api/search', async (req, res) =>
    res.json(
      await metadata.search(inputText(req.query.q, '搜索词', 200), {
        page: pageNumber(req.query.page),
      }),
    ),
  );
  app.get('/api/subjects/:id', async (req, res) => res.json(await metadata.subject(req.params.id)));
}
