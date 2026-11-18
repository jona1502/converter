import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

// API-Doubles: „Alle als ZIP speichern“ für Bild- und PDF-Werkzeuge.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const now = () => new Date().toISOString();
const later = () => new Date(Date.now() + 60000).toISOString();

function imageJob(tool: string, id: string, name: string) {
  return {
    id, tool, state: 'succeeded', phase: null, progress: null, analysis: null, error: null, cancelRequested: false,
    createdAt: now(), updatedAt: now(), expiresAt: later(),
    input: { name, format: 'png', size: PNG.length, width: 1, height: 1 },
    results: [{ id: `${id}-r`, level: null, state: 'succeeded', size: 70, mime: 'image/png', downloadName: name,
      downloadUrl: `/api/v1/jobs/${id}/results/${id}-r`, details: { format: 'png', width: 1, height: 1 }, error: null }],
  };
}

async function prepareImages(page: Page, path: string, tool: string) {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    tools: ['image-convert', 'image-compress', 'image-resize'],
    image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
    pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'zip-test' } }));
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ status: 204 }));
  let uploads = 0;
  await page.route('**/api/v1/jobs', route => {
    const index = ++uploads;
    return route.fulfill({ status: 202, json: imageJob(tool, `bild-${index}`, `bild${index}.png`) });
  });
  await page.goto(path);
}

const files = (...names: string[]) => names.map(name => ({ name, mimeType: 'image/png', buffer: PNG }));

for (const [path, tool, action] of [
  ['/bilder/konvertieren', 'image-convert', 'Konvertieren'],
  ['/bilder/komprimieren', 'image-compress', 'Komprimieren'],
  ['/bilder/skalieren', 'image-resize', 'Skalieren'],
] as const) {
  test(`${tool}: ZIP-Link erst ab zwei fertigen Bildern`, async ({ page }) => {
    await prepareImages(page, path, tool);
    const zip = page.getByRole('link', { name: 'Alle als ZIP speichern' });
    const input = page.locator('input[type=file]');
    await input.setInputFiles(files('a.png'));
    await expect(page.locator('.file-row').first()).toBeVisible();
    const run = page.getByRole('button', { name: action, exact: true });
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page.locator('.file-row').getByRole('link', { name: /Herunterladen/ })).toBeVisible();
    await expect(zip).toHaveCount(0);
    await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
    await input.setInputFiles(files('b.png', 'c.png'));
    await expect(run).toBeEnabled();
    await run.click();
    await expect(zip).toBeVisible();
    expect(await zip.getAttribute('href')).toMatch(/^\/api\/v1\/jobs\/archive\?job_id=bild-\d&job_id=bild-\d$/);
    expect(await zip.getAttribute('download')).toBe('ergebnisse.zip');
  });
}

test('PDF-Komprimierung: ZIP-Link mit allen Varianten eines Auftrags', async ({ page }) => {
  const variant = (level: string) => ({ id: level, level, state: 'succeeded', mime: 'application/pdf', size: 1000, error: null, details: null,
    downloadName: `beispiel-${level}.pdf`, downloadUrl: `/api/v1/jobs/pdf-zip/results/${level}` });
  const job = { id: 'pdf-zip', tool: 'pdf-compress', state: 'succeeded', phase: null, cancelRequested: false, createdAt: now(), updatedAt: now(),
    expiresAt: later(), error: null, progress: null, input: { name: 'beispiel.pdf', format: 'pdf', size: 20000, width: null, height: null },
    analysis: { fileSize: 20000, pdfVersion: '1.7', pageCount: 2, encrypted: false }, results: ['high', 'balanced', 'small'].map(variant) };
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
    pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'zip-test' } }));
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: job }));
  await page.goto('/pdf/komprimieren');
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles({ name: 'beispiel.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20000, 'x') });
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  const zip = page.getByRole('link', { name: 'Alle als ZIP speichern' });
  await expect(zip).toBeVisible();
  expect(await zip.getAttribute('href')).toBe('/api/v1/jobs/archive?job_id=pdf-zip');
});
