import { defineConfig } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8791';

export default defineConfig({
  testDir: '.',
  outputDir: '../.local/e2e-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    colorScheme: 'light',
    trace: 'off',
    screenshot: 'only-on-failure',
    // Optional: use an already-installed Chromium instead of `npx playwright install chromium`.
    launchOptions: process.env['E2E_CHROMIUM'] ? { executablePath: process.env['E2E_CHROMIUM'] } : {},
  },
  projects: [
    { name: 'e2e', testMatch: /app\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } },
  ],
});
