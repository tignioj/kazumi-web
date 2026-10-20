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
import { KazumiCoreClient } from './modules/core/client.js';
import { createBrowserEgress } from './lib/browser-egress.js';
import { MediaService } from './modules/playback/media.js';
import { NativeHlsService, registerNativeHlsRoutes } from './modules/playback/native-hls.js';
import { ImageCache } from './modules/images/cache.js';
import { createCoverResolver } from './modules/images/cover-resolver.js';
import { MetadataService } from './modules/metadata/service.js';
import { CommentService } from './modules/metadata/comments.js';
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
        // Undici's HTTP/2 body timeout also fires while a response is paused by
        // downstream backpressure. Media readers pause and cancel ranges during
        // playback/seeks; HTTP/1.1 suspends that timeout while its parser is paused.
        ...(scope === 'video' && { allowH2: false }),
        getProxySettings: (url) => proxySettingsFor(network.data, scope, { url }),
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
  const comments =
    options.comments ||
    (await new CommentService({
      directory: resolve(dataDir, 'comments'),
      http: bangumiHttp,
      ...options.commentOptions,
    }).init());
  const initialRules =
    options.seedRules ??
    (await Promise.all(
      ['DM84', '7sefun'].map(async (name) =>
        JSON.parse(await readFile(resolve(directory, 'defaults', `${name}.json`), 'utf8')),
      ),
    ));
  const core = options.core || new KazumiCoreClient(options.coreOptions);
  const egress =
    options.egress === false
      ? null
      : await createBrowserEgress({
          allowPrivate: videoHttp.allowPrivate,
          host: process.env.KAZUMI_EGRESS_HOST || '127.0.0.1',
          port: Number(process.env.KAZUMI_EGRESS_PORT || 0),
          getProxySettings: (url) => proxySettingsFor(network.data, 'video', { url }),
        });
  const store = await new RuleStore(dataDir, initialRules, { core }).init();
  const watchStore = await new WatchStore(dataDir).init();
  const images = await new ImageCache({
    directory: resolve(dataDir, 'images'),
    http: imageHttp,
    resolveUrl: createCoverResolver(imageHttp),
    getNetworkSettings: () => network.data,
    maxBytes: Number(process.env.IMAGE_CACHE_MAX_BYTES ?? 5 * 1024 ** 3),
  }).init();
  const engine = core;
  const media = new MediaService(videoHttp, undefined, { core });
  const downloads = await new DownloadManager({
    directory: resolve(dataDir, 'downloads'),
    http: videoHttp,
    media,
    getRule: (name) => store.get(name),
    maxBytes: Math.floor(Number(process.env.VIDEO_CACHE_MAX_GB || 10) * 1024 ** 3),
    ...options.downloadOptions,
  }).init();
  const verification = new VerificationTasks(options.verificationOptions);
  const nativeHls = new NativeHlsService({ media, downloads, ...options.nativeHlsOptions });
  const app = express();
  app.disable('x-powered-by');
  app.use(secureRequests);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createApiRateLimit());
  registerNativeHlsRoutes(app, { nativeHls });
  registerRoutes(app, {
    http: rulesHttp,
    images,
    watchStore,
    network,
    verification,
    metadata,
    comments,
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
    comments,
    core,
    egress,
    async close() {
      await archive?.close();
      await comments.close?.();
      localMetadata?.close();
      verification.close();
      await watchStore.pending;
      await network.pending;
      await downloads.close();
      await images.close();
      await egress?.close();
      media.close?.();
      nativeHls.close();
      await Promise.all([...clients].map((client) => client.close()));
    },
  };
}
