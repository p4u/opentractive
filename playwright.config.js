import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e', workers: 1, fullyParallel: false, retries: 0, timeout: 90_000,
  outputDir: 'test-results/artifacts', reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://app-e2e:8080', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
});
