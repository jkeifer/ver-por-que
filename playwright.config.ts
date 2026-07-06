import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke suite (e2e/smoke.spec.ts) against a production build served by
 * `vite preview`. Chromium only — this is a safety net, not a browser matrix.
 */
export default defineConfig({
    testDir: 'e2e',
    forbidOnly: !!process.env.CI,
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    use: { baseURL: 'http://127.0.0.1:4173' },
    webServer: {
        command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
