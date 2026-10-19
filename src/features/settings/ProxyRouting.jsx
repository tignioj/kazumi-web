import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRequest } from '../../hooks/use-request.js';
import { routingId, sourceRoutingRules } from './network-routing.js';

const matchTypes = {
  domainSuffix: '域名及子域名',
  domain: '精确域名',
  domainKeyword: '域名关键字',
  cidr: 'IP 网段（IP 目标）',
  all: '该类型全部请求',
};

export function ProxyOptions({ proxies }) {
  return (
    <>
      <option value="default">默认代理</option>
      {proxies.map((proxy) => (
        <option key={proxy.id} value={proxy.id}>
          {proxy.name || '未命名代理'}
        </option>
      ))}
    </>
  );
}

export function ProxyRouting({ form, change, scopes, disabled }) {
  const installed = useRequest('/rules');
  const [sourceName, setSourceName] = useState('');
  const [sourceOutbound, setSourceOutbound] = useState('default');
  const [message, setMessage] = useState('');
  const proxies = form.proxies || [];
  const rules = form.routingRules || [];
  const proxyExists = (id) => id === 'default' || proxies.some((proxy) => proxy.id === id);
  const presetOutbound =
    sourceOutbound === 'direct' || proxyExists(sourceOutbound) ? sourceOutbound : 'default';
  const updateProxy = (id, patch) =>
    change(
      'proxies',
      proxies.map((proxy) => (proxy.id === id ? { ...proxy, ...patch } : proxy)),
    );
  const updateRule = (id, patch) =>
    change(
      'routingRules',
      rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    );
  const move = (index, delta) => {
    const next = [...rules];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    change('routingRules', next);
  };
  const proxyUsed = (id) =>
    Object.values(form.scopeProxies || {}).includes(id) ||
    rules.some((rule) => rule.action === 'proxy' && rule.proxyId === id);
  return (
    <fieldset disabled={disabled} className="network-fields routing-settings">
      <div className="routing-heading">
        <div>
          <h3>更多代理出口</h3>
          <p className="muted small">
            为不同用途配置独立出口。支持 HTTP、HTTPS 和 SOCKS5，各自保存认证信息。
          </p>
        </div>
        <button
          type="button"
          className="button quiet"
          disabled={proxies.length >= 16}
          onClick={() =>
            change('proxies', [
              ...proxies,
              {
                id: routingId(),
                name: `代理 ${proxies.length + 1}`,
                url: '',
                username: '',
                password: '',
              },
            ])
          }
        >
          <Plus size={14} />
          添加代理
        </button>
      </div>
      {proxies.map((proxy, index) => (
        <section key={proxy.id} className="routing-entry" aria-label={`代理出口 ${index + 1}`}>
          <div className="routing-heading">
            <h4>代理出口 {index + 1}</h4>
            <button
              type="button"
              className="text-button"
              disabled={proxyUsed(proxy.id)}
              title={proxyUsed(proxy.id) ? '请先调整引用此代理的默认策略和分流规则' : '删除代理'}
              aria-label={`删除代理 ${index + 1}`}
              onClick={() =>
                change(
                  'proxies',
                  proxies.filter((item) => item.id !== proxy.id),
                )
              }
            >
              <Trash2 size={14} />
              删除
            </button>
          </div>
          <div className="routing-grid">
            <label>
              <span>代理名称</span>
              <input
                value={proxy.name}
                maxLength={100}
                onChange={(event) => updateProxy(proxy.id, { name: event.target.value })}
              />
            </label>
            <label>
              <span>代理地址</span>
              <input
                value={proxy.url}
                autoCapitalize="none"
                spellCheck={false}
                placeholder="http://192.168.100.1:7890"
                onChange={(event) => updateProxy(proxy.id, { url: event.target.value })}
              />
            </label>
            <label>
              <span>用户名（可选）</span>
              <input
                value={proxy.username}
                autoComplete="off"
                onChange={(event) => updateProxy(proxy.id, { username: event.target.value })}
              />
            </label>
            <label>
              <span>密码（可选）</span>
              <input
                type="password"
                value={proxy.password ?? ''}
                autoComplete="new-password"
                placeholder={proxy.hasPassword ? '已保存密码，留空保持不变' : '未设置密码'}
                onChange={(event) => updateProxy(proxy.id, { password: event.target.value })}
              />
            </label>
          </div>
          {proxy.hasPassword && (
            <button
              type="button"
              className="text-button"
              onClick={() => updateProxy(proxy.id, { password: '' })}
            >
              {proxy.password === '' ? '保存后清除密码' : '清除已保存密码'}
            </button>
          )}
          {proxyUsed(proxy.id) && (
            <p className="muted small">此出口正在被引用，调整对应默认策略或分流规则后可删除。</p>
          )}
        </section>
      ))}
      <div className="routing-heading">
        <div>
          <h3>自定义分流规则</h3>
          <p className="muted small">
            从上到下首次命中，优先于五类默认开关；未命中时沿用对应类型的设置。
          </p>
        </div>
        <button
          type="button"
          className="button quiet"
          disabled={rules.length >= 200}
          onClick={() =>
            change('routingRules', [
              ...rules,
              {
                id: routingId(),
                name: '',
                enabled: true,
                scope: 'video',
                matchType: 'domainSuffix',
                value: '',
                action: 'proxy',
                proxyId: 'default',
              },
            ])
          }
        >
          <Plus size={14} />
          添加分流规则
        </button>
      </div>
      <p className="muted small">
        “应用直连”表示不使用本应用配置的代理，仍受系统或路由器的 TUN 分流影响。HTTPS
        按目标主机匹配；IP 网段只匹配地址本身是 IP 的请求。
      </p>
      <div className="routing-preset">
        <label>
          <span>从已安装片源生成域名规则</span>
          <select value={sourceName} onChange={(event) => setSourceName(event.target.value)}>
            <option value="">选择片源</option>
            {(installed.data?.rules || []).map((rule) => (
              <option key={rule.name} value={rule.name}>
                {rule.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>片源域名出口</span>
          <select
            value={presetOutbound}
            onChange={(event) => setSourceOutbound(event.target.value)}
          >
            <option value="direct">应用直连</option>
            <ProxyOptions proxies={proxies} />
          </select>
        </label>
        <button
          type="button"
          className="button quiet"
          disabled={!sourceName || rules.length >= 200}
          onClick={() => {
            const source = installed.data.rules.find((rule) => rule.name === sourceName);
            const added = sourceRoutingRules(source, presetOutbound).filter(
              (rule) =>
                !rules.some(
                  (existing) =>
                    existing.scope === rule.scope &&
                    existing.matchType === rule.matchType &&
                    existing.value === rule.value,
                ),
            );
            if (rules.length + added.length > 200) {
              setMessage('最多配置 200 条分流规则，请先删除部分规则。');
              return;
            }
            change('routingRules', [...rules, ...added]);
            setMessage(
              added.length
                ? `已生成 ${added.length} 条域名规则，保存后生效。`
                : '这些域名已经配置，请在下方调整已有规则。',
            );
          }}
        >
          <Plus size={14} />
          生成规则
        </button>
      </div>
      <p className="muted small">
        生成当前片源的主站和 API 域名规则；播放器、验证页面及下载中的其他 CDN
        域名，可继续添加独立分流规则。
      </p>
      {message && (
        <p className="muted small" role="status">
          {message}
        </p>
      )}
      {!rules.length && (
        <p className="routing-empty muted small">尚未添加自定义规则，当前使用五类默认设置。</p>
      )}
      {rules.map((rule, index) => (
        <section className="routing-entry" key={rule.id} aria-label={`分流规则 ${index + 1}`}>
          <div className="routing-heading">
            <label className="routing-enabled">
              <input
                type="checkbox"
                checked={rule.enabled}
                aria-label={`启用分流规则 ${index + 1}`}
                onChange={(event) => updateRule(rule.id, { enabled: event.target.checked })}
              />
              <span>规则 {index + 1}</span>
            </label>
            <div className="routing-actions">
              <button
                type="button"
                className="text-button"
                aria-label={`上移分流规则 ${index + 1}`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={15} />
              </button>
              <button
                type="button"
                className="text-button"
                aria-label={`下移分流规则 ${index + 1}`}
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={15} />
              </button>
              <button
                type="button"
                className="text-button"
                aria-label={`删除分流规则 ${index + 1}`}
                onClick={() =>
                  change(
                    'routingRules',
                    rules.filter((item) => item.id !== rule.id),
                  )
                }
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </div>
          <div className="routing-grid">
            <label>
              <span>规则名称（可选）</span>
              <input
                value={rule.name}
                maxLength={100}
                placeholder={`分流规则 ${index + 1}`}
                onChange={(event) => updateRule(rule.id, { name: event.target.value })}
              />
            </label>
            <label>
              <span>请求类型</span>
              <select
                value={rule.scope}
                onChange={(event) => updateRule(rule.id, { scope: event.target.value })}
              >
                <option value="all">全部类型</option>
                {scopes.map((scope) => (
                  <option key={scope.scope} value={scope.scope}>
                    {scope.label.replace(/代理$/, '')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>匹配方式</span>
              <select
                value={rule.matchType}
                onChange={(event) =>
                  updateRule(rule.id, { matchType: event.target.value, value: '' })
                }
              >
                {Object.entries(matchTypes).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {rule.matchType !== 'all' && (
              <label>
                <span>匹配内容</span>
                <input
                  value={rule.value}
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={253}
                  placeholder={rule.matchType === 'cidr' ? '203.0.113.0/24' : 'agedm.io'}
                  onChange={(event) => updateRule(rule.id, { value: event.target.value })}
                />
              </label>
            )}
            <label>
              <span>出口方式</span>
              <select
                value={rule.action}
                onChange={(event) =>
                  updateRule(rule.id, {
                    action: event.target.value,
                    proxyId: proxyExists(rule.proxyId) ? rule.proxyId : 'default',
                  })
                }
              >
                <option value="proxy">使用代理</option>
                <option value="direct">应用直连</option>
              </select>
            </label>
            {rule.action === 'proxy' && (
              <label>
                <span>使用的代理</span>
                <select
                  value={rule.proxyId}
                  onChange={(event) => updateRule(rule.id, { proxyId: event.target.value })}
                >
                  <ProxyOptions proxies={proxies} />
                </select>
              </label>
            )}
          </div>
        </section>
      ))}
    </fieldset>
  );
}
