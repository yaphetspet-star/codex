import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/webview',
  // The suite drives one shared bundle on disk and writes screenshots by name.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4573',
  },
  // `assert` has right answers and gates changes; `review` only produces evidence for a
  // human decision, so it must not run as part of the test suite.
  projects: [
    { name: 'assert', testMatch: /ui\.spec\.ts/ },
    { name: 'review', testMatch: /review\.spec\.ts/ },
  ],
  webServer: {
    command: 'node e2e/webview/static-server.js',
    url: 'http://127.0.0.1:4573',
    reuseExistingServer: true,
    stdout: 'ignore',
  },
});
