import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// Tests des Verarbeitungskerns laufen im echten Browser, weil Canvas,
// createImageBitmap, OffscreenCanvas und Worker browserabhängig sind.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Bild-/PDF-Fixtures beanspruchen viel Speicher; keine parallelen Testdateien.
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
    },
  },
});
