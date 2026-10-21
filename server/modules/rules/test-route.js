import { HttpError } from '../../lib/http.js';
import { inputText } from '../../lib/validation.js';
import { assertRuleCompatible, normalizeRule } from './validation.js';

function testRule(input, stage, options) {
  const rule = normalizeRule(input, { ...options, validate: false });
  // Allow building a rule one stage at a time. Validate a scoped copy, then run
  // the original draft so unused configuration is neither executed nor changed.
  const check = { ...rule };
  if (stage !== 'search')
    Object.assign(check, {
      searchMode: 'xpath',
      searchURL: rule.baseURL,
      searchList: '//',
      searchName: '//',
      searchResult: '//',
      searchApiConfig: undefined,
      usePost: false,
    });
  if (stage !== 'chapters')
    Object.assign(check, {
      chapterMode: 'xpath',
      chapterRoads: '//',
      chapterResult: '//',
      chapterApiConfig: undefined,
    });
  assertRuleCompatible(check, options);
  return rule;
}

// Drafts use the production engines and verification sessions without touching the rule store.
export function registerRuleTestRoute(app, { validationOptions, engine, media, interactive }) {
  app.post('/api/rules/test', async (req, res) => {
    const stage = req.body?.stage;
    if (!['search', 'chapters', 'resolve'].includes(stage))
      throw new HttpError('测试类型必须是 search、chapters 或 resolve');
    const rule = testRule(req.body?.rule, stage, validationOptions);
    const value =
      stage === 'search'
        ? inputText(req.body?.keyword, '搜索词', 200)
        : inputText(req.body?.url, stage === 'chapters' ? '详情地址或来源值' : '播放地址', 8000);
    const started = performance.now();
    res.set('Cache-Control', 'no-store');
    await interactive(
      req,
      res,
      async (options) => {
        let result;
        if (stage === 'search') result = { items: await engine.search(rule, value, options) };
        else if (stage === 'chapters') {
          const roads = await engine.chapters(rule, value, options);
          if (!roads.some((road) => road.episodes?.length))
            throw new HttpError('未解析到可播放剧集，请检查章节配置或详情地址', 422);
          result = { roads };
        } else result = { source: await media.resolve(rule, value, options) };
        return { stage, elapsedMs: Math.round(performance.now() - started), ...result };
      },
      {
        stream: req.get('accept')?.includes('application/x-ndjson'),
        diagnostics: true,
        errorMessage: '规则测试中断，请重新测试',
      },
    );
  });
}
