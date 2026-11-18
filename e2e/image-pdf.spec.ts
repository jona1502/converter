import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page, type Request } from '@playwright/test';

// API-Doubles belegen Auswahl, Reihenfolge, Einstellungen und das gesendete Bündel;
// die PDF-Erzeugung selbst prüfen die Go- und Python-Tests.

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** Gültiges, einfarbiges PNG; die Farbe unterscheidet die Bilder im Bündel. */
function png(r: number, g: number, b: number, width = 3, height = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const red = { name: 'rot.png', mimeType: 'image/png', buffer: png(250, 0, 0) };
const green = { name: 'gruen.png', mimeType: 'image/png', buffer: png(0, 250, 0) };
const blue = { name: 'blau.png', mimeType: 'image/png', buffer: png(0, 0, 250) };

function job(pages: number, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: 'pdf-job', tool: 'image-pdf', state: 'succeeded', phase: null, progress: null, analysis: null, error: null, cancelRequested: false,
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(),
    input: { name: 'bilder.zip', format: 'zip', size: 10, width: null, height: null },
    results: [{ id: 'result', level: null, state: 'succeeded', size: 4321, mime: 'application/pdf', downloadName: 'bilder.pdf',
      downloadUrl: '/api/v1/jobs/pdf-job/results/result', details: { pageCount: pages }, error: null }],
    ...extra,
  };
}

const capabilities = (available = true) => ({
  tools: available ? ['image-pdf'] : [],
  imagePdf: available
    ? { available: true, maxImages: 30, maxImageBytes: 52428800, maxTotalBytes: 104857600, maxOutputBytes: 104857600 }
    : { available: false, maxImages: 0, maxImageBytes: 0, maxTotalBytes: 0, maxOutputBytes: 0 },
  image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
  pdf: { maxFileBytes: 1 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
});

async function mockApi(page: Page, options: { available?: boolean; pages?: number; jobOverride?: Record<string, unknown> } = {}) {
  const requests: Request[] = [];
  await page.route('**/api/v1/capabilities', (route) => route.fulfill({ json: capabilities(options.available ?? true) }));
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: { csrfToken: 'image-pdf-test' } }));
  await page.route('**/api/v1/jobs/*', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/v1/jobs', (route) => {
    requests.push(route.request());
    return route.fulfill({ status: 202, json: job(options.pages ?? 3, options.jobOverride) });
  });
  return requests;
}

function optionsOf(request: Request): Record<string, unknown> {
  const body = request.postDataBuffer()!.toString('latin1');
  return JSON.parse(/name="options"\r\n\r\n(.*?)\r\n/s.exec(body)![1]!) as Record<string, unknown>;
}

