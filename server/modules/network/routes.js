import { createHttpClient, checkedUrl, HttpError } from '../../lib/http.js';

export function registerNetworkRoutes(app, { network, http }) {
  app.use('/api/network-settings', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/network-settings', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(network.publicSettings());
  });
  app.put('/api/network-settings', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await network.save(req.body));
  });
  app.post('/api/network-settings/test', async (req, res) => {
    const settings = network.validate(req.body?.settings);
    const target = checkedUrl(req.body?.url, { allowPrivate: http.allowPrivate });
    const client = createHttpClient({
      allowPrivate: http.allowPrivate,
      getProxySettings: () => settings,
      timeout: 10000,
    });
    const started = Date.now();
    try {
      const { response, echAccepted } = await client.request(target.href, {
        signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new HttpError(`测试站点返回 HTTP ${response.status}`, 502);
      res.set('Cache-Control', 'no-store').json({
        ok: true,
        elapsedMs: Date.now() - started,
        status: response.status,
        mode: settings.enabled ? 'proxy' : echAccepted ? 'ech' : 'direct',
      });
    } finally {
      await client.close();
    }
  });
}
