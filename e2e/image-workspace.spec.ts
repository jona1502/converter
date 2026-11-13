import { Buffer } from 'node:buffer';
import { expect, test } from '@playwright/test';

// UI-Vertrag mit API-Doubles: kein Nachweis der tatsächlichen Serverkodierung.
const tools = [
  { path: '/bilder/konvertieren', action: 'Konvertieren', change: 'jpeg' },
  { path: '/bilder/komprimieren', action: 'Komprimieren', change: 'webp' },
  { path: '/bilder/skalieren', action: 'Skalieren', change: 'png' },
] as const;

for (const tool of tools) {
  for (const width of [320, 1440]) {
    test(`${tool.path} bei ${width}px: Ablauf und alte Ausgabe nach Einstellungswechsel`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
        image: { inputFormats: ['png'], outputFormats: ['jpeg', 'png', 'webp', 'bmp', 'ico'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
        pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
      } }));
      await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'workspace-test' } }));
      let uploads = 0;
      await page.route('**/api/v1/jobs', route => {
        uploads++;
        return route.fulfill({ status: 202, json: {
          id: 'workspace-job', state: 'succeeded', expiresAt: new Date(Date.now() + 60000).toISOString(), input: { size: 100 },
          results: [{ state: 'succeeded', size: 40, mime: 'image/png', downloadName: 'ausgabe.png', downloadUrl: '/api/v1/jobs/workspace-job/results/output', details: { width: 32, height: 24 } }],
        } });
      });
      await page.goto(tool.path);
      const picker = page.getByRole('button', { name: 'Dateien auswählen', exact: true });
      await expect(picker).toBeEnabled();
      const bytes = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
        return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), char => char.charCodeAt(0));
      });
      await page.locator('input[type=file]').setInputFiles({
        name: `${'langer-dateiname-'.repeat(8)}.png`, mimeType: 'image/png', buffer: Buffer.from(bytes),
      });
      const action = page.getByRole('button', { name: tool.action, exact: true });
      await expect(action).toBeEnabled();
      expect(uploads).toBe(0);
      // Die Reihenfolge bleibt auch ohne die visuelle Spaltenanordnung verständlich.
      const headings = await page.locator('main h2').allTextContents();
      expect(headings.map(text => text.trim().charAt(0))).toEqual(['1', '2', '3', '4']);
      await action.click();
      const results = page.getByRole('region', { name: '4. Dateien und Ergebnisse', exact: true });
      const download = results.getByRole('link', { name: /Herunterladen/ });
      await expect(download).toBeVisible();
      const previousUrl = await download.getAttribute('href');
      await page.getByLabel('Zielformat', { exact: true }).selectOption(tool.change);
      await expect(results.getByText(/Einstellungen.*geändert/)).toBeVisible();
      await expect(download).toHaveAttribute('href', previousUrl!);
      expect(uploads).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await expect(page.locator('main [style]')).toHaveCount(0);
    });
  }
}
