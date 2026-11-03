import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import type { Job, JobResult } from '../src/lib/api/client';
import AxeBuilder from '@axe-core/playwright';

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

function variant(level: 'high' | 'balanced' | 'small', state: JobResult['state'], changes: Partial<JobResult> = {}): JobResult {
  return { id: level, level, state, mime: 'application/pdf', size: null, error: null, details: null,
    downloadName: `beispiel-${level}.pdf`, downloadUrl: null, ...changes };
}

function job(state: Job['state'], results: JobResult[], changes: Partial<Job> = {}): Job {
  return { id: 'pdf-workspace', tool: 'pdf-compress', state, phase: state === 'running' ? 'variant' : null,
    cancelRequested: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), error: null,
    input: { name: 'beispiel.pdf', format: 'pdf', size: 20000, width: null, height: null },
    analysis: { fileSize: 20000, pdfVersion: '1.7', pageCount: 2, encrypted: false,
      images: { total: 3, recompressible: 2, skipped: { mask: 1 }, byFilter: { dct: 3, flate: 0, none: 0, other: 0 }, bytes: 15000, recompressibleBytes: 10000, maskCount: 0 },
      fontBytes: 0, limitations: [{ code: 'signatures-invalidated', count: 1 }] },
    progress: state === 'running' ? { current: 1, total: 2 } : null, results, ...changes };
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

