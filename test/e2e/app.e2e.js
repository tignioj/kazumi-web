import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fixtureRule, fixtureUrl } from './fixtures/upstream.mjs';

test('production HTTP routes search rules, parse roads, resolve video and preserve byte ranges', async ({
  request,
}) => {
  const imported = await request.post('/api/rules/import', {
    data: { content: JSON.stringify(fixtureRule) },
  });
  expect(imported.ok()).toBeTruthy();
  expect((await imported.json()).rules).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: fixtureRule.name })]),
  );

  const search = await request.post('/api/rules/search', {
    data: { keyword: '测试番剧', ruleNames: [fixtureRule.name] },
  });
  expect(search.ok()).toBeTruthy();
  const found = (await search.json()).results[0];
  expect(found.error).toBeFalsy();
  // Both names must remain distinct: leading // selectors are fragment-relative.
  expect(found.items).toEqual([
    { name: '测试番剧', url: `${fixtureUrl}/source/subject/101` },
    { name: '夜空列车', url: `${fixtureUrl}/source/subject/102` },
  ]);
  const chapters = await request.post('/api/rules/chapters', {
    data: { ruleName: fixtureRule.name, url: found.items[0].url },
  });
  expect(chapters.ok()).toBeTruthy();
  const { roads } = await chapters.json();
  expect(roads).toHaveLength(2);
  expect(roads[0].episodes.map((episode) => episode.name)).toEqual(['第1集', '第2集']);
  expect(roads[1].episodes).toHaveLength(1);

  const resolved = await request.post('/api/resolve', {
    data: { ruleName: fixtureRule.name, url: roads[0].episodes[0].url },
  });
  expect(resolved.ok()).toBeTruthy();
  const media = await resolved.json();
  expect(media.type).toBe('video');
  expect(media.url).toMatch(/^\/api\/media\?/);
  const partial = await request.get(media.url, { headers: { Range: 'bytes=0-63' } });
  expect(partial.status()).toBe(206);
  expect(partial.headers()['content-range']).toMatch(/^bytes 0-63\/\d+$/);
  const video = await readFile(new URL('../fixtures/media/sample.mp4', import.meta.url));
  expect(await partial.body()).toEqual(video.subarray(0, 64));
});

