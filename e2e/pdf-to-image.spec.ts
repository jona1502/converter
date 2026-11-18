import { Buffer } from 'node:buffer';
import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Die Server-API wird nachgestellt: Geprüft werden Bedienung, Optionen, Fehler und Löschung der Seite.
const capabilities = {
  image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
  pdf: { maxFileBytes: 100000000 },
  jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  tools: ['pdf-to-image'],
  pdfImage: {
    available: true, formats: ['png', 'jpeg', 'webp'], qualityFormats: ['jpeg', 'webp'], minDpi: 72, maxDpi: 300, defaultDpi: 150,
    maxFileBytes: 100000000, maxOutputBytes: 300000000, maxPages: 100, maxPixels: 40000000,
  },
};

async function pdf(pages: number, encrypt = false): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let page = 0; page < pages; page++) doc.addPage([100, 100]);
  if (encrypt) doc.encrypt({ userPassword: 'geheim', ownerPassword: 'owner' });
  return Buffer.from(await doc.save());
}

async function open(page: Page, caps: object = capabilities, ready = true) {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: caps }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'test-token' } }));
  await page.goto('/pdf/zu-bild');
  await expect(page.getByRole('heading', { name: 'PDF zu Bild', exact: true })).toBeVisible();
  if (ready) await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
}

function job(result: object, extra: object = {}) {
  return { id: 'job-one', state: 'succeeded', expiresAt: new Date(Date.now() + 60_000).toISOString(), input: { size: 100 }, results: [result], ...extra };
}
const image = { state: 'succeeded', size: 2048, mime: 'image/jpeg', downloadName: 'Bericht-seite-2.jpg', downloadUrl: '/api/v1/jobs/job-one/results/r1', details: { pageCount: 1, sourcePageCount: 3, archive: false } };
const archive = { state: 'succeeded', size: 4096, mime: 'application/zip', downloadName: 'Bericht-bilder.zip', downloadUrl: '/api/v1/jobs/job-one/results/r1', details: { pageCount: 3, sourcePageCount: 3, archive: true } };

