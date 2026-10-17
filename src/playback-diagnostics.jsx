import React from 'react';

const STATUS = {
  unknown: '等待实际播放验证',
  supported: '浏览器报告支持，等待实际播放验证',
  unsupported: '浏览器报告编码不受支持',
  playable: '已通过实际加载验证',
};

export function PlaybackDiagnostics({ info, error }) {
  if (!info && !error) return null;
  return (
    <details className="playback-diagnostics">
      <summary>播放信息与诊断{info?.status === 'unsupported' ? ' · 编码可能不兼容' : ''}</summary>
      <dl>
        {info && (
          <>
            <dt>播放方式</dt>
            <dd>{info.mode === 'mse' ? 'HLS 浏览器扩展播放' : '浏览器原生播放'}</dd>
            <dt>编码</dt>
            <dd>{info.codecs.length ? info.codecs.join(' / ') : '暂未取得编码信息'}</dd>
            <dt>兼容性</dt>
            <dd>
              {error && info.status !== 'unsupported'
                ? info.status === 'playable'
                  ? '已成功加载，后续播放失败'
                  : '未能完成实际播放验证'
                : STATUS[info.status]}
            </dd>
            {info.probeFailed && (
              <>
                <dt>媒体检查</dt>
                <dd>预检查未完成，以实际播放结果为准</dd>
              </>
            )}
          </>
        )}
        {error && (
          <>
            <dt>错误类型</dt>
            <dd>
              {error.title}（{error.code}）
            </dd>
            {error.detail && (
              <>
                <dt>诊断信息</dt>
                <dd>{error.detail}</dd>
              </>
            )}
          </>
        )}
      </dl>
    </details>
  );
}
