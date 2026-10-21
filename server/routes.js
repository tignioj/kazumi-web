import { registerWatchRoutes } from './modules/watch/routes.js';
import { registerVerificationRoutes } from './modules/verification/routes.js';
import { createInteractive } from './modules/verification/interactive.js';
import { registerMetadataRoutes } from './modules/metadata/routes.js';
import { registerRuleRoutes } from './modules/rules/routes.js';
import { registerRuleTestRoute } from './modules/rules/test-route.js';
import { registerResolveRoute, registerMediaProxyRoute } from './modules/playback/routes.js';
import { registerDownloadRoutes } from './modules/downloads/routes.js';
import { registerNetworkRoutes } from './modules/network/routes.js';

export function registerRoutes(
  app,
  {
    http,
    network,
    images,
    watchStore,
    verification,
    metadata,
    comments,
    archive,
    store,
    engine,
    media,
    downloads,
  },
) {
  const interactive = createInteractive(verification);
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/image', async (req, res) => images.serve(req, res));
  registerWatchRoutes(app, { watchStore });
  registerNetworkRoutes(app, { network, http });
  registerVerificationRoutes(app, { verification });
  registerMetadataRoutes(app, { metadata, archive, comments });
  registerRuleRoutes(app, { http, store, engine, interactive });
  registerRuleTestRoute(app, {
    validationOptions: store.validationOptions,
    engine,
    media,
    interactive,
  });
  registerResolveRoute(app, { store, media, downloads, interactive });
  registerDownloadRoutes(app, { downloads, store });
  registerMediaProxyRoute(app, { media });
}
