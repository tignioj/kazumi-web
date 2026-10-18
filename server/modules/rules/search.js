export function createRuleSearch(engine, rules, keyword) {
  const completed = new Map();
  let next = 0;
  return {
    async run(options) {
      // Refill each free slot immediately, even while another source is slow.
      const worker = async () => {
        while (next < rules.length) {
          options.signal.throwIfAborted();
          const index = next++;
          const rule = rules[index];
          let result;
          try {
            const items = await engine.search(rule, keyword, options);
            options.signal.throwIfAborted();
            result = { ruleName: rule.name, items };
          } catch (error) {
            options.signal.throwIfAborted();
            result = { ruleName: rule.name, items: [], error: error.message };
          }
          completed.set(index, result);
          options.onResult?.(result);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, rules.length) }, worker));
      return { results: [...completed.values()] };
    },
    onTimeout() {
      return {
        results: [
          ...completed.values(),
          ...rules.flatMap((rule, index) =>
            completed.has(index)
              ? []
              : [{ ruleName: rule.name, items: [], error: '搜索超时，请重试此片源' }],
          ),
        ],
        timedOut: true,
      };
    },
  };
}
