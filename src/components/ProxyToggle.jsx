import React from 'react';
import { LoaderCircle, Network } from 'lucide-react';

export function ProxyToggle({ network, notify, onConfigure }) {
  const enabled = Boolean(network.data?.videoProxy);
  const busy = network.loading || network.saving;
  const toggle = async () => {
    if (network.error) {
      network.retry();
      return;
    }
    if (!enabled && !network.data?.url) {
      onConfigure();
      notify('请先填写并保存代理地址');
      return;
    }
    try {
      const saved = await network.save({ videoProxy: !enabled });
      notify(saved.videoProxy ? '视频请求代理已启用' : '视频请求代理已关闭');
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
              ? '关闭视频请求代理'
              : network.data?.url
                ? '启用视频请求代理'
                : '前往设置代理地址'
      }
      onClick={toggle}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : <Network size={16} />}
      <span className="proxy-toggle-label">
        {network.error ? '读取失败' : enabled ? '视频代理已开' : '视频代理已关'}
      </span>
      <span className="proxy-toggle-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}
