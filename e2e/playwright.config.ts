/**
 * The browser suite.
 *
 * It runs against a stack that is already up — the API, the web client and a
 * seeded database — rather than starting one itself. Starting a database and a
 * migration from inside a test run is how a suite ends up passing against a
 * schema nobody deployed; these tests are here to say what a signed-in person
 * sees, and that is only worth knowing about the real thing.
 *
 *   pnpm --filter @kaizen/api dev     # :4000
 *   pnpm --filter @kaizen/web dev     # :5173
 *   E2E_EMAIL=… E2E_PASSWORD=… pnpm --filter @kaizen/e2e test
 *
 * The seed prints the password of each account once and stores it nowhere, so
 * the credentials come from the environment. `OWNER_PASSWORD` set before the
 * seed and read back here is the usual way round.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // One company, signed in as one person: the tests share a tenant and would
  // otherwise be reading each other's writes.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
