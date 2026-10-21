import { HttpError } from '../../lib/http.js';
import { inputText } from '../../lib/validation.js';
import {
  checkInstalledRuleUpdates,
  downloadOfficialRule,
  updateInstalledRules,
} from './updates.js';
import { createOfficialRulesCatalog } from './catalog.js';
import { RULE_API_VERSION, ruleCompatibility } from './validation.js';
import { parseImport } from './store.js';
import { createRuleSearch } from './search.js';

export function registerRuleRoutes(app, { http, store, engine, interactive }) {
  const { repository, officialRules, officialRule } = createOfficialRulesCatalog(http);
  const options = { ...store.validationOptions, loadRule: officialRule };
  app.get('/api/rules', (req, res) =>
    res.json({
      rules: store.list(),
      compatibility: store
        .list()
        .map((rule) => ({ name: rule.name, ...ruleCompatibility(rule, options) })),
      capabilities: {
        apiLevel: RULE_API_VERSION,
        dynamicResolver: options.dynamicResolver !== false,
      },
    }),
  );
  app.get('/api/rules/updates', async (req, res) => {
    const catalog = await officialRules();
    res.json(await checkInstalledRuleUpdates(store, http, repository, catalog, options));
  });
  app.post('/api/rules', async (req, res) =>
    res.status(201).json({ rules: await store.create(req.body) }),
  );
  app.get('/api/rules/catalog', async (req, res) => res.json({ rules: await officialRules() }));
  app.post('/api/rules/validate', async (req, res) => {
    const rules = parseImport(req.body?.content, options);
    res.json({
      compatibility: rules.map((rule) => ({
        name: rule.name,
        ...ruleCompatibility(rule, options),
      })),
    });
  });
  app.post('/api/rules/import', async (req, res) =>
    res.json({ rules: await store.import(req.body?.content) }),
  );
  app.post('/api/rules/install', async (req, res) => {
    const name = inputText(req.body?.name, '规则名称', 100);
    const listed = (await officialRules()).find(
      (rule) => rule.name.toLowerCase() === name.toLowerCase(),
    );
    if (!listed) throw new HttpError('官方规则仓库中找不到此规则', 404);
    const rule = await downloadOfficialRule(http, repository, listed.name, {
      ...options,
      loadRule: (name) => officialRule(name, true),
    });
    res.json({ rules: await store.import(rule) });
  });
  app.post('/api/rules/update', async (req, res) => {
    const name =
      req.body?.name === undefined ? undefined : inputText(req.body.name, '规则名称', 100);
    if (name) store.get(name);
    res.json(
      await updateInstalledRules(store, http, repository, await officialRules(true), name, {
        ...options,
        loadRule: (name) => officialRule(name, true),
      }),
    );
  });
  app.put('/api/rules/:name', async (req, res) =>
    res.json({ rules: await store.replace(req.params.name, req.body) }),
  );
  app.delete('/api/rules/:name', async (req, res) =>
    res.json({ rules: await store.remove(req.params.name) }),
  );
  app.post('/api/rules/search', async (req, res) => {
    const keyword = inputText(req.body?.keyword, '搜索词', 200);
    const names = req.body?.ruleNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
    )
      throw new HttpError('ruleNames 必须是规则名称数组');
    const rules = names
      ? [...new Set(names)].map((name) => store.get(name))
      : store.list().filter((rule) => rule.enabled !== false);
    if (rules.length > 30) throw new HttpError('一次最多搜索 30 个来源，请选择部分规则');
    const search = createRuleSearch(engine, rules, keyword);
    await interactive(req, res, search.run, {
      stream:
        req.accepts('application/x-ndjson') && req.get('accept')?.includes('application/x-ndjson'),
      onTimeout: search.onTimeout,
    });
  });
  app.post('/api/rules/chapters', async (req, res) => {
    const rule = store.get(inputText(req.body?.ruleName, '规则名称', 100));
    const source = inputText(req.body?.url, '条目地址', 8000);
    await interactive(req, res, async (options) => {
      const roads = await engine.chapters(rule, source, options);
      if (!roads.length) throw new HttpError('来源未返回可播放剧集，请更新规则或更换来源', 422);
      return { roads };
    });
  });
}
