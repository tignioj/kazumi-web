import React, { useEffect, useState } from 'react';
import { Network, Save, Wifi } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/feedback.jsx';

const imageModes = { mirror: '镜像', ech: 'ECH', direct: '直连' };

export function NetworkSettings({ request, notify }) {
  const [form, setForm] = useState(null);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [testUrl, setTestUrl] = useState('https://api.bgm.tv/v0/subjects/253');
  const disabled = Boolean(busy) || request.saving || request.loading;
  useEffect(() => {
    if (request.data)
      setForm((previous) =>
        previous
          ? { ...previous, enabled: request.data.enabled }
          : { ...request.data, password: '' },
      );
  }, [request.data]);
  const change = (key, value) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (key === 'password') setPasswordChanged(true);
    setError('');
    setResult('');
  };
  const submit = async (action) => {
    setBusy(action);
    setError('');
    setResult('');
    const settings = {
      enabled: form.enabled,
      url: form.url,
      username: form.username,
      bangumiEch: form.bangumiEch,
      imageAcceleration: form.imageAcceleration,
      echDohUrl: form.echDohUrl,
    };
    if (passwordChanged) settings.password = form.password;
    try {
      if (action === 'save') {
        const saved = await request.save(settings);
        setForm({ ...saved, password: '' });
        setPasswordChanged(false);
        setResult('saved');
        notify('网络设置已保存');
      } else {
        const tested = await api('/network-settings/test', {
          method: 'POST',
          body: JSON.stringify({ settings, url: testUrl }),
        });
        setResult(
          `${tested.mode === 'proxy' ? '代理' : tested.mode === 'ech' ? 'ECH' : '直连'}测试成功 · HTTP ${tested.status} · ${tested.elapsedMs} ms。测试不会保存设置。`,
        );
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <section id="network-settings" className="settings-card" aria-label="网络设置">
      <div className="settings-card-heading">
        <Network size={19} />
        <div>
          <h2>网络设置</h2>
          <p>服务器共享设置，适用于所有连接此服务器的设备</p>
        </div>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !form ? (
        <p className="muted small">正在读取网络设置…</p>
      ) : (
        <form
          className="network-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit('save');
          }}
        >
          <div className="setting-row">
            <div>
              <h3>启用网络代理</h3>
              <p>片源、图片、视频、下载和资料更新使用此代理。</p>
            </div>
            <button
              type="button"
              className={`switch ${form.enabled ? 'on' : ''}`}
              role="switch"
              aria-checked={form.enabled}
              aria-label="启用网络代理"
              disabled={disabled}
              onClick={() => change('enabled', !form.enabled)}
            >
              <span />
            </button>
          </div>
          <fieldset disabled={disabled} className="network-fields">
            <label>
              <span>代理地址</span>
              <input
                type="text"
                value={form.url}
                placeholder="http://127.0.0.1:7890"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => change('url', event.target.value)}
                aria-describedby="proxy-address-help"
              />
            </label>
            <p id="proxy-address-help" className="muted small">
              支持 http://、https:// 和 socks5://。地址从服务器访问；Docker
              中的本机地址指向容器自身，访问宿主机可使用 host.docker.internal。
            </p>
            <div className="network-credentials">
              <label>
                <span>代理用户名（可选）</span>
                <input
                  value={form.username}
                  autoComplete="off"
                  onChange={(event) => change('username', event.target.value)}
                />
              </label>
              <label>
                <span>代理密码（可选）</span>
                <input
                  type="password"
                  value={form.password}
                  autoComplete="new-password"
                  placeholder={
                    form.hasPassword && !passwordChanged ? '已保存密码，留空保持不变' : '未设置密码'
                  }
                  onChange={(event) => change('password', event.target.value)}
                />
              </label>
            </div>
            {form.hasPassword && (
              <button type="button" className="text-button" onClick={() => change('password', '')}>
                {passwordChanged && !form.password ? '保存后清除密码' : '清除已保存密码'}
              </button>
            )}
          </fieldset>
          <div className="setting-row">
            <div>
              <h3>启用 Bangumi API ECH</h3>
              <p>用于 Bangumi API，封面请求单独设置。ECH 连接失败时会报告错误。</p>
            </div>
            <button
              type="button"
              className={`switch ${form.bangumiEch ? 'on' : ''}`}
              role="switch"
              aria-checked={form.bangumiEch}
              aria-label="启用 Bangumi API ECH"
              disabled={disabled}
              onClick={() => change('bangumiEch', !form.bangumiEch)}
            >
              <span />
            </button>
          </div>
          <div className="setting-row">
            <div>
              <h3 id="image-acceleration-label">封面请求方式</h3>
              <p id="image-acceleration-help">
                镜像通过 wsrv.nl 加载，ECH 加密握手，直连加载原图。与 Bangumi API 设置独立。
              </p>
            </div>
            <select
              aria-labelledby="image-acceleration-label"
              aria-describedby="image-acceleration-help"
              value={form.imageAcceleration}
              disabled={disabled}
              onChange={(event) => change('imageAcceleration', event.target.value)}
            >
              {Object.entries(imageModes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <fieldset disabled={disabled} className="network-fields">
            <label>
              <span>ECH DNS 地址</span>
              <input
                type="url"
                value={form.echDohUrl}
                placeholder="https://1.1.1.1/dns-query"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => change('echDohUrl', event.target.value)}
                aria-describedby="ech-dns-help"
              />
            </label>
            <p id="ech-dns-help" className="muted small">
              API 和封面 ECH 共用此 DNS 地址。Docker 已内置 ECH 工具；本地开发需先运行 npm run
              build:ech。
            </p>
            <label>
              <span>API 测试地址</span>
              <input
                type="url"
                value={testUrl}
                onChange={(event) => {
                  setTestUrl(event.target.value);
                  setResult('');
                }}
              />
            </label>
          </fieldset>
          <p className="muted small">
            保存后新请求即时生效，无需重启，已有封面缓存继续复用。启用网络代理时优先使用代理。
            连接测试按 API 设置进行，不测试封面请求方式。
          </p>
          <div className="button-group">
            <button type="submit" className="button primary" disabled={disabled}>
              <Save size={15} />
              {busy === 'save' ? '正在保存…' : '保存网络设置'}
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={disabled}
              onClick={() => submit('test')}
            >
              <Wifi size={15} />
              {busy === 'test' ? '正在测试…' : '测试连接'}
            </button>
          </div>
          {result && (
            <p className="network-result muted small" role="status">
              {result === 'saved'
                ? `已保存。Bangumi API：${request.data.bangumiEch ? 'ECH' : '直连'}；封面：${imageModes[request.data.imageAcceleration]}。${request.data.enabled ? '网络代理已启用，优先通过代理连接。' : ''}`
                : result}
            </p>
          )}
          {error && <Notice>{error}</Notice>}
        </form>
      )}
    </section>
  );
}