test('Auswahl bleibt lokal; Start sendet Optionen vor der Datei; Entfernen löscht den Auftrag', async ({ page }) => {
  await open(page);
  const bodies: string[] = [];
  const deletions: string[] = [];
  await page.route('**/api/v1/jobs', route => {
    bodies.push(route.request().postData() ?? '');
    return route.fulfill({ status: 202, json: job(image) });
  });
  await page.route('**/api/v1/jobs/job-one', route => route.request().method() === 'DELETE' ? (deletions.push('x'), route.fulfill({ status: 204 })) : route.fulfill({ json: job(image) }));
  await page.locator('input[type=file]').setInputFiles({ name: 'Bericht.pdf', mimeType: 'application/pdf', buffer: await pdf(3) });
  const row = page.locator('.file-row');
  await expect(row).toContainText('3 Seiten');
  const action = page.getByRole('button', { name: 'Bilder erstellen', exact: true });
  await expect(action).toBeEnabled();
  expect(bodies).toHaveLength(0);
  await page.getByRole('radio', { name: 'JPEG' }).check();
  await page.getByRole('radio', { name: /300 dpi/ }).check();
  await page.getByRole('radio', { name: 'Bestimmte Seiten' }).check();
  await expect(action).toBeDisabled();
  await page.getByLabel('Seitenzahlen und Bereiche').fill('2');
  await expect(page.getByText('Ergebnis: ein Bild.')).toBeVisible();
  await expect(action).toBeEnabled();
  expect(bodies).toHaveLength(0);
  await action.click();
  const link = row.getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('download', 'Bericht-seite-2.jpg');
  expect(bodies).toHaveLength(1);
  const body = bodies[0]!;
  expect(body.indexOf('name="options"')).toBeLessThan(body.indexOf('name="file"'));
  expect(body).toContain('{"tool":"pdf-to-image","format":"jpeg","dpi":300,"pages":"2"}');
  await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('JPEG-Bild');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  const deletion = page.waitForResponse(response => response.request().method() === 'DELETE');
  await row.getByRole('button', { name: /entfernen/i }).click();
  expect((await deletion).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
});

test('Alle Seiten ergeben ein ZIP; ein einseitiges PDF fordert ausdrücklich Seite 1 an', async ({ page }) => {
  await open(page);
  const options: string[] = [];
  await page.route('**/api/v1/jobs', route => {
    options.push(/name="options"\r\n\r\n(.*)\r\n/.exec(route.request().postData() ?? '')?.[1] ?? '');
    return route.fulfill({ status: 202, json: job(options.length === 1 ? archive : { ...image, downloadName: 'Einseitig-seite-1.jpg' }) });
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'Bericht.pdf', mimeType: 'application/pdf', buffer: await pdf(3) });
  await expect(page.getByText('Ergebnis: ein ZIP-Archiv mit einem Bild je Seite.')).toBeVisible();
  await page.getByRole('button', { name: 'Bilder erstellen', exact: true }).click();
  const row = page.locator('.file-row');
  await expect(row.getByRole('link', { name: /Herunterladen/ })).toHaveAttribute('download', 'Bericht-bilder.zip');
  await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('ZIP mit 3 PNG-Bildern');
  expect(options).toEqual(['{"tool":"pdf-to-image","format":"png","dpi":150,"pages":"all"}']);
  await page.route('**/api/v1/jobs/job-one', route => route.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'Einseitig.pdf', mimeType: 'application/pdf', buffer: await pdf(1) });
  await expect(page.getByText('Ergebnis: ein Bild.')).toBeVisible();
  await page.getByRole('button', { name: 'Bilder erstellen', exact: true }).click();
  await expect(page.locator('.file-row').getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  expect(options[1]).toBe('{"tool":"pdf-to-image","format":"png","dpi":150,"pages":"1"}');
});

test('Ungültige Seitenauswahl, verschlüsselte und fremde Dateien verhindern jeden Upload', async ({ page }) => {
  await open(page);
  const creates: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/jobs')) creates.push(request.url()); });
  await page.locator('input[type=file]').setInputFiles({ name: 'geheim.pdf', mimeType: 'application/pdf', buffer: await pdf(2, true) });
  await expect(page.locator('.field-error')).toContainText('Verschlüsselte PDFs');
  await expect(page.getByRole('button', { name: 'Bilder erstellen', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'text.pdf', mimeType: 'application/pdf', buffer: Buffer.from('Hallo Welt') });
  await expect(page.locator('.field-error')).toContainText('keine erkennbare PDF');
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'zwei.pdf', mimeType: 'application/pdf', buffer: await pdf(2) });
  await page.getByRole('radio', { name: 'Bestimmte Seiten' }).check();
  const input = page.getByLabel('Seitenzahlen und Bereiche');
  await input.fill('3');
  await expect(page.getByRole('alert').filter({ hasText: 'nur 2 Seiten' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bilder erstellen', exact: true })).toBeDisabled();
  await input.fill('2-1');
  await expect(page.getByRole('alert').filter({ hasText: 'Seitennummern beginnen bei 1' })).toBeVisible();
  await input.fill('1-2');
  await expect(page.getByRole('button', { name: 'Bilder erstellen', exact: true })).toBeEnabled();
  expect(creates).toHaveLength(0);
});

test('Serverfehler erscheinen deutsch und ohne Download', async ({ page }) => {
  await open(page);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: job({ state: 'failed', size: null, mime: 'application/zip', downloadName: 'x.zip', downloadUrl: null, details: null, error: { code: 'dimensions-too-large' } }, { state: 'failed', error: { code: 'dimensions-too-large' } }) }));
  await page.locator('input[type=file]').setInputFiles({ name: 'Plan.pdf', mimeType: 'application/pdf', buffer: await pdf(1) });
  await page.getByRole('button', { name: 'Bilder erstellen', exact: true }).click();
  await expect(page.locator('.file-row[data-status="error"] .field-error')).toContainText('Megapixel');
  await expect(page.locator('a[download]')).toHaveCount(0);
});

test('Ohne verfügbaren Renderer bleibt das Werkzeug gesperrt', async ({ page }) => {
  await open(page, { ...capabilities, tools: [], pdfImage: { ...capabilities.pdfImage, available: false } }, false);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Bilder erstellen', exact: true })).toBeDisabled();
});