const rows = (page: Page) => page.getByTestId('image-row');
const create = (page: Page) => page.getByRole('button', { name: 'PDF erstellen', exact: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test('Auswahl und Reihenfolge bleiben lokal; erst der Start lädt ein Bündel in dieser Reihenfolge hoch', async ({ page }, testInfo) => {
  const requests = await mockApi(page);
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByRole('heading', { name: 'Bild zu PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeEnabled();
  await expect(create(page)).toBeDisabled();

  await page.locator('input[type=file]').setInputFiles([red, green, blue]);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).locator('.badge', { hasText: 'Bereit' })).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText('Seite 1: rot.png');
  expect(requests, 'Auswahl darf nichts hochladen').toHaveLength(0);

  // Reihenfolge: rot, gruen, blau -> (rot nach hinten) gruen, rot, blau -> (blau zweimal nach vorn) blau, gruen, rot
  await rows(page).nth(0).getByRole('button', { name: 'rot.png eine Seite nach hinten' }).click();
  await expect(rows(page).nth(1)).toContainText('Seite 2: rot.png');
  await expect(page.getByTestId('live-region')).toContainText('rot.png steht jetzt auf Seite 2 von 3.');
  await rows(page).nth(2).getByRole('button', { name: 'blau.png eine Seite nach vorn' }).click();
  await rows(page).nth(1).getByRole('button', { name: 'blau.png eine Seite nach vorn' }).click();
  await expect(rows(page).nth(0)).toContainText('Seite 1: blau.png');
  await expect(rows(page).nth(1)).toContainText('Seite 2: gruen.png');
  await expect(rows(page).nth(2)).toContainText('Seite 3: rot.png');
  await expect(rows(page).nth(0).getByRole('button', { name: 'blau.png eine Seite nach vorn' })).toBeDisabled();
  await expect(rows(page).nth(2).getByRole('button', { name: 'rot.png eine Seite nach hinten' })).toBeDisabled();

  await page.getByRole('radio', { name: 'US Letter', exact: true }).check();
  await page.getByRole('radio', { name: 'Querformat', exact: true }).check();
  await page.getByRole('radio', { name: 'Mittel (20 mm)', exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath('image-pdf-selected.png'), fullPage: true });
  expect(requests).toHaveLength(0);

  await create(page).click();
  const result = page.getByTestId('pdf-job').getByRole('group', { name: 'Ergebnis', exact: true });
  await expect(result).toContainText('US Letter · Querformat · Mittel (20 mm)');
  await expect(result).toContainText('3');
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveAttribute('href', '/api/v1/jobs/pdf-job/results/result');
  await page.screenshot({ path: testInfo.outputPath('image-pdf-result.png'), fullPage: true });

  expect(requests).toHaveLength(1);
  expect(optionsOf(requests[0]!)).toEqual({ tool: 'image-pdf', pageSize: 'letter', orientation: 'landscape', margin: 'medium' });
  const body = requests[0]!.postDataBuffer()!;
  expect(body.toString('latin1')).toContain('filename="bilder.zip"');
  expect(body.toString('latin1')).not.toContain('rot.png');
  // Gestapelte Einträge 001, 002, 003 enthalten blau, gruen, rot in dieser Reihenfolge.
  const at = (image: { buffer: Buffer }) => body.indexOf(image.buffer);
  expect(at(blue)).toBeGreaterThan(0);
  expect(at(blue)).toBeLessThan(at(green));
  expect(at(green)).toBeLessThan(at(red));
  for (const name of ['001.png', '002.png', '003.png']) expect(body.includes(Buffer.from(name))).toBe(true);
});

test('Bildgröße sperrt die Ausrichtung und sendet automatisch', async ({ page }) => {
  const requests = await mockApi(page, { pages: 1 });
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeEnabled();
  await page.getByRole('radio', { name: 'Querformat', exact: true }).check();
  await page.getByRole('radio', { name: /^Bildgröße/ }).check();
  await expect(page.getByRole('radio', { name: 'Querformat', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Automatisch je Bild', exact: true })).toBeChecked();
  await page.locator('input[type=file]').setInputFiles(red);
  await create(page).click();
  await expect(page.getByTestId('pdf-job').getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('Bildgröße · Klein (10 mm)');
  expect(optionsOf(requests[0]!)).toEqual({ tool: 'image-pdf', pageSize: 'fit', orientation: 'auto', margin: 'small' });
});

test('nicht verwendbare Dateien blockieren den Start, bis sie entfernt sind', async ({ page }) => {
  const requests = await mockApi(page, { pages: 1 });
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles([red, { name: 'notiz.png', mimeType: 'image/png', buffer: Buffer.from('kein Bild') }]);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText('Nicht verwendbar');
  await expect(rows(page).nth(1)).toContainText('kein unterstütztes Bild');
  await expect(create(page)).toBeDisabled();
  await expect(page.getByText('Entfernen Sie die nicht verwendbaren Bilder')).toBeVisible();
  await rows(page).nth(1).getByRole('button', { name: 'Bild notiz.png entfernen' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(create(page)).toBeEnabled();
  await create(page).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('mehr als 30 Bilder werden nicht still gekürzt', async ({ page }) => {
  await mockApi(page);
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeEnabled();
  const files = Array.from({ length: 32 }, (_, i) => ({ name: `bild-${i}.png`, mimeType: 'image/png', buffer: png(i, 0, 0) }));
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(rows(page)).toHaveCount(30);
  await expect(page.getByRole('alert').filter({ hasText: '2 Bilder wurden nicht übernommen' })).toBeVisible();
});

test('Änderungen nach dem Ergebnis verwerfen die PDF; Serverfehler werden erklärt', async ({ page }) => {
  await mockApi(page, { pages: 2 });
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles([red, green]);
  await create(page).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  await rows(page).nth(0).getByRole('button', { name: 'rot.png eine Seite nach hinten' }).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(0);
  await expect(page.getByText('Noch keine PDF erstellt.')).toBeVisible();
});

test('ein fehlgeschlagener Auftrag zeigt eine verständliche Meldung', async ({ page }) => {
  await mockApi(page, {
    jobOverride: { state: 'failed', error: { code: 'dimensions-too-large' }, results: [{ id: 'result', level: null, state: 'failed', size: null, mime: 'application/pdf',
      downloadName: 'bilder.pdf', downloadUrl: null, details: null, error: { code: 'dimensions-too-large' } }] },
  });
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(red);
  await create(page).click();
  await expect(page.getByTestId('pdf-job').getByRole('alert')).toContainText('Megapixel');
});

test('ohne Serverfunktion bleibt der Start gesperrt', async ({ page }) => {
  await mockApi(page, { available: false });
  await page.goto('/pdf/aus-bildern');
  await expect(page.getByText('Bild zu PDF ist derzeit nicht verfügbar.').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bilder auswählen', exact: true })).toBeDisabled();
  await expect(create(page)).toBeDisabled();
});
