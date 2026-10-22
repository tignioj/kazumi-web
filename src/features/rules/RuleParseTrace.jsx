import React, { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { formatTraceJson } from './format-trace-json.js';

const number = (value = 0) => Number(value).toLocaleString('zh-CN');
const kinds = { item: '搜索条目', road: '播放线路', episode: '剧集' };
const countKinds = { items: '条目', roads: '线路', episodes: '剧集' };
const formatErrors = {
  depth: 'JSON 层级过深，保留原文显示。',
  size: '格式化内容过大，保留原文显示。',
  invalid: '响应不是有效 JSON，保留原文显示。',
};

function CopyTraceText({ text, label }) {
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [text]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage('已复制');
    } catch {
      setMessage('无法访问剪贴板，请选中文本后手动复制。');
    }
  };
  return (
    <div className="rule-trace-copy">
      <button type="button" className="text-button" onClick={copy} aria-label={label}>
        <Copy size={13} />
        {label}
      </button>
      {message && <span role="status">{message}</span>}
    </div>
  );
}

function nodeLabel(node) {
  return `${node.roadIndex ? `线路 ${node.roadIndex} · ` : ''}${kinds[node.kind] || '节点'} ${node.index}`;
}

export function RuleParseTrace({ trace }) {
  const [onlySkipped, setOnlySkipped] = useState(false);
  const [formatJson, setFormatJson] = useState(false);
  const [formattedJson, setFormattedJson] = useState(null);
  const [formatError, setFormatError] = useState('');
  useEffect(() => {
    setOnlySkipped(false);
    setFormatJson(false);
    setFormattedJson(null);
    setFormatError('');
  }, [trace]);
  const label = trace.stage === 'search' ? '搜索' : '章节';
  const nodes = trace.nodes || [];
  const selections = trace.selections || [];
  const diagnostics = trace.diagnostics || [];
  const visibleNodes = onlySkipped ? nodes.filter((node) => node.status === 'skipped') : nodes;
  const skipped = nodes.filter((node) => node.status === 'skipped').length;
  const totals = Object.entries(trace.counts || {}).filter(([kind]) =>
    trace.stage === 'search' ? kind === 'items' : kind !== 'items',
  );
  const accepted = totals.find(
    ([kind]) => kind === (trace.stage === 'search' ? 'items' : 'episodes'),
  )?.[1]?.accepted;
  const response = trace.response;
  const showFormattedJson = () => {
    if (response?.format !== 'json' || response.truncated) return;
    const result = formattedJson === null ? formatTraceJson(response.raw) : { text: formattedJson };
    setFormattedJson(result.text ?? null);
    setFormatError(result.error || '');
    setFormatJson(!result.error);
  };

  return (
    <section className="rule-parse-trace" aria-label={`${label}解析追踪`}>
      <header className="rule-trace-heading">
        <h4>{label}解析追踪</h4>
        <span>{trace.mode === 'api' ? 'API / JSON' : 'XPath / HTML'}</span>
      </header>
      {totals.length > 0 && (
        <dl className="rule-trace-counts" aria-label={`${label}节点统计`}>
          {totals.map(([kind, count]) => (
            <div key={kind}>
              <dt>{countKinds[kind] || kind}</dt>
              <dd>
                已检查 <strong>{number(count.matched)}</strong>
                <span>保留 {number(count.accepted)}</span>
                <span>跳过 {number(count.skipped)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {accepted === 0 && (
        <p className="rule-trace-warning" role="status">
          {trace.stage === 'search' ? '未解析到有效搜索结果。' : '未解析到有效剧集。'}
          可展开原始响应确认页面内容，再检查选择器命中数和跳过原因。
        </p>
      )}
      {diagnostics.length > 0 && (
        <ul className="rule-trace-messages" aria-label={`${label}解析诊断`}>
          {diagnostics.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}
      {trace.omittedDiagnostics > 0 && (
        <p className="rule-trace-warning">另有 {number(trace.omittedDiagnostics)} 条诊断未展示。</p>
      )}
      <details className="rule-trace-section">
        <summary>
          原始响应
          <span>
            {response
              ? `${response.format.toUpperCase()} · ${number(response.length)} 字符`
              : '未取得响应正文'}
          </span>
        </summary>
        <div className="rule-trace-content">
          {response ? (
            <>
              {response.truncated && (
                <p className="rule-trace-warning">
                  响应已截断：共 {number(response.length)} 字符，仅保留前{' '}
                  {number(response.raw.length)} 字符。 复制的也是当前保留内容。
                </p>
              )}
              {response.format === 'json' && (
                <>
                  <div
                    className="rule-trace-format"
                    role="group"
                    aria-label={`${label}响应显示方式`}
                  >
                    <button
                      type="button"
                      aria-pressed={!formatJson}
                      onClick={() => setFormatJson(false)}
                    >
                      原文
                    </button>
                    <button
                      type="button"
                      aria-pressed={formatJson}
                      disabled={response.truncated || Boolean(formatError)}
                      onClick={showFormattedJson}
                    >
                      格式化 JSON
                    </button>
                  </div>
                  <p className="rule-trace-hint">
                    {response.truncated
                      ? '响应已截断，无法格式化；显示保留的原文。'
                      : formatErrors[formatError] || '格式化只改变显示；复制始终使用原始响应文本。'}
                  </p>
                </>
              )}
              <CopyTraceText text={response.raw} label={`复制${label}原始响应`} />
              <pre className="rule-trace-code" tabIndex={0} aria-label={`${label}原始响应文本`}>
                {formatJson && formattedJson !== null ? formattedJson : response.raw}
              </pre>
            </>
          ) : (
            <p className="muted small">
              本次请求未取得可查看的响应正文，请结合错误信息检查请求配置。
            </p>
          )}
        </div>
      </details>
      <details className="rule-trace-section">
        <summary>
          选择器与匹配数量<span>{number(selections.length)} 条记录</span>
        </summary>
        <div className="rule-trace-content">
          {trace.omittedSelections > 0 && (
            <p className="rule-trace-warning">
              另有 {number(trace.omittedSelections)} 条选择器记录未展示，上方统计包含全部节点。
            </p>
          )}
          {selections.length ? (
            <div className="rule-trace-table-scroll" tabIndex={0} aria-label={`${label}选择器记录`}>
              <table className="rule-trace-selections">
                <thead>
                  <tr>
                    <th scope="col">选择器</th>
                    <th scope="col">上下文</th>
                    <th scope="col">命中</th>
                  </tr>
                </thead>
                <tbody>
                  {selections.map((selection, index) => (
                    <tr key={index}>
                      <td>
                        <span>{selection.label}</span>
                        <code>{selection.expression || '（空表达式）'}</code>
                      </td>
                      <td>{selection.context}</td>
                      <td className={selection.matched === 0 ? 'rule-trace-zero' : ''}>
                        {number(selection.matched)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">尚无选择器执行记录。</p>
          )}
        </div>
      </details>
      <details className="rule-trace-section">
        <summary>
          节点与匹配片段<span>保留 {number(nodes.length)} 条记录</span>
        </summary>
        <div className="rule-trace-content">
          <label className="rule-trace-filter">
            <input
              type="checkbox"
              checked={onlySkipped}
              onChange={(event) => setOnlySkipped(event.target.checked)}
            />
            只看跳过的节点（当前记录 {number(skipped)} 条）
          </label>
          <p className="rule-trace-hint">
            统计已完成字段解析的节点；编号对应原始匹配顺序，筛选后保持不变。
          </p>
          {trace.omittedNodes > 0 && (
            <p className="rule-trace-warning">
              另有 {number(trace.omittedNodes)} 个节点未展示，当前记录优先保留跳过节点。
              上方统计包含全部节点；筛选仅作用于当前记录。
            </p>
          )}
          {visibleNodes.length ? (
            <ol className="rule-trace-nodes" aria-label={`${label}匹配节点`}>
              {visibleNodes.map((node) => (
                <li key={`${node.kind}:${node.roadIndex || 0}:${node.index}`}>
                  <details className="rule-trace-node" data-status={node.status}>
                    <summary>
                      <span className="rule-trace-node-title">
                        <strong>{nodeLabel(node)}</strong>
                        {node.name && <span>{node.name}</span>}
                      </span>
                      <span className="rule-trace-node-status">
                        {node.status === 'skipped' ? '已跳过' : '已保留'}
                      </span>
                    </summary>
                    <div className="rule-trace-node-content">
                      {node.url && <p className="rule-trace-node-url">来源值：{node.url}</p>}
                      {node.reason && <p className="rule-trace-warning">原因：{node.reason}</p>}
                      {node.fragmentError ? (
                        <p className="rule-trace-warning" role="status">
                          {node.fragmentError}
                        </p>
                      ) : (
                        <>
                          {node.fragmentTruncated && (
                            <p className="rule-trace-warning">
                              片段已截断：共 {number(node.fragmentLength)} 字符，仅保留前{' '}
                              {number(node.fragment.length)} 字符。
                            </p>
                          )}
                          <CopyTraceText
                            text={node.fragment}
                            label={`复制${nodeLabel(node)}片段`}
                          />
                          <pre
                            className="rule-trace-code"
                            tabIndex={0}
                            aria-label={`${nodeLabel(node)}匹配片段`}
                          >
                            {node.fragment}
                          </pre>
                        </>
                      )}
                    </div>
                  </details>
                  {node.status === 'skipped' && node.reason && (
                    <p className="rule-trace-node-reason">{node.reason}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">
              {onlySkipped ? '当前记录中没有跳过的节点。' : '没有匹配节点可展示。'}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
