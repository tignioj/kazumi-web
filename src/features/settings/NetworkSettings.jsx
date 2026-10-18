import React, { useEffect, useState } from 'react';
import { Network, Save, Wifi } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useRequest } from '../../hooks/use-request.js';
import { Notice } from '../../components/feedback.jsx';

export function NetworkSettings({ notify }) {
  const request = useRequest('/network-settings');
  const [form, setForm] = useState(null);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [testUrl, setTestUrl] = useState('https://api.bgm.tv/v0/subjects/253');
  useEffect(() => {
    if (request.data) setForm({ ...request.data, password: '' });
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
    const settings = { enabled: form.enabled, url: form.url, username: form.username };
    if (passwordChanged) settings.password = form.password;
    try {
      if (action === 'save') {
        const saved = await api('/network-settings', {
          method: 'PUT',
          body: JSON.stringify(settings),
        });
        setForm({ ...saved, password: '' });
        setPasswordChanged(false);
        setResult(
          saved.enabled
            ? '网络代理已启用，新请求将通过代理连接。'
            : '网络代理已关闭，新请求将直接连接。',
        );
        notify('网络代理设置已保存');
      } else {
        const tested = await api('/network-settings/test', {
          method: 'POST',
          body: JSON.stringify({ settings, url: testUrl }),
        });
        setResult(
          `${tested.mode === 'proxy' ? '代理' : '直连'}测试成功 · HTTP ${tested.status} · ${tested.elapsedMs} ms。测试不会保存设置。`,
        );
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="settings-card" aria-label="网络代理">
      <div className="settings-card-heading">
        <Network size={19} />
        <div>
          <h2>网络代理</h2>
          <p>服务器共享设置，适用于所有连接此服务器的设备</p>
        </div>
      </div>
      {request.error ? (
        <Notice onRetry={request.retry}>{request.error}</Notice>
      ) : !form ? (
        <p className="muted small">正在读取代理设置…</p>
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
              disabled={Boolean(busy)}
              onClick={() => change('enabled', !form.enabled)}
            >
              <span />
            </button>
          </div>
          <fieldset disabled={Boolean(busy)} className="network-fields">
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
            <label>
              <span>测试地址</span>
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
            保存后新请求即时生效，无需重启。已有连接可能继续使用原设置。启用时优先使用代理；关闭后恢复原有直连及
            ECH 配置。
          </p>
          <div className="button-group">
            <button type="submit" className="button primary" disabled={Boolean(busy)}>
              <Save size={15} />
              {busy === 'save' ? '正在保存…' : '保存代理设置'}
            </button>
            <button
              type="button"
              className="button quiet"
              disabled={Boolean(busy)}
              onClick={() => submit('test')}
            >
              <Wifi size={15} />
              {busy === 'test' ? '正在测试…' : '测试连接'}
            </button>
          </div>
          {result && (
            <p className="network-result muted small" role="status">
              {result}
            </p>
          )}
          {error && <Notice>{error}</Notice>}
        </form>
      )}
    </section>
  );
}
