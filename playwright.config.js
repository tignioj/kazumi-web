import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.js',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--autoplay-policy=no-user-gesture-required'],
          // Minimal Linux images default to the C locale; Chromium then replaces
          // non-ASCII download names with "download" despite a correct HTML name.
          ...(process.platform === 'linux' ? { env: { ...process.env, LANG: 'C.UTF-8' } } : {}),
        },
      },
    },
  ],
  webServer: {
    command: 'npm run build && node test/e2e/run-app.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
