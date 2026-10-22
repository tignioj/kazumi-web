// Trace collection is opt-in for draft tests. Limits affect diagnostics only;
// the engine still parses the complete response and counts every candidate.
export const TRACE_LIMITS = Object.freeze({
  response: 256 * 1024,
  fragment: 4096,
  nodes: 200,
  selections: 300,
  diagnostics: 80,
  text: 2048,
});

const clip = (value, limit = TRACE_LIMITS.text) => String(value ?? '').slice(0, limit);
const counts = () => ({ matched: 0, accepted: 0, skipped: 0 });

export class RuleParseTrace {
  constructor(stage, mode) {
    this.stage = stage;
    this.mode = mode;
    this.reset();
  }

  reset() {
    this.selections = [];
    this.nodes = [];
    this.diagnostics = [];
    this.counts = { items: counts(), roads: counts(), episodes: counts() };
    this.omittedNodes = 0;
    this.omittedSelections = 0;
    this.omittedDiagnostics = 0;
  }

  capture(raw, format) {
    // A browser retry replaces the challenge response with the response that
    // produced these results; never mix its nodes with an earlier attempt.
    this.reset();
    const text = String(raw ?? '');
    this.response = {
      format,
      raw: clip(text, TRACE_LIMITS.response),
      length: text.length,
      truncated: text.length > TRACE_LIMITS.response,
    };
  }

  select(label, expression, context, matched) {
    if (this.selections.length >= TRACE_LIMITS.selections) {
      this.omittedSelections++;
      return;
    }
    this.selections.push({
      label: clip(label),
      expression: clip(expression),
      context: clip(context),
      matched,
    });
  }

  node({ kind, index, roadIndex, status, reason, name, url, fragment }) {
    const counter = this.counts[{ item: 'items', road: 'roads', episode: 'episodes' }[kind]];
    counter.matched++;
    counter[status]++;
    if (this.nodes.length >= TRACE_LIMITS.nodes) {
      this.omittedNodes++;
      // Keep a late missing episode visible even when a long series has
      // already filled the detail budget with successful episodes.
      const replace =
        status === 'skipped' ? this.nodes.findIndex((node) => node.status === 'accepted') : -1;
      if (replace < 0) return;
      this.nodes.splice(replace, 1);
    }
    let text = '';
    let fragmentError;
    try {
      text = String((typeof fragment === 'function' ? fragment() : fragment) ?? '');
    } catch {
      // Deep, otherwise valid JSON/HTML can exceed serializer recursion limits.
      // Diagnostic rendering must never turn a successful parse into a failure.
      fragmentError = '片段无法序列化，请查看原始响应';
      const label = { item: '搜索条目', road: '播放线路', episode: '剧集' }[kind];
      this.diagnostic(
        `${roadIndex ? `线路 ${roadIndex} / ` : ''}${label} ${index}：${fragmentError}`,
      );
    }
    this.nodes.push({
      kind,
      index,
      ...(roadIndex !== undefined ? { roadIndex } : {}),
      status,
      ...(reason !== undefined ? { reason: clip(reason) } : {}),
      ...(name !== undefined ? { name: clip(name) } : {}),
      ...(url !== undefined ? { url: clip(url) } : {}),
      fragment: clip(text, TRACE_LIMITS.fragment),
      fragmentLength: text.length,
      fragmentTruncated: text.length > TRACE_LIMITS.fragment,
      ...(fragmentError ? { fragmentError } : {}),
    });
  }

  diagnostic(message) {
    if (this.diagnostics.length >= TRACE_LIMITS.diagnostics) this.omittedDiagnostics++;
    else this.diagnostics.push(clip(message));
  }

  snapshot() {
    return structuredClone({
      stage: this.stage,
      mode: this.mode,
      ...(this.response ? { response: this.response } : {}),
      selections: this.selections,
      nodes: this.nodes,
      counts: this.counts,
      diagnostics: this.diagnostics,
      omittedNodes: this.omittedNodes,
      omittedSelections: this.omittedSelections,
      omittedDiagnostics: this.omittedDiagnostics,
    });
  }
}
