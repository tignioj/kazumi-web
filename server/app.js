import express from 'express';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from './lib/http.js';
import { proxySettingsFor } from '../shared/network-settings.js';
import { RuleStore } from './modules/rules/store.js';
import { WatchStore } from './modules/watch/store.js';
import { NetworkStore } from './modules/network/store.js';
import { LocalMetadataStore } from './modules/metadata/local-store.js';
import { ArchiveManager } from './modules/metadata/archive-manager.js';
import { RuleEngine } from './modules/rules/engine.js';
import { MediaService } from './modules/playback/media.js';
import { ImageCache } from './modules/images/cache.js';
import { createCoverResolver } from './modules/images/cover-resolver.js';
import { BrowserResolver } from './modules/playback/browser-resolver.js';
import { MetadataService } from './modules/metadata/service.js';
import { VerificationTasks } from './modules/verification/tasks.js';
import { DownloadManager } from './modules/downloads/manager.js';
import { secureRequests } from './middleware/security.js';
import { createApiRateLimit } from './middleware/rate-limit.js';
import { apiNotFound, handleError } from './middleware/errors.js';
import { registerFrontend } from './middleware/frontend.js';
import { registerRoutes } from './routes.js';

const directory = dirname(fileURLToPath(import.meta.url));

export async function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || resolve(directory, '../data');
  const network = await new NetworkStore(dataDir).init();
  const clients = new Set();
  const clientFor = (scope) => {
    const client =
      options.httpClient ||
      createHttpClient({
        ...options.httpOptions,
        getProxySettings: () => proxySettingsFor(network.data, scope),
      });
    clients.add(client);
    return client;
  };
  const rulesHttp = clientFor('rules');
  const archiveHttp = clientFor('archive');
  const videoHttp = clientFor('video');
  const imageHttp = clientFor('image');
  const bangumiHttp = clientFor('bangumi');
  const localMetadata =
    !options.metadata && process.env.METADATA_MODE !== 'remote'
      ? await new LocalMetadataStore(resolve(dataDir, 'metadata')).init()
      : null;
  const archive = localMetadata
    ? new ArchiveManager({ store: localMetadata, http: archiveHttp, ...options.archiveOptions })
    : null;
  const metadata = options.metadata || new MetadataService(bangumiHttp, { local: localMetadata });
  const initialRules =
    options.seedRules ??
    (await Promise.all(
      ['DM84', '7sefun'].map(async (name) =>
        JSON.parse(await readFile(resolve(directory, 'defaults', `${name}.json`), 'utf8')),
      ),
    ));
  const browserResolver =
    options.browserResolver === false || process.env.DYNAMIC_RESOLVER === 'false'
      ? null
      : options.browserResolver ||
        new BrowserResolver(videoHttp, {
          timeout: Number(process.env.DYNAMIC_RESOLVER_TIMEOUT_MS || 20000),
          maxConcurrency: Number(process.env.DYNAMIC_RESOLVER_CONCURRENCY || 2),
        });
  const store = await new RuleStore(dataDir, initialRules, {
    dynamicResolver:
      typeof browserResolver?.read === 'function' && browserResolver.available !== false,
  }).init();
  const watchStore = await new WatchStore(dataDir).init();
  const images = await new ImageCache({
    directory: resolve(dataDir, 'images'),
    http: imageHttp,
    resolveUrl: createCoverResolver(imageHttp),
    getNetworkSettings: () => network.data,
    maxBytes: Number(process.env.IMAGE_CACHE_MAX_BYTES ?? 5 * 1024 ** 3),
  }).init();
  const engine = new RuleEngine(videoHttp, { browserResolver });
  const media = new MediaService(videoHttp, undefined, { browserResolver });
  const downloads = await new DownloadManager({
    directory: resolve(dataDir, 'downloads'),
    http: videoHttp,
    media,
    getRule: (name) => store.get(name),
    maxBytes: Math.floor(Number(process.env.VIDEO_CACHE_MAX_GB || 10) * 1024 ** 3),
    ...options.downloadOptions,
  }).init();
  const verification = new VerificationTasks(options.verificationOptions);
  const app = express();
  app.disable('x-powered-by');
  app.use(secureRequests);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createApiRateLimit());
  registerRoutes(app, {
    http: rulesHttp,
    images,
    watchStore,
    network,
    verification,
    metadata,
    archive,
    store,
    engine,
    media,
    downloads,
  });
  app.use('/api', apiNotFound);
  const dist = options.distDir || resolve(directory, '../dist');
  registerFrontend(app, dist);
  app.use(handleError);
  return {
    app,
    store,
    watchStore,
    network,
    downloads,
    archive,
    localMetadata,
    async close() {
      await archive?.close();
      localMetadata?.close();
      verification.close();
      await watchStore.pending;
      await network.pending;
      await downloads.close();
      await images.close();
      await browserResolver?.close();
      media.close?.();
      await Promise.all([...clients].map((client) => client.close()));
    },
  };
}
