import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createHttpClient, HttpError } from './http.js';
import { RuleStore } from './store.js';
import { WatchStore } from './watch-store.js';
import { LocalMetadataStore } from './local-metadata.js';
import { ArchiveManager } from './archive-manager.js';
import {
  availableRuleUpdates,
  downloadOfficialRule,
  updateInstalledRules,
} from './rule-updates.js';
import { RuleEngine } from './rules.js';
import { MediaService } from './media.js';
import { ImageCache } from './images.js';
import { createCoverResolver } from './cover-resolver.js';
import { BrowserResolver } from './browser-resolver.js';
import { MetadataService, categorySearchOptions } from './metadata.js';
import { VerificationTasks } from './verification.js';
import { DownloadManager } from './downloads.js';

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
  const dataDir = options.dataDir || process.env.DATA_DIR || resolve(directory, '../data');
  const localMetadata =
    !options.metadata && process.env.METADATA_MODE !== 'remote'
      ? await new LocalMetadataStore(resolve(dataDir, 'metadata')).init()
      : null;
  const archive = localMetadata
    ? new ArchiveManager({ store: localMetadata, http, ...options.archiveOptions })
    : null;
  const metadata = options.metadata || new MetadataService(http, { local: localMetadata });
  const initialRules =
    options.seedRules ??
    (await Promise.all(
      ['DM84', '7sefun'].map(async (name) =>
        JSON.parse(await readFile(resolve(directory, 'defaults', `${name}.json`), 'utf8')),
      ),
    ));
  const store = await new RuleStore(dataDir, initialRules).init();
  const watchStore = await new WatchStore(dataDir).init();
  const images = await new ImageCache({
    directory: resolve(dataDir, 'images'),
    http,
    resolveUrl: createCoverResolver(http),
    maxBytes: Number(process.env.IMAGE_CACHE_MAX_BYTES ?? 256 * 1024 ** 2),
  }).init();
  const browserResolver =
    options.browserResolver === false || process.env.DYNAMIC_RESOLVER === 'false'
      ? null
      : options.browserResolver ||
        new BrowserResolver(http, {
          timeout: Number(process.env.DYNAMIC_RESOLVER_TIMEOUT_MS || 20000),
          maxConcurrency: Number(process.env.DYNAMIC_RESOLVER_CONCURRENCY || 2),
        });
  const engine = new RuleEngine(http, { browserResolver });
  const media = new MediaService(http, undefined, { browserResolver });
  const downloads = await new DownloadManager({
    directory: resolve(dataDir, 'downloads'),
    http,
    media,
    maxBytes: Math.floor(Number(process.env.VIDEO_CACHE_MAX_GB || 10) * 1024 ** 3),
    ...options.downloadOptions,
  }).init();
  const verification = new VerificationTasks(options.verificationOptions);
  const repository = (
    process.env.RULES_REPOSITORY || 'https://raw.githubusercontent.com/Predidit/KazumiRules/main/'
  ).replace(/\/?$/, '/');
  let catalogCache;
  async function officialRules(refresh = false) {
    if (!refresh && catalogCache && catalogCache.expires > Date.now()) return catalogCache.rules;
    const rules = await http.json(`${repository}index.json`);
    if (!Array.isArray(rules)) throw new HttpError('规则仓库索引无效', 502);
    catalogCache = {
      rules: rules.filter((rule) => typeof rule.name === 'string'),
      expires: Date.now() + 60 * 60 * 1000,
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
  const ownerCookie = 'kazumi-verification-owner';
  function verificationOwner(req, res, create = false) {
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
  const clients = new Map();
  app.use('/api', (req, res, next) => {
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
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/image', async (req, res) => images.serve(req, res));
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
  app.get('/api/verification-session', (req, res) => {
    verificationOwner(req, res, true);
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.use('/api/verification', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/verification/:id', async (req, res) => {
    res.json(await verification.snapshot(verificationOwner(req, res), req.params.id));
  });
  app.post('/api/verification/:id/action', async (req, res) => {
    res.json(
      await verification.action(
        verificationOwner(req, res),
        req.params.id,
        req.body?.challengeId,
        req.body?.action,
      ),
    );
  });
  app.delete('/api/verification/:id', (req, res) => {
    verification.cancel(verificationOwner(req, res), req.params.id);
    res.json({ ok: true });
  });
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
  app.get('/api/rules', (req, res) => res.json({ rules: store.list() }));
  app.get('/api/rules/updates', async (req, res) => {
    const catalog = await officialRules();
    res.json({ updates: availableRuleUpdates(store.list(), catalog) });
  });
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
    const rule = await downloadOfficialRule(http, repository, listed.name);
    res.json({ rules: await store.import(rule) });
  });
  app.post('/api/rules/update', async (req, res) => {
    const name =
      req.body?.name === undefined ? undefined : inputText(req.body.name, '规则名称', 100);
    if (name) store.get(name);
    res.json(await updateInstalledRules(store, http, repository, await officialRules(true), name));
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
    await interactive(req, res, async (options) => {
      const results = [];
      // Bound external concurrency to avoid overwhelming small Compose hosts.
      for (let index = 0; index < rules.length; index += 4) {
        options.signal.throwIfAborted();
        results.push(
          ...(await Promise.all(
            rules.slice(index, index + 4).map(async (rule) => {
              try {
                return { ruleName: rule.name, items: await engine.search(rule, keyword, options) };
              } catch (error) {
                options.signal.throwIfAborted();
                return { ruleName: rule.name, items: [], error: error.message };
              }
            }),
          )),
        );
      }
      return { results };
    });
  });
  app.post('/api/rules/chapters', async (req, res) => {
    const rule = store.get(inputText(req.body?.ruleName, '规则名称', 100));
    const source = inputText(req.body?.url, '条目地址', 8000);
    await interactive(req, res, async (options) => {
      const roads = await engine.chapters(rule, source, options);
      if (!roads.length) throw new HttpError('来源未返回可播放剧集，请更新规则或更换来源', 422);
      return { roads };
    });
  });
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
      .json(await downloads.createBatch(req.body, rule));
  });
  app.delete('/api/downloads', async (req, res) => {
    await downloads.clear();
    res.json({ ok: true });
  });
  app.delete('/api/downloads/:id', async (req, res) => {
    await downloads.remove(req.params.id);
    res.json({ ok: true });
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
    if (res.destroyed) return;
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status === 500) console.error('[kazumi-web]', error);
    res.status(status).json({
      error:
        error.type === 'entity.parse.failed'
          ? '请求 JSON 格式无效'
          : status === 500
            ? '服务器处理请求失败'
            : error.message,
    });
  });
  return {
    app,
    store,
    watchStore,
    downloads,
    archive,
    localMetadata,
    async close() {
      await archive?.close();
      localMetadata?.close();
      verification.close();
      await watchStore.pending;
      await downloads.close();
      await images.close();
      await browserResolver?.close();
      media.close?.();
      await http.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { app, close, archive } = await createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`Kazumi Web listening on http://${host}:${port}`);
    archive?.start();
  });
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
