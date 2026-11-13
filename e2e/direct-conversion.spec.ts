import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const png = (name = 'bild.png') => ({ name, mimeType: 'image/png', buffer: PNG });
const wav = (name = 'ton.wav') => {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF'); buffer.writeUInt32LE(40, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(4, 40);
  return { name, mimeType: 'audio/wav', buffer };
};
const capabilities = {
  tools: ['image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert'],
  image: { inputFormats: ['png'], outputFormats: ['png', 'webp'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
  pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 2, maxBatchFiles: 30 },
  audio: { inputFormats: ['wav'], outputFormats: ['mp3', 'wav', 'flac', 'ogg'], qualityFormats: ['mp3', 'ogg'], defaultQuality: 0.8, maxFileBytes: 104857600, maxDurationSeconds: 1800, maxChannels: 8, maxSampleRate: 192000, maxOutputBytes: 419430400 },
};
async function open(page: Page, failCapabilities = false) {
  const uploads: string[] = [];
  await page.route('**/api/v1/capabilities', route => route.fulfill(failCapabilities ? { status: 503 } : { json: capabilities }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'test' } }));
  await page.route('**/api/v1/jobs', route => {
    const body = route.request().postData()!;
    uploads.push(body);
    if (body.includes('kaputt.png')) return route.fulfill({ status: 422, json: { error: { code: 'decode-failed' } } });
    const format = body.match(/"format":"([^"]+)"/)![1];
    return route.fulfill({ json: { id: `job-${uploads.length}`, state: 'succeeded', expiresAt: new Date(Date.now() + 3600000).toISOString(), results: [{ downloadUrl: `/api/v1/jobs/job-${uploads.length}/result`, size: 12, mime: `audio/${format}`, details: { format } }] } });
  });
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ status: 204 }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  return uploads;
}
const choose = (page: Page, files: Parameters<ReturnType<Page['locator']>['setInputFiles']>[0]) => page.locator('input[type=file]').setInputFiles(files);

test('direct queue sends per-file audio outputs, preserves append/remove, skips completed files', async ({ page }) => {
  const uploads = await open(page);
  await choose(page, [wav('gleich.wav'), wav('gleich.wav')]);
  const rows = page.locator('.file-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByLabel('Ausgabe').selectOption('mp3');
  await rows.nth(1).getByLabel('Ausgabe').selectOption('flac');
  await choose(page, wav('entfernen.wav'));
  await rows.nth(2).getByRole('button', { name: /entfernen/i }).click();
  await expect(rows.nth(0).getByLabel('Ausgabe')).toHaveValue('mp3');
  await expect(rows.nth(1).getByLabel('Ausgabe')).toHaveValue('flac');
  expect(uploads).toEqual([]);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(rows.nth(0).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'gleich.mp3');
  await expect(rows.nth(1).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'gleich.flac');
  expect(uploads).toHaveLength(2);
  expect(uploads[0]).toContain('"format":"mp3"');
  expect(uploads[1]).toContain('"format":"flac"');
  await choose(page, png());
  await rows.nth(2).getByLabel('Ausgabe').selectOption('png');
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(rows.nth(2).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'bild-konvertiert.png');
  expect(uploads).toHaveLength(3);
  expect(uploads[2]).toContain('"tool":"image-convert"');
  expect(uploads[2]).toContain('"format":"png"');
});

test('mixed PDF and unknown remain visible without blocking valid image or losing queue in secondary tool', async ({ page }) => {
  const uploads = await open(page);
  await choose(page, [png(), { name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('unknown') }, { name: 'heft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') }]);
  const rows = page.locator('.file-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('nicht unterstützt');
  await expect(rows.nth(2).getByRole('button', { name: 'PDF komprimieren' })).toBeVisible();
  await rows.nth(0).getByLabel('Ausgabe').selectOption('png');
  expect(uploads).toEqual([]);
  await rows.nth(2).getByRole('button', { name: 'PDF komprimieren' }).click();
  await expect(page.getByText('Ausgewählte PDF')).toBeVisible();
  await page.getByRole('button', { name: '← Zur Dateiliste' }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByLabel('Ausgabe')).toHaveValue('png');
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(rows.nth(0).getByRole('link', { name: /Download/ })).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('capability failure leaves files visible and start unavailable', async ({ page }) => {
  const uploads = await open(page, true);
  await choose(page, [png(), wav()]);
  await expect(page.locator('.file-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeDisabled();
  await expect(page.getByRole('main')).toContainText('nicht verfügbar');
  expect(uploads).toEqual([]);
});

test('different image outputs reach jobs and one server failure preserves other downloads', async ({ page }) => {
  const uploads = await open(page);
  await choose(page, [png('eins.png'), png('zwei.png'), png('kaputt.png')]);
  const rows = page.locator('.file-row');
  await rows.nth(0).getByLabel('Ausgabe').selectOption('webp');
  await rows.nth(1).getByLabel('Ausgabe').selectOption('png');
  expect(uploads).toEqual([]);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(rows.nth(0).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'eins.webp');
  await expect(rows.nth(1).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'zwei-konvertiert.png');
  await expect(rows.nth(2)).toContainText('Fehlgeschlagen');
  expect(uploads).toHaveLength(3);
  expect(uploads[0]).toContain('"format":"webp"');
  expect(uploads[1]).toContain('"format":"png"');
});

test('duplicate names receive unique downloads and removing last row restores picker', async ({ page }) => {
  const uploads = await open(page);
  await choose(page, [wav(), wav()]);
  const rows = page.locator('.file-row');
  await rows.nth(0).getByLabel('Ausgabe').selectOption('mp3');
  await rows.nth(1).getByLabel('Ausgabe').selectOption('mp3');
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(rows.nth(0).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'ton.mp3');
  await expect(rows.nth(1).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'ton-2.mp3');
  expect(uploads).toHaveLength(2);
  await rows.nth(1).getByRole('button', { name: /entfernen/i }).click();
  await rows.nth(0).getByRole('button', { name: /entfernen/i }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
});

test('checking rows survive delayed capabilities, removal stays removed and real limits apply', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const uploads: string[] = [];
  await page.route('**/api/v1/capabilities', async route => {
    await pending;
    await route.fulfill({ json: { ...capabilities, jobs: { ...capabilities.jobs, maxBatchFiles: 1 }, image: { ...capabilities.image, maxFileBytes: 1 } } });
  });
  await page.route('**/api/v1/jobs', route => { uploads.push(route.request().postData()!); return route.fulfill({ status: 500 }); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  await choose(page, [png(), wav('entfernen.wav'), { name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('text') }]);
  const rows = page.locator('.file-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Wird geprüft');
  await rows.nth(1).getByRole('button', { name: /entfernen/i }).click();
  release();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Nicht verarbeitbar');
  await expect(rows.nth(1)).toContainText('Stapelgrenze von 1 Dateien');
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeDisabled();
  expect(uploads).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`queue fits ${width}px with long names`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await open(page);
    await choose(page, [png(`${'lang'.repeat(30)}.png`), wav(), { name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('text') }]);
    await expect(page.locator('.file-row').nth(0).getByLabel('Ausgabe')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const screenshot = testInfo.outputPath(`queue-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`queue-${width}`, { path: screenshot, contentType: 'image/png' });
  });
}
