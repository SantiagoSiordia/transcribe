import { defineConfig } from '@playwright/test';

const real = !!process.env.E2E_REAL;   // npm run e2e:real: the actual models, one job at a time
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: real ? 1 : 4,
  timeout: real ? 300e3 : 60e3,
  expect: { timeout: real ? 120e3 : 15e3 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:3115', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node e2e/stack.mjs', url: 'http://127.0.0.1:3115/robots.txt', reuseExistingServer: false, timeout: 30e3,
    stdout: 'ignore', stderr: process.env.E2E_LOGS ? 'pipe' : 'ignore' }   // E2E_LOGS=1 shows the server's own log,
});
