import { registerImageRoutes } from './modules/images/routes.js';
import { registerWatchRoutes } from './modules/watch/routes.js';
import { registerVerificationRoutes } from './modules/verification/routes.js';
import { createInteractive } from './modules/verification/interactive.js';
import { registerMetadataRoutes } from './modules/metadata/routes.js';
import { registerRuleRoutes } from './modules/rules/routes.js';
import { registerResolveRoute, registerMediaProxyRoute } from './modules/playback/routes.js';
import { registerDownloadRoutes } from './modules/downloads/routes.js';

export function registerRoutes(
  app,
  { http, images, watchStore, verification, metadata, archive, store, engine, media, downloads },
) {
  const interactive = createInteractive(verification);
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  registerImageRoutes(app, { images });
  registerWatchRoutes(app, { watchStore });
  registerVerificationRoutes(app, { verification });
  registerMetadataRoutes(app, { metadata, archive });
  registerRuleRoutes(app, { http, store, engine, interactive });
  registerResolveRoute(app, { store, media, downloads, interactive });
  registerDownloadRoutes(app, { downloads, store });
  registerMediaProxyRoute(app, { media });
}
