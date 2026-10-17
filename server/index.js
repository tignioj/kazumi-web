import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';

export { createApp };

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
