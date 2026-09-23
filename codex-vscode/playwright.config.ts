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
  webServer: {
    command: 'node e2e/webview/static-server.js',
    url: 'http://127.0.0.1:4573',
    reuseExistingServer: true,
    stdout: 'ignore',
  },
});
