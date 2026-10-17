import React, { useState } from 'react';
import { imageSource } from '../../../shared/images.js';
import { CachedImage } from '../../components/CachedImage.jsx';
import { Film, History, Play, Trash2, X } from 'lucide-react';
import { timeLabel, prettyDate } from '../../lib/format.js';
import { Empty } from '../../components/feedback.jsx';
import { PageHeading } from '../../components/PageHeading.jsx';
import { Modal } from '../../components/Modal.jsx';

export function HistoryPage({ history, onResume, onRemove, onClear }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <PageHeading
        eyebrow="PICK UP WHERE YOU LEFT OFF"
        title="故事，继续"
        description="记下每次相遇，也记得上次停下的地方。"
      >
        {history.length > 0 && (
          <button className="button quiet" onClick={() => setConfirm(true)}>
            <Trash2 size={15} />
            清空记录
          </button>
        )}
      </PageHeading>
      {history.length ? (
        <div className="history-list">
          {history.map((item) => (
            <article className="history-row" key={item.key}>
              <button className="history-cover" onClick={() => onResume(item)}>
                {item.image ? (
                  <CachedImage referrerPolicy="no-referrer" src={imageSource(item.image)} alt="" />
                ) : (
                  <Film size={24} />
                )}
                <span>
                  <Play size={20} fill="currentColor" />
                </span>
              </button>
              <div className="history-description">
                <h3>{item.title}</h3>
                <p>
                  {item.episodeName} <span>· {item.ruleName}</span>
                </p>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${item.duration ? Math.min(100, (item.position / item.duration) * 100) : 0}%`,
                    }}
                  />
                </div>
                <small>
                  观看至 {timeLabel(item.position)}
                  {item.duration ? ` / ${timeLabel(item.duration)}` : ''}
                  <span>{prettyDate(item.updatedAt)}</span>
                </small>
              </div>
              <button className="button quiet resume-button" onClick={() => onResume(item)}>
                <Play size={15} />
                继续观看
              </button>
              <button
                className="icon-button"
                aria-label={`删除 ${item.title} 的观看记录`}
                onClick={() => onRemove(item.key)}
              >
                <X size={17} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon={History} title="还没有开始的故事">
          播放动画后，观看记录和进度会自动保存在这里。
        </Empty>
      )}
      {confirm && (
        <Modal title="清空观看记录" onClose={() => setConfirm(false)}>
          <p>将移除服务器中的全部观看记录，所有设备都会受影响，收藏会保留。</p>
          <div className="modal-actions">
            <button className="button quiet" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={() => {
                onClear();
                setConfirm(false);
              }}
            >
              清空记录
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
