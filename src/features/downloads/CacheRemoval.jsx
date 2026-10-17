import React, { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Notice } from '../../components/feedback.jsx';
import { Modal } from '../../components/Modal.jsx';
import { cacheActive } from './utils.js';

export function CacheRemoval({ item, onClose, onRemoved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const all = item === 'all';
  const group = Array.isArray(item.items);
  return (
    <Modal
      title={all ? '清空全部视频缓存' : group ? '删除整组缓存' : '删除视频缓存'}
      onClose={() => !busy && onClose()}
    >
      <p>
        {all
          ? '将停止所有下载任务，并删除服务器上的全部视频缓存。'
          : group
            ? `将删除「${item.title}」在「${item.ruleName}」下的全部 ${item.items.length} 集缓存及任务，并停止组内未完成的下载。`
            : `将删除「${item.title} · ${item.episodeName || '当前剧集'}」的缓存${cacheActive(item) ? '，并停止下载' : ''}。`}
        此操作会影响使用此服务器的所有人；收藏与观看记录会保留。
      </p>
      {error && <Notice>{error}</Notice>}
      <div className="modal-actions">
        <button className="button quiet" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="button danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api(
                all
                  ? '/downloads'
                  : group
                    ? '/downloads/batch'
                    : `/downloads/${encodeURIComponent(item.id)}`,
                {
                  method: 'DELETE',
                  ...(group
                    ? { body: JSON.stringify({ ids: item.items.map((entry) => entry.id) }) }
                    : {}),
                },
              );
              onRemoved();
            } catch (e) {
              setError(e.message);
              setBusy(false);
            }
          }}
        >
          {busy && <LoaderCircle size={15} className="spin" />}
          {all ? '清空全部缓存' : group ? `删除整组（${item.items.length} 集）` : '确认删除'}
        </button>
      </div>
    </Modal>
  );
}
