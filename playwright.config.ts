import { defineConfig, devices } from '@playwright/test';

// End-to-End-Tests gegen den statischen Produktionsbuild (astro preview).
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // CI setzt PW_WORKERS je Browserjob höher; lokal bleiben zwei Worker.
  workers: Number(process.env.PW_WORKERS) || 2,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4329',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'npm run build && npm run preview -- --port 4329',
    url: 'http://localhost:4329',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // WebKit unter Windows/Linux nähert Safari nur an; Abweichungen (z. B. WebP-Kodierung) werden so sichtbar.
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
