import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import { DEFAULT_RULES_REPOSITORY } from '../../server/modules/rules/catalog.js';

test('an offline first start shows the bundled catalog, installs a rule and reports unavailable updates', async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'kazumi-offline-browser-'));
  const application = await createApp({
    dataDir: directory,
    seedRules: [],
    metadata: {},
    browserResolver: false,
    rulesRepository: DEFAULT_RULES_REPOSITORY,
    httpClient: {
      json: async () => {
        throw new Error('network offline');
      },
      close: async () => {},
    },
  });
  const server = application.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/#/rules`);
    await page.getByRole('button', { name: '规则目录', exact: false }).click();
    await expect(page.getByRole('alert')).toContainText('正在使用内置快照');
    await expect(page.locator('.rule-repository')).toContainText(DEFAULT_RULES_REPOSITORY);
    const rule = page
      .locator('.catalog-rules article')
      .filter({ has: page.getByRole('heading', { name: '7sefun', exact: true }) });
    await rule.getByRole('button', { name: '安装', exact: true }).click();
    await expect(page.getByText('已安装「7sefun」（来自内置快照）', { exact: true })).toBeVisible();
    await rule.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(page.getByText(/规则仓库暂不可用，无法确认更新/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('alert')).toContainText('正在使用内置快照');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath('offline-rules-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
