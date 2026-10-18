import { createHttpClient, checkedUrl, HttpError } from '../../lib/http.js';
import { PROXY_SCOPES, proxySettingsFor } from '../../../shared/network-settings.js';
import { bangumiImageMirrorUrl } from '../../../shared/images.js';

export function connectionTestRequest(settings, scope, url) {
  const mirror =
    scope === 'image' && settings.imageAcceleration === 'mirror'
      ? bangumiImageMirrorUrl(url)
      : null;
  return {
    url: mirror || url,
    mirror: Boolean(mirror),
    ech: scope === 'image' ? settings.imageAcceleration === 'ech' : undefined,
  };
}

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
    const scope = req.body?.scope ?? 'bangumi';
    if (!Object.hasOwn(PROXY_SCOPES, scope)) throw new HttpError('请选择有效的代理测试范围');
    const proxy = proxySettingsFor(settings, scope);
    const target = checkedUrl(req.body?.url, { allowPrivate: http.allowPrivate });
    const test = connectionTestRequest(settings, scope, target.href);
    const client = createHttpClient({
      allowPrivate: http.allowPrivate,
      getProxySettings: () => proxy,
      timeout: 10000,
    });
    const started = Date.now();
    try {
      const { response, echAccepted } = await client.request(test.url, {
        signal: AbortSignal.timeout(10000),
        ech: test.ech,
      });
      await response.body?.cancel();
      if (!response.ok) throw new HttpError(`测试站点返回 HTTP ${response.status}`, 502);
      res.set('Cache-Control', 'no-store').json({
        ok: true,
        elapsedMs: Date.now() - started,
        status: response.status,
        scope,
        mirror: test.mirror,
        mode: proxy.enabled ? 'proxy' : test.mirror ? 'mirror' : echAccepted ? 'ech' : 'direct',
      });
    } finally {
      await client.close();
    }
  });
}
