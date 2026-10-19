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
  const prepare = (req) => {
    const settings = network.validate(req.body?.settings);
    const scope = req.body?.scope ?? 'bangumi';
    if (!Object.hasOwn(PROXY_SCOPES, scope)) throw new HttpError('请选择有效的代理测试范围');
    const target = checkedUrl(req.body?.url, { allowPrivate: http.allowPrivate });
    const test = connectionTestRequest(settings, scope, target.href);
    return { settings, scope, test };
  };
  app.post('/api/network-settings/preview', (req, res) => {
    const { settings, scope, test } = prepare(req);
    res.json({
      routing: proxySettingsFor(settings, scope, { url: test.url }).routing,
      target: test.url,
      mirror: test.mirror,
    });
  });
  app.post('/api/network-settings/test', async (req, res) => {
    const { settings, scope, test } = prepare(req);
    let routing = proxySettingsFor(settings, scope, { url: test.url }).routing;
    const client = createHttpClient({
      allowPrivate: http.allowPrivate,
      getProxySettings: (url) => {
        const proxy = proxySettingsFor(settings, scope, { url });
        routing = proxy.routing;
        return proxy;
      },
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
        routing,
        mirror: test.mirror,
        mode:
          routing.action === 'proxy'
            ? 'proxy'
            : test.mirror
              ? 'mirror'
              : echAccepted
                ? 'ech'
                : 'direct',
      });
    } catch (error) {
      const route = routing.ruleName ? `命中「${routing.ruleName}」` : '按类型默认策略';
      const outbound = routing.action === 'proxy' ? `代理「${routing.proxyName}」` : '应用直连';
      res
        .status(error.status || 502)
        .json({ error: `${route} · ${outbound}：${error.message}`, routing });
    } finally {
      await client.close();
    }
  });
}
