import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Die Server-API ist gemockt: Diese Tests prüfen Oberfläche, Optionen und Datenschutzverhalten,
// nicht die PDF-Verarbeitung (siehe pdf-rotate-stack.spec.ts für den echten Server).
const capabilities = {
  image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
  pdf: { maxFileBytes: 100000000 },
  jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  pdfRotate: { available: true, maxFileBytes: 100000000, maxOutputBytes: 300000000, angles: [90, 180, 270] },
  tools: ['image-convert', 'pdf-rotate'],
};
const pdf = { name: 'Bericht Q3.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n% Platzhalter, der Server wird gemockt\n') };

async function prepare(page: Page, patch: (value: typeof capabilities) => unknown = value => value, usable = true) {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: patch(structuredClone(capabilities)) }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'test-token' } }));
  await page.goto('/pdf/drehen');
  await expect(page.getByRole('heading', { name: 'PDF drehen', exact: true, level: 1 })).toBeVisible();
  // Erst nach Hydration und Capabilities ist die Auswahl bedienbar.
  if (usable) await expect(picker(page)).toBeEnabled();
}
const start = (page: Page) => page.getByRole('button', { name: 'PDF drehen', exact: true });
const picker = (page: Page) => page.getByRole('button', { name: 'Dateien auswählen', exact: true });
const succeeded = (extra: object = {}) => ({
  id: 'one', state: 'succeeded', expiresAt: new Date(Date.now() + 60_000).toISOString(), input: { size: 100 },
  results: [{ state: 'succeeded', size: 140, mime: 'application/pdf', downloadName: 'Bericht Q3-gedreht.pdf',
    downloadUrl: '/api/v1/jobs/one/results/two', details: { pageCount: 4, rotatedPages: 2 } }],
  ...extra,
});

test('Auswahl bleibt lokal; ausdrücklicher Start sendet vollständige Optionen und zeigt das Ergebnis', async ({ page }) => {
  await prepare(page);
  const bodies: string[] = [];
  let deleted = 0;
  await page.route('**/api/v1/jobs', route => { bodies.push(route.request().postData() ?? ''); return route.fulfill({ status: 202, json: succeeded() }); });
  await page.route('**/api/v1/jobs/one', route => route.request().method() === 'DELETE' ? (deleted++, route.fulfill({ status: 204 })) : route.fulfill({ json: succeeded() }));
  await page.locator('input[type=file]').setInputFiles(pdf);
  await expect(start(page)).toBeEnabled();
  expect(bodies).toHaveLength(0);
  await start(page).click();
  const row = page.locator('.file-row');
  const link = row.getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('download', 'Bericht Q3-gedreht.pdf');
  await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('2 von 4');
  await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('90° im Uhrzeigersinn, alle Seiten');
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.indexOf('name="options"')).toBeLessThan(bodies[0]!.indexOf('name="file"'));
  expect(bodies[0]).toContain('{"tool":"pdf-rotate","angle":90,"pages":"all"}');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await row.getByRole('button', { name: /entfernen/i }).click();
  await expect(row).toHaveCount(0);
  expect(deleted).toBe(1);
  await expect(picker(page)).toBeFocused();
});

test('Winkel und Seitenbereich landen unverändert in den Optionen', async ({ page }) => {
  await prepare(page);
  const bodies: string[] = [];
  await page.route('**/api/v1/jobs', route => { bodies.push(route.request().postData() ?? ''); return route.fulfill({ status: 202, json: succeeded() }); });
  await page.locator('input[type=file]').setInputFiles(pdf);
  await page.getByRole('radio', { name: '90° nach links (270°)' }).check();
  await page.getByRole('radio', { name: 'Bestimmte Seiten' }).check();
  const pages = page.getByRole('textbox', { name: 'Seitenangabe' });
  await pages.fill('3-1');
  await expect(page.locator('.field-error')).toContainText('umgekehrt');
  await expect(pages).toHaveAttribute('aria-invalid', 'true');
  await expect(start(page)).toBeDisabled();
  await pages.fill(' 1-2 , 4 ');
  await expect(page.locator('.field-error')).toHaveCount(0);
  await expect(start(page)).toBeEnabled();
  await start(page).click();
  await expect(page.locator('a[download]')).toBeVisible();
  expect(bodies[0]).toContain('{"tool":"pdf-rotate","angle":270,"pages":"1-2,4"}');
});

test('Datei ohne PDF-Signatur und leere Seitenangabe lösen keinen Upload aus', async ({ page }) => {
  await prepare(page);
  const creates: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/jobs')) creates.push(request.url()); });
  await page.locator('input[type=file]').setInputFiles({ name: 'foto.pdf', mimeType: 'application/pdf', buffer: Buffer.from('kein pdf') });
  await expect(page.locator('.file-row .field-error')).toContainText('keine erkennbare PDF');
  await expect(start(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(pdf);
  await page.getByRole('radio', { name: 'Bestimmte Seiten' }).check();
  await expect(start(page)).toBeDisabled();
  expect(creates).toHaveLength(0);
});

test('Verschlüsselte PDF: verständlicher Fehler ohne Download', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: { id: 'one', state: 'queued', expiresAt: new Date(Date.now() + 60_000).toISOString(), input: { size: 100 }, results: [] } }));
  await page.route('**/api/v1/jobs/one', route => route.fulfill({ json: { id: 'one', state: 'failed', expiresAt: new Date(Date.now() + 60_000).toISOString(), input: { size: 100 }, error: { code: 'encrypted' }, results: [] } }));
  await page.locator('input[type=file]').setInputFiles(pdf);
  await start(page).click();
  await expect(page.locator('.file-row[data-status="error"] .field-error')).toContainText('Verschlüsselte PDFs werden nicht unterstützt');
  await expect(page.locator('a[download]')).toHaveCount(0);
});

test('Fehlende Server-Verfügbarkeit sperrt Auswahl und Start', async ({ page }) => {
  await prepare(page, value => ({ ...value, pdfRotate: { ...value.pdfRotate, available: false }, tools: ['image-convert'] }), false);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(picker(page)).toBeDisabled();
  await expect(start(page)).toBeDisabled();
});

test('Werkzeug ist in der Navigation unter Drehen erreichbar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Mobile Navigation: siehe navigation.spec.ts');
  await page.goto('/');
  const nav = page.getByRole('navigation').first();
  await nav.getByRole('button', { name: 'Drehen-Menü', exact: true }).click();
  await nav.getByRole('link', { name: 'PDF drehen', exact: true }).click();
  await expect(page).toHaveURL(/\/pdf\/drehen\/?$/);
});
