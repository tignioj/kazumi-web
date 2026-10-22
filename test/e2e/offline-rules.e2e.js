import { test, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import {
  createOfficialRulesCatalog,
  DEFAULT_RULES_REPOSITORY,
} from '../../server/modules/rules/catalog.js';

const rule = {
  name: '缓存规则',
  version: '1',
  baseURL: 'https://source.example/',
  searchURL: 'https://source.example/?wd=@keyword',
  searchList: '//a',
  searchName: '.',
  searchResult: '.',
  chapterRoads: '//ul',
  chapterResult: '//a',
};

for (const hasCache of [false, true])
  test(`offline rules ${hasCache ? 'use persisted data after restart' : 'report an outage without a cache and recover on retry'}`, async ({
    page,
  }, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'kazumi-offline-browser-'));
    let online = false;
    const remote = async (url) =>
      url.endsWith('index.json') ? [{ name: rule.name, version: rule.version }] : rule;
    if (hasCache) {
      const cached = createOfficialRulesCatalog(
        { json: remote },
        {
          directory,
          repository: DEFAULT_RULES_REPOSITORY,
          now: () => Date.now() - 2 * 60 * 60 * 1000,
        },
      );
      await cached.officialRules();
      await cached.officialRule(rule.name);
    }
    const application = await createApp({
      dataDir: directory,
      seedRules: [],
      metadata: {},
      browserResolver: false,
      rulesRepository: DEFAULT_RULES_REPOSITORY,
      httpClient: {
        json: async (url) => {
          if (!online) throw new Error('network offline');
          return remote(url);
        },
        close: async () => {},
      },
    });
    const server = application.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/#/rules`);
      await page.getByRole('button', { name: '规则目录', exact: false }).click();
      if (hasCache) {
        await expect(page.getByRole('alert')).toContainText('正在使用本地缓存');
      } else {
        await expect(page.getByRole('alert')).toContainText('规则仓库暂不可用');
        await expect(page.locator('.catalog-rules article')).toHaveCount(0);
        const install = await page.request.post(`${new URL(page.url()).origin}/api/rules/install`, {
          data: { name: rule.name },
        });
        expect(install.status()).toBe(502);
        expect(application.store.list()).toEqual([]);
        online = true;
        await page.getByRole('button', { name: '重试', exact: true }).click();
      }
      await expect(page.locator('.rule-repository')).toContainText(DEFAULT_RULES_REPOSITORY);
      const card = page
        .locator('.catalog-rules article')
        .filter({ has: page.getByRole('heading', { name: rule.name, exact: true }) });
      await card.getByRole('button', { name: '安装', exact: true }).click();
      await expect(
        page.getByText(`已安装「${rule.name}」${hasCache ? '（来自本地缓存）' : ''}`, {
          exact: true,
        }),
      ).toBeVisible();
      online = false;
      await card.getByRole('button', { name: '检查更新', exact: true }).click();
      await expect(page.getByText(/规则仓库暂不可用，无法确认更新/)).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      if (hasCache) await expect(page.getByRole('alert')).toContainText('正在使用本地缓存');
      expect(application.store.list().map(({ name }) => name)).toEqual([rule.name]);
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
