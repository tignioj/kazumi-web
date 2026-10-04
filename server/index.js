import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHttpClient, HttpError } from './http.js';
import { RuleStore } from './store.js';
import { RuleEngine } from './rules.js';
import { MediaService } from './media.js';
import { MetadataService } from './metadata.js';

const directory = dirname(fileURLToPath(import.meta.url));

function inputText(value, label, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new HttpError(`${label}不能为空且不能超过 ${maximum} 个字符`);
  return value.trim();
}
function pageNumber(value) {
  const page = Number(value ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 1000)
    throw new HttpError('页码必须为 1 至 1000');
  return page;
}

export async function createApp(options = {}) {
  const http = options.httpClient || createHttpClient();
  const metadata = options.metadata || new MetadataService(http);
  const initialRules =
    options.seedRules ??
    (await Promise.all(
      ['DM84', '7sefun'].map(async (name) =>
        JSON.parse(await readFile(resolve(directory, 'defaults', `${name}.json`), 'utf8')),
      ),
    ));
  const store = await new RuleStore(
    options.dataDir || process.env.DATA_DIR || resolve(directory, '../data'),
    initialRules,
  ).init();
  const engine = new RuleEngine(http);
  const media = new MediaService(http);
  const repository = (
    process.env.RULES_REPOSITORY || 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/'
  ).replace(/\/?$/, '/');
  let catalogCache;
  async function officialRules() {
    if (catalogCache && catalogCache.expires > Date.now()) return catalogCache.rules;
    const rules = await http.json(`${repository}index.json`);
    if (!Array.isArray(rules)) throw new HttpError('规则仓库索引无效', 502);
    catalogCache = {
      rules: rules.filter((rule) => typeof rule.name === 'string'),
      expires: Date.now() + 300000,
    };
    return catalogCache.rules;
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
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
  });
  app.use(express.json({ limit: '2mb' }));
  const clients = new Map();
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/media') return next();
    const key = req.ip;
    let entry = clients.get(key);
    if (!entry || entry.until < Date.now()) {
      entry = { until: Date.now() + 60000, count: 0 };
      clients.set(key, entry);
    }
    if (clients.size > 1000) clients.delete(clients.keys().next().value);
    if (++entry.count > 240) return next(new HttpError('请求过于频繁，请稍后重试', 429));
    next();
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/catalog', async (req, res) => {
    const sort = req.query.sort || 'trending';
    if (!['rank', 'trending'].includes(sort)) throw new HttpError('排序参数无效');
    res.json(await metadata.catalog(sort, pageNumber(req.query.page)));
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
  app.get('/api/rules', (req, res) => res.json({ rules: store.list() }));
  app.get('/api/rules/catalog', async (req, res) => res.json({ rules: await officialRules() }));
  app.post('/api/rules/import', async (req, res) =>
    res.json({ rules: await store.import(req.body?.content) }),
  );
  app.post('/api/rules/install', async (req, res) => {
    const name = inputText(req.body?.name, '规则名称', 100);
    const listed = (await officialRules()).find(
      (rule) => rule.name.toLowerCase() === name.toLowerCase(),
    );
    if (!listed) throw new HttpError('官方规则仓库中找不到此规则', 404);
    const rule = await http.json(`${repository}${encodeURIComponent(listed.name)}.json`);
    res.json({ rules: await store.import(rule) });
  });
  app.put('/api/rules/:name', async (req, res) =>
    res.json({ rules: await store.replace(req.params.name, req.body) }),
  );
  app.delete('/api/rules/:name', async (req, res) =>
    res.json({ rules: await store.remove(req.params.name) }),
  );
  app.post('/api/rules/search', async (req, res) => {
    const keyword = inputText(req.body?.keyword, '搜索词', 200);
    const names = req.body?.ruleNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    )
      throw new HttpError('ruleNames 必须是规则名称数组');
    const rules = names
      ? names.map((name) => store.get(name))
      : store.list().filter((rule) => rule.enabled !== false);
    if (rules.length > 30) throw new HttpError('一次最多搜索 30 个来源，请选择部分规则');
    const results = [];
    // Bound external concurrency to avoid overwhelming small Compose hosts.
    for (let index = 0; index < rules.length; index += 4) {
      results.push(
        ...(await Promise.all(
          rules.slice(index, index + 4).map(async (rule) => {
            try {
              return { ruleName: rule.name, items: await engine.search(rule, keyword) };
            } catch (error) {
              return { ruleName: rule.name, items: [], error: error.message };
            }
          }),
        )),
      );
    }
    res.json({ results });
  });
  app.post('/api/rules/chapters', async (req, res) => {
    const rule = store.get(inputText(req.body?.ruleName, '规则名称', 100));
    const roads = await engine.chapters(rule, inputText(req.body?.url, '条目地址', 8000));
    if (!roads.length) throw new HttpError('来源未返回可播放剧集，请更新规则或更换来源', 422);
    res.json({ roads });
  });
  app.post('/api/resolve', async (req, res) =>
    res.json(
      await media.resolve(
        store.get(inputText(req.body?.ruleName, '规则名称', 100)),
        inputText(req.body?.url, '播放地址', 8000),
      ),
    ),
  );
  app.get('/api/media', async (req, res) => media.proxy(req, res));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API 不存在' }));
  const dist = options.distDir || resolve(directory, '../dist');
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
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status === 500) console.error('[kazumi-web]', error);
    res
      .status(status)
      .json({
        error:
          error.type === 'entity.parse.failed'
            ? '请求 JSON 格式无效'
            : status === 500
              ? '服务器处理请求失败'
              : error.message,
      });
  });
  return { app, store, close: () => http.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { app, close } = await createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () =>
    console.log(`Kazumi Web listening on http://${host}:${port}`),
  );
  function shutdown() {
    const timer = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await close();
      clearTimeout(timer);
      process.exit(0);
    });
    server.closeIdleConnections();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
