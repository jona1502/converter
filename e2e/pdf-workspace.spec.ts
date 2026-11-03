import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

// Diese API-Fixtures prüfen die Oberfläche, nicht die echte PDF-Verarbeitung.
async function prepare(page: Page) {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
    pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'pdf-workspace-test' } }));
  await page.goto('/pdf/komprimieren');
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeEnabled();
}

async function select(page: Page) {
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles({
    name: `${'langer-dateiname-'.repeat(8)}.pdf`, mimeType: 'application/pdf', buffer: Buffer.alloc(20000, 'x'),
  });
}

for (const width of [320, 1440]) {
  test(`PDF bei ${width}px: Auswahl, Einstellungen und Start bleiben getrennt und ohne Upload`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page);
    let uploads = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/jobs')) uploads++; });
    const action = page.getByRole('button', { name: 'Komprimieren', exact: true });
    await expect(action).toBeDisabled();
    await select(page);
    await expect(action).toBeEnabled();
    const headings = await page.locator('main h2').allTextContents();
    expect(headings.map(text => text.trim().charAt(0))).toEqual(['1', '2', '3', '4']);
    const selection = page.getByRole('region', { name: '1. PDF auswählen', exact: true });
    await expect(selection).toContainText('20 KB');
    await expect(selection.getByRole('button', { name: 'Komprimieren', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '2. Einstellungen', exact: true })).toContainText('Hohe Qualität');
    expect(uploads).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
    await expect(action).toBeDisabled();
    await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeFocused();
  });
}
