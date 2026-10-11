import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './frontend/e2e', fullyParallel: true,
  reporter: 'list', use: { baseURL: 'http://127.0.0.1:5197', trace: 'retain-on-failure' },
  webServer: { command: 'npm --prefix frontend run dev -- --port 5197 --strictPort', url: 'http://127.0.0.1:5197', reuseExistingServer: !process.env.CI },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'webkit', use: { ...devices['Desktop Safari'] } }],
});
