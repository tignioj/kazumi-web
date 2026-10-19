import React from 'react';
import { LoaderCircle, Network } from 'lucide-react';

export function ProxyToggle({ network, notify, onConfigure }) {
  const enabled = Boolean(network.data?.videoProxy);
  const proxyId = network.data?.scopeProxies?.video || 'default';
  const proxy =
    proxyId === 'default'
      ? network.data
      : network.data?.proxies?.find((proxy) => proxy.id === proxyId);
  const busy = network.loading || network.saving;
  const toggle = async () => {
    if (network.error) {
      network.retry();
      return;
    }
    if (!enabled && !proxy?.url) {
      onConfigure();
      notify('请先填写并保存代理地址');
      return;
    }
    try {
      const saved = await network.save({ videoProxy: !enabled });
      notify(
        saved.videoProxy
          ? '视频默认代理已启用，自定义分流规则优先'
          : '视频默认代理已关闭，自定义分流规则优先',
      );
    } catch (error) {
      notify(`代理切换失败：${error.message}`);
    }
  };

  return (
    <button
      type="button"
      className={`proxy-toggle ${enabled ? 'on' : ''}`}
      role="switch"
      aria-label="视频请求代理快捷开关"
      aria-checked={enabled}
      aria-busy={busy}
      disabled={busy}
      title={
        network.error
          ? `代理设置读取失败，点击重试：${network.error}`
          : busy
            ? '正在同步代理设置…'
            : enabled
              ? '关闭视频默认代理，自定义分流规则仍优先'
              : proxy?.url
                ? '启用视频默认代理，自定义分流规则仍优先'
                : '前往设置代理地址'
      }
      onClick={toggle}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : <Network size={16} />}
      <span className="proxy-toggle-label">
        {network.error ? '读取失败' : enabled ? '视频默认代理开' : '视频默认代理关'}
      </span>
      <span className="proxy-toggle-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}