test('catalogue search, calendar and collection survive a browser reload', async ({
  page,
}, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '查看 测试番剧', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看 夜空列车', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-discover.png'), fullPage: true });
  await page.getByLabel('搜索动画', { exact: true }).fill('测试番剧');
  await page.getByLabel('搜索动画', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '关于「测试番剧」', exact: false })).toBeVisible();
  await page.getByRole('button', { name: '查看 测试番剧', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: '测试番剧', exact: true }),
  ).toBeVisible();
  await page.getByLabel('收藏状态').selectOption('在看');
  await page.reload();
  await expect(page.getByLabel('收藏状态')).toHaveValue('在看');
  await page.getByRole('link', { name: /我的收藏/ }).click();
  await expect(page.getByRole('button', { name: '查看 测试番剧', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '放送日历', exact: true }).click();
  await page.getByRole('button', { name: /周一/ }).click();
  await expect(page.getByRole('button', { name: '查看 测试番剧', exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('rules can be imported, edited, exported and removed using the interface', async ({
  page,
  request,
}) => {
  const rule = { ...fixtureRule, name: '可编辑测试源' };
  await page.goto('/#/rules');
  await page.getByRole('button', { name: '导入规则', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入 Kazumi 规则', exact: true });
  await dialog.getByLabel('规则 JSON 或分享链接').fill('invalid rule');
  await dialog.getByRole('button', { name: '导入规则', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog
    .getByLabel('规则 JSON 或分享链接')
    .fill(`kazumi://${Buffer.from(JSON.stringify(rule)).toString('base64')}`);
  const checked = page.waitForResponse((response) =>
    response.url().endsWith('/api/rules/validate'),
  );
  await dialog.getByRole('button', { name: '检查兼容性', exact: true }).click();
  expect((await checked).ok()).toBeTruthy();
  expect(
    (await (await request.get('/api/rules')).json()).rules.some((item) => item.name === rule.name),
  ).toBeFalsy();
  await dialog.getByRole('button', { name: '导入规则', exact: true }).click();
  await expect(dialog).toBeHidden();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: rule.name, exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.getByText('API 8', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '编辑规则', exact: true }).click();
  const editor = page.getByRole('dialog', { name: `编辑规则 · ${rule.name}`, exact: true });
  await editor.getByRole('button', { name: 'JSON 编辑', exact: true }).click();
  await editor.getByLabel('规则 JSON', { exact: true }).fill(
    JSON.stringify({
      ...rule,
      version: '2.0',
      api: '99',
    }),
  );
  await editor.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('版本');
  const preserved = (await (await request.get('/api/rules')).json()).rules.find(
    (item) => item.name === rule.name,
  );
  expect(preserved.version).toBe('1.0');
  expect(preserved.antiCrawlerConfig.enabled).toBe(false);
  await editor.getByRole('button', { name: '表单编辑', exact: true }).click();
  await expect(editor.getByLabel('规则名称', { exact: true })).toHaveValue(rule.name);
  await editor.getByLabel('API 版本', { exact: true }).fill(rule.api);
  await editor.getByLabel('规则版本', { exact: true }).fill('2.0');
  await editor.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(editor).toBeHidden();
  await page.route('**/api/rules/updates', (route) =>
    route.fulfill({
      json: {
        updates: [],
        blocked: [{ name: rule.name, status: 'incompatible', message: 'captchaScript 语法错误' }],
      },
    }),
  );
  await page.reload();
  await expect(card.getByText('版本 2.0', { exact: true })).toBeVisible();
  await expect(card.getByText('更新受阻', { exact: true })).toBeVisible();
  await expect(card.getByRole('status')).toContainText('已保留当前规则');
  const downloadEvent = page.waitForEvent('download');
  await card.getByRole('button', { name: `导出 ${rule.name}`, exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`${rule.name}.json`);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported).toMatchObject({
    name: rule.name,
    version: '2.0',
    searchName: fixtureRule.searchName,
  });
  await card.getByRole('button', { name: `删除 ${rule.name}`, exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除规则', exact: true })
    .getByRole('button', { name: '删除规则', exact: true })
    .click();
  await expect(card).toBeHidden();
});

test('MP4 and HLS really play, record progress and resume the selected episode', async ({
  page,
  request,
}, testInfo) => {
  await request.post('/api/rules/import', { data: { content: fixtureRule } });
  await page.goto('/#/subject/101');
  await page.getByLabel('选择搜索规则').selectOption(fixtureRule.name);
  await page.getByRole('button', { name: '搜索片源', exact: true }).click();
  await expect(page.getByRole('button', { name: '夜空列车', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '测试番剧', exact: true }).click();
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await video.evaluate((element) => element.play());
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.4);
  await expect.poll(() => video.evaluate((element) => element.videoWidth)).toBe(160);
  await page.getByRole('button', { name: '第2集', exact: true }).click();
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await video.evaluate((element) => {
    element.currentTime = 7;
    void element.play();
  });
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(7.3);
  await video.evaluate((element) => element.pause());
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: testInfo.outputPath('desktop-player.png'), fullPage: true });
  await page.getByRole('button', { name: '返回浏览', exact: true }).click();
  await page.getByRole('link', { name: '观看记录', exact: true }).click();
  await expect(page.getByText(/观看至 0:0[7-9]/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/观看至 0:0[7-9]/)).toBeVisible();
  await page.getByRole('button', { name: '继续观看', exact: true }).click();
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThanOrEqual(7);
  await expect(page.locator('.player-heading')).toContainText('第2集');
});

test('mobile pages and rule editor fit the viewport', async ({ page, request }, testInfo) => {
  await request.post('/api/rules/import', { data: { content: fixtureRule } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '查看 测试番剧', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-discover.png'), fullPage: true });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('link', { name: '放送日历', exact: true }).click();
  await expect(page.getByRole('heading', { name: '每天，都有期待', exact: false })).toBeVisible();
  for (const route of [
    'calendar',
    'subject/101',
    'sources',
    'rules',
    'settings',
    'library',
    'history',
  ]) {
    await page.goto(`/#/${route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      `${route} should not scroll sideways`,
    ).toBeLessThanOrEqual(1);
  }
  await page.goto('/#/rules');
  await page.getByRole('button', { name: '导入规则', exact: true }).click();
  await page.getByLabel('规则 JSON 或分享链接').fill(JSON.stringify(fixtureRule, null, 2));
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: fixtureRule.name, exact: true }) })
    .getByRole('button', { name: '编辑规则', exact: true })
    .click();
  await expect(page.getByLabel('规则名称', { exact: true })).toHaveValue(fixtureRule.name);
  await expect(page.getByRole('button', { name: '保存规则', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('mobile-rule-editor.png') });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
});

test('playback speed, automatic next episode and sidebar navigation work during playback', async ({
  page,
  request,
}) => {
  await request.post('/api/rules/import', { data: { content: fixtureRule } });
  await page.goto('/#/settings');
  await page.getByRole('switch', { name: '自动播放下一话', exact: true }).click();
  await expect(page.getByRole('switch', { name: '自动播放下一话', exact: true })).toBeChecked();
  await page.goto('/#/subject/101');
  await page.getByLabel('选择搜索规则').selectOption(fixtureRule.name);
  await page.getByRole('button', { name: '搜索片源', exact: true }).click();
  await page.getByRole('button', { name: '测试番剧', exact: true }).click();
  const video = page.locator('video');
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(1);
  await page.getByLabel('显示设置', { exact: true }).click();
  await page.getByText('播放速度', { exact: true }).click();
  await page
    .locator('.art-setting-item-left-text')
    .filter({ hasText: /^1\.5$/ })
    .click();
  await expect.poll(() => video.evaluate((element) => element.playbackRate)).toBe(1.5);
  await video.evaluate(async (element) => {
    element.currentTime = element.duration - 0.15;
    await element.play();
  });
  await expect(page.locator('.player-heading')).toContainText('第2集');
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.3);
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(false);
  await page.getByRole('link', { name: '观看记录', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: '故事，继续', exact: false }),
  ).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
});

test('dark theme persists and malformed backups are rejected without losing the interface', async ({
  page,
}) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/#/settings');
  await page.getByLabel('显示主题').selectOption('dark');
  await page.reload();
  await expect(page.getByLabel('显示主题')).toHaveValue('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return { background: style.backgroundColor, foreground: style.color };
  });
  expect(colors).toEqual({ background: 'rgb(25, 27, 25)', foreground: 'rgb(231, 233, 224)' });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'malformed-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'kazumi-web-backup',
        version: 1,
        library: { 101: { subject: { id: 101, name_cn: { invalid: 'object' } }, status: '在看' } },
        history: [],
      }),
    ),
  });
  await expect(page.getByRole('alert')).toContainText('备份中的收藏格式不完整');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 1, name: '按你的方式', exact: false }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