test('laufende PDF zeigt Analyse und fertige Varianten, Teilfehler bleiben der Variante zugeordnet', async ({ page }) => {
  await prepare(page);
  await select(page);
  const finishedHigh = variant('high', 'succeeded', { size: 10000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/high' });
  let current = job('running', [finishedHigh, variant('balanced', 'running'), variant('small', 'pending')]);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: current }));
  await page.route('**/api/v1/jobs/pdf-workspace', route => route.fulfill({ json: current }));
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  const results = page.getByRole('region', { name: '4. Dateien und Ergebnisse', exact: true });
  await expect(results.getByRole('heading', { name: 'Analyse', level: 3, exact: true })).toBeVisible();
  await expect(results).toContainText('Digitale Signaturen');
  await expect(results).toContainText('Bilder verarbeitet: 1 von 2');
  const high = results.getByRole('region', { name: 'Hohe Qualität', exact: true });
  const balanced = results.getByRole('region', { name: 'Ausgewogen', exact: true });
  const small = results.getByRole('region', { name: 'Kleine Datei', exact: true });
  await expect(high.getByRole('link', { name: 'Hohe Qualität herunterladen', exact: true })).toBeVisible();
  await expect(balanced).toContainText('Wird verarbeitet');
  await expect(small).toContainText('Wartet auf Berechnung');
  current = job('partially_succeeded', [finishedHigh,
    variant('balanced', 'succeeded', { size: 22000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/balanced' }),
    variant('small', 'failed', { error: { code: 'memory-limit' } }),
  ]);
  await expect(small).toContainText('Variante fehlgeschlagen');
  await expect(small).toContainText('Arbeitsspeicher');
  await expect(small.getByRole('link')).toHaveCount(0);
  await expect(high).toContainText('Kleiner als das Original');
  await expect(balanced).toContainText('Größer als das Original');
  await expect(balanced.locator('dt', { hasText: 'Originalgröße' })).toBeVisible();
  await expect(balanced.locator('dt', { hasText: 'Ergebnisgröße' })).toBeVisible();
  await expect(results.getByRole('link')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Komprimieren', exact: true })).toBeEnabled();
});

test('Abbrechen bewahrt fertige Downloads und beendet wartende Varianten', async ({ page }) => {
  await prepare(page);
  await select(page);
  const finishedHigh = variant('high', 'succeeded', { size: 10000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/high' });
  let current = job('running', [finishedHigh, variant('balanced', 'running'), variant('small', 'pending')]);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: current }));
  await page.route('**/api/v1/jobs/pdf-workspace', route => route.fulfill({ json: current }));
  await page.route('**/api/v1/jobs/pdf-workspace/cancel', route => {
    current = job('cancelled', [finishedHigh, variant('balanced', 'cancelled'), variant('small', 'cancelled')], { cancelRequested: true });
    return route.fulfill({ status: 204 });
  });
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  const cancellation = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/pdf-workspace/cancel'));
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await cancellation;
  await expect(page.getByRole('button', { name: 'Komprimieren', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Ausgewogen', exact: true })).toContainText('Abgebrochen');
  await expect(page.getByRole('region', { name: 'Kleine Datei', exact: true })).toContainText('Abgebrochen');
  await expect(page.getByRole('link', { name: 'Hohe Qualität herunterladen', exact: true })).toBeVisible();
  await expect(page.locator('a[download]')).toHaveCount(1);
});

test('Reset löscht den Auftrag und lässt eine verspätete Pollantwort nicht wieder erscheinen', async ({ page }) => {
  await prepare(page);
  await select(page);
  const running = job('running', [variant('high', 'running'), variant('balanced', 'pending'), variant('small', 'pending')]);
  let resume!: () => void;
  const responseGate = new Promise<void>(resolve => { resume = resolve; });
  let polling = false, answered = false;
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: running }));
  await page.route('**/api/v1/jobs/pdf-workspace', async route => {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
    polling = true;
    await responseGate;
    await route.fulfill({ json: job('succeeded', [variant('high', 'succeeded', { size: 10000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/high' })]) });
    answered = true;
  });
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  await expect.poll(() => polling).toBe(true);
  const deletion = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith('/pdf-workspace'));
  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
  await deletion;
  resume();
  await expect.poll(() => answered).toBe(true);
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeFocused();
  await expect(page.locator('a[download]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Analyse', level: 3, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Komprimieren', exact: true })).toBeDisabled();
});

test('Ablauf wird angekündigt, entfernt alle Downloads und erlaubt einen neuen Start', async ({ page }) => {
  await page.clock.install();
  await prepare(page);
  await select(page);
  const finished = job('succeeded', [
    variant('high', 'succeeded', { size: 20000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/high' }),
    variant('balanced', 'succeeded', { size: 22000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/balanced' }),
    variant('small', 'succeeded', { size: 10000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/small' }),
  ]);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: finished }));
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  await expect(page.locator('a[download]')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'Hohe Qualität', exact: true })).toContainText('Keine Einsparung');
  await page.clock.fastForward(61000);
  await expect(page.getByRole('status').filter({ hasText: 'Auftrag abgelaufen' })).toBeVisible();
  for (const label of ['Hohe Qualität', 'Ausgewogen', 'Kleine Datei']) {
    await expect(page.getByRole('region', { name: label, exact: true })).toContainText('Abgelaufen');
  }
  await expect(page.locator('a[download]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Komprimieren', exact: true })).toBeEnabled();
});

test('leere, fertige und verschlüsselt abgelehnte PDF-Zustände haben keine Axe-Verstöße', async ({ page }) => {
  await prepare(page);
  const violations = async () => (await new AxeBuilder({ page }).include('main').analyze()).violations;
  expect(await violations()).toEqual([]);
  await select(page);
  let current = job('succeeded', [
    variant('high', 'succeeded', { size: 20000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/high' }),
    variant('balanced', 'succeeded', { size: 20000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/balanced' }),
    variant('small', 'succeeded', { size: 20000, downloadUrl: '/api/v1/jobs/pdf-workspace/results/small' }),
  ], { analysis: { pageCount: 1, images: { total: 0, recompressible: 0 } } });
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: current }));
  await page.route('**/api/v1/jobs/pdf-workspace', route => route.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  await expect(page.locator('a[download]')).toHaveCount(3);
  await expect(page.getByText('Keine neu kodierbaren Bilder gefunden.', { exact: false })).toBeVisible();
  expect(await violations()).toEqual([]);
  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
  await select(page);
  current = job('failed', [], { analysis: null, error: { code: 'encrypted' } });
  await page.getByRole('button', { name: 'Komprimieren', exact: true }).click();
  await expect(page.locator('p.notice-error')).toContainText('Verschlüsselte PDFs');
  await expect(page.locator('a[download]')).toHaveCount(0);
  expect(await violations()).toEqual([]);
});
