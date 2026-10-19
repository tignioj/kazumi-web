import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api.js';
import { titleOf } from '../../lib/format.js';
import { Notice, Empty } from '../../components/feedback.jsx';

export function SourceSearch({ defaultQuery = '', subject, rules, onPlay, navigate }) {
  const [keyword, setKeyword] = useState(defaultQuery);
  const [selected, setSelected] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState('');
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  const [total, setTotal] = useState(0);
  const mounted = useRef(true);
  const requestsRef = useRef(new Set());
  const searchRef = useRef(null);
  const retryRef = useRef(null);
  const searchedKeyword = useRef('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of requestsRef.current) controller.abort();
      requestsRef.current.clear();
    };
  }, []);
  const submit = async (e) => {
    e?.preventDefault();
    if (!keyword.trim() || loading || retryRef.current) return;
    searchedKeyword.current = keyword.trim();
    setLoading(true);
    setError('');
    setResults([]);
    setTotal(selected ? 1 : rules.filter((rule) => rule.enabled !== false).length);
    const controller = new AbortController();
    searchRef.current = controller;
    requestsRef.current.add(controller);
    try {
      const data = await api('/rules/search', {
        method: 'POST',
        signal: controller.signal,
        onResult: (result) => {
          if (mounted.current && !controller.signal.aborted)
            setResults((current) => [
              ...current.filter((group) => group.ruleName !== result.ruleName),
              result,
            ]);
        },
        body: JSON.stringify({
          keyword: searchedKeyword.current,
          ...(selected ? { ruleNames: [selected] } : {}),
        }),
      });
      if (mounted.current) {
        setResults(data.results || []);
        if (data.timedOut) setError('部分片源搜索超时，已保留完成的结果。');
      }
    } catch (e) {
      if (mounted.current)
        setError(e.name === 'AbortError' ? '已停止搜索，已保留收到的结果。' : e.message);
    } finally {
      requestsRef.current.delete(controller);
      searchRef.current = null;
      if (mounted.current) setLoading(false);
    }
  };
  const retry = async (ruleName) => {
    if (loading || retryRef.current || !searchedKeyword.current) return;
    const controller = new AbortController();
    retryRef.current = controller;
    searchRef.current = controller;
    requestsRef.current.add(controller);
    setRetrying(ruleName);
    const replace = (group) => {
      if (mounted.current)
        setResults((current) =>
          current.map((previous) => (previous.ruleName === ruleName ? group : previous)),
        );
    };
    try {
      const data = await api('/rules/search', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ keyword: searchedKeyword.current, ruleNames: [ruleName] }),
      });
      const group = data.results?.find((result) => result.ruleName === ruleName);
      if (group) replace(group);
      else throw new Error('片源未返回搜索结果，请重试');
    } catch (e) {
      if (e.name !== 'AbortError') replace({ ruleName, items: [], error: e.message });
    } finally {
      requestsRef.current.delete(controller);
      retryRef.current = null;
      searchRef.current = null;
      if (mounted.current) setRetrying('');
    }
  };
  const open = async (ruleName, item) => {
    const key = `${ruleName}:${item.url}`;
    setOpening(key);
    setError('');
    const controller = new AbortController();
    requestsRef.current.add(controller);
    try {
      const data = await api('/rules/chapters', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ ruleName, url: item.url }),
      });
      if (!data.roads?.some((r) => r.episodes?.length))
        throw new Error('此片源没有解析到剧集，可以尝试其他搜索结果。');
      if (mounted.current)
        onPlay({
          subjectId: subject?.id,
          title: titleOf(subject || item),
          image: subject?.image || '',
          ruleName,
          sourceUrl: item.url,
          roads: data.roads,
          roadIndex: Math.max(
            0,
            data.roads.findIndex((r) => r.episodes?.length),
          ),
          episodeIndex: 0,
        });
    } catch (e) {
      if (mounted.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      requestsRef.current.delete(controller);
      if (mounted.current) setOpening('');
    }
  };
  if (!rules.length)
    return (
      <Empty
        icon={SlidersHorizontal}
        title="先为 Kazumi 添加一条规则"
        action={
          <button className="button primary" onClick={() => navigate('/rules')}>
            <Plus size={16} />
            管理规则
          </button>
        }
      >
        规则负责搜索片源和解析剧集。可从在线目录安装，也可导入 Kazumi 规则。
      </Empty>
    );
  return (
    <div className="source-search">
      <form className="source-form" onSubmit={submit}>
        <label>
          <Search size={19} />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入动画名称搜索片源"
            aria-label="片源关键词"
          />
        </label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="选择搜索规则"
        >
          <option value="">全部规则（{rules.length}）</option>
          {rules.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          className="button primary"
          disabled={loading || !!retrying || !keyword.trim()}
          type="submit"
        >
          {loading ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}搜索片源
        </button>
      </form>
      {error && <Notice>{error}</Notice>}
      {(loading || retrying) && (
        <div className="search-progress" role="status">
          <LoaderCircle className="spin" size={16} />
          <span>
            {retrying
              ? `正在重试 ${retrying}…`
              : `已完成 ${results?.length || 0} / ${total} 个片源，继续搜索中…`}
          </span>
          <button className="button quiet" onClick={() => searchRef.current?.abort()}>
            停止搜索
          </button>
        </div>
      )}
      {results && (
        <div className="source-results">
          {results.map((group) => (
            <section key={group.ruleName} className="source-group">
              <header>
                <span className="source-initial">{group.ruleName?.slice(0, 1)}</span>
                <h3>{group.ruleName}</h3>
                <small>
                  {retrying === group.ruleName
                    ? '正在重试…'
                    : group.error
                      ? '搜索失败'
                      : `${group.items?.length || 0} 个结果`}
                </small>
              </header>
              {group.error ? (
                <Notice onRetry={!loading && !retrying ? () => retry(group.ruleName) : undefined}>
                  {group.error}
                </Notice>
              ) : group.items?.length ? (
                <div className="source-items">
                  {group.items.map((item, i) => (
                    <button
                      key={`${item.url}:${i}`}
                      disabled={!!opening}
                      onClick={() => open(group.ruleName, item)}
                    >
                      <span>{item.name}</span>
                      {opening === `${group.ruleName}:${item.url}` ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Play size={15} />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted small">这个片源暂时没有匹配结果。</p>
              )}
            </section>
          ))}
          {!loading && !error && results.length === 0 && (
            <Empty icon={Search} title="没有找到可用结果">
              试试其他关键词，或在规则管理中添加片源。
            </Empty>
          )}
        </div>
      )}
      {!results && !loading && !error && (
        <div className="search-hint">
          <span className="decorative-asterisk">✳</span>
          <p>
            从一个名字，开始下一段旅程。
            <small>片源由各规则对应的网站提供，可用性取决于来源站点。</small>
          </p>
        </div>
      )}
    </div>
  );
}
