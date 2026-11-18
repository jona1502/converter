import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import type { Job, JobResult } from '../src/lib/api/client';

// API-Fixtures prüfen die Oberfläche; die echte Aufteilung prüfen die Python- und Go-Tests.
const CAPABILITIES = {
  image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
  pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  tools: ['pdf-split'],
  pdfSplit: { available: true, maxFileBytes: 100000000, maxOutputBytes: 300000000, maxParts: 500 },
};

async function pdf(pages: number, encrypt = false) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  if (encrypt) doc.encrypt({ userPassword: 'u', ownerPassword: 'o', permissions: {} });
  return Buffer.from(await doc.save());
}

function result(changes: Partial<JobResult>): JobResult {
  return { id: 'r1', level: null, state: 'succeeded', mime: 'application/pdf', size: 1234, error: null,
    details: { pageCount: 5, partCount: 1 }, downloadName: 'bericht-seiten-2-3.pdf', downloadUrl: '/api/v1/jobs/split/results/r1', ...changes };
}

function job(changes: Partial<Job> = {}, results: JobResult[] = [result({})]): Job {
  return { id: 'split', tool: 'pdf-split', state: 'succeeded', phase: null, cancelRequested: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    error: null, input: { name: 'bericht.pdf', format: 'pdf', size: 3000, width: null, height: null }, analysis: null,
    progress: null, results, ...changes } as Job;
}

async function ready(page: Page, capabilities: unknown = CAPABILITIES) {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: capabilities }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'split-test' } }));
  await page.goto('/pdf/teilen');
  await expect(page.getByRole('heading', { name: 'PDF teilen', level: 1, exact: true })).toBeVisible();
}

async function select(page: Page, pages = 5, name = 'bericht.pdf') {
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles({ name, mimeType: 'application/pdf', buffer: await pdf(pages) });
  await expect(page.getByText(`${pages} Seiten`)).toBeVisible();
}

const start = (page: Page) => page.getByRole('button', { name: 'PDF teilen', exact: true });
const ranges = (page: Page) => page.getByLabel('Seiten', { exact: true });

test('Auswahl bleibt lokal; ausdrücklicher Start sendet genau die Optionen; Ergebnis ist herunterladbar', async ({ page }) => {
  await ready(page);
  const posts: string[] = [];
  await page.route('**/api/v1/jobs', async route => {
    posts.push(route.request().postData() ?? '');
    await route.fulfill({ status: 202, json: job() });
  });
  await page.route('**/api/v1/jobs/split/results/r1', route => route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\n' }));
  await select(page);
  await ranges(page).fill('2-3');
  await expect(start(page)).toBeEnabled();
  expect(posts).toHaveLength(0);
  await start(page).click();
  const link = page.getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('download', 'bericht-seiten-2-3.pdf');
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain('{"tool":"pdf-split","mode":"ranges","ranges":"2-3"}');
  const group = page.getByRole('region', { name: 'Ergebnis', exact: true });
  await expect(group).toContainText('PDF');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('Mehrere Bereiche ergeben ein ZIP, jede Seite einzeln ebenfalls', async ({ page }) => {
  await ready(page);
  const bodies: string[] = [];
  await page.route('**/api/v1/jobs', async route => {
    bodies.push(route.request().postData() ?? '');
    const zip = result({ mime: 'application/zip', downloadName: 'bericht-geteilt.zip', details: { pageCount: 5, partCount: bodies.length === 1 ? 2 : 5 } });
    await route.fulfill({ status: 202, json: job({}, [zip]) });
  });
  await select(page);
  await ranges(page).fill('1-2,4');
  await expect(page.getByText('Bereit: Ergebnis ist ZIP mit 2 PDF-Dateien.')).toBeVisible();
  await start(page).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveAttribute('download', 'bericht-geteilt.zip');
  await expect(page.getByRole('region', { name: 'Ergebnis', exact: true })).toContainText('ZIP mit PDF-Dateien');
  expect(bodies[0]).toContain('"ranges":"1-2,4"');
  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
  await select(page);
  await page.getByLabel('Jede Seite einzeln').check();
  await expect(ranges(page)).toHaveCount(0);
  await start(page).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  expect(bodies[1]).toContain('{"tool":"pdf-split","mode":"each"}');
  expect(bodies[1]).not.toContain('ranges');
});

test('Ungültige Bereiche werden sofort erklärt und verhindern den Start', async ({ page }) => {
  await ready(page);
  let posts = 0;
  await page.route('**/api/v1/jobs', route => { posts++; return route.abort(); });
  await select(page, 5);
  for (const [value, message] of [
    ['1, 2', /Leerzeichen/], ['3-1', /Ende liegt vor dem Anfang/], ['0', /beginnen bei 1/], ['x', /ungültig/],
    ['6', /außerhalb des Dokuments; es hat 5 Seiten/], ['1-3,9-', /Bereich 2 liegt außerhalb/],
  ] as const) {
    await ranges(page).fill(value);
    await expect(page.locator('.field-error')).toContainText(message);
    await expect(ranges(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(start(page)).toBeDisabled();
  }
  await ranges(page).fill(' 1-2 ');
  await expect(page.locator('.field-error')).toHaveCount(0);
  await expect(start(page)).toBeEnabled();
  expect(posts).toBe(0);
});

test('Verschlüsselte oder keine PDF wird lokal abgelehnt, ohne Upload', async ({ page }) => {
  await ready(page);
  let posts = 0;
  await page.route('**/api/v1/jobs', route => { posts++; return route.abort(); });
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles({ name: 'geheim.pdf', mimeType: 'application/pdf', buffer: await pdf(2, true) });
  await expect(page.getByRole('alert')).toContainText('Verschlüsselte PDFs werden nicht unterstützt');
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles({ name: 'text.pdf', mimeType: 'application/pdf', buffer: Buffer.from('kein pdf') });
  await expect(page.getByRole('alert')).toContainText('keine erkennbare PDF');
  await expect(start(page)).toBeDisabled();
  expect(posts).toBe(0);
});

test('Serverfehler werden auf Deutsch gemeldet', async ({ page }) => {
  await ready(page);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: job({ state: 'failed', error: { code: 'page-range-invalid' } }, [result({ state: 'failed', downloadUrl: null, size: null })]) }));
  await select(page);
  await ranges(page).fill('1-2');
  await start(page).click();
  await expect(page.getByRole('alert')).toContainText('Seitenbereiche passen nicht zu dieser PDF');
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(0);
});

test('Zurücksetzen löscht den Auftrag auf dem Server', async ({ page }) => {
  await ready(page);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: job() }));
  await select(page);
  await ranges(page).fill('2-3');
  await start(page).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  const deletion = page.waitForRequest(request => request.method() === 'DELETE' && /\/api\/v1\/jobs\/split$/.test(request.url()));
  await page.route('**/api/v1/jobs/split', route => route.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
  await deletion;
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeFocused();
});

test('Ohne Serverunterstützung ist das Werkzeug deaktiviert', async ({ page }) => {
  await ready(page, { ...CAPABILITIES, tools: [], pdfSplit: { ...CAPABILITIES.pdfSplit, available: false } });
  await expect(page.getByRole('alert')).toContainText('derzeit nicht verfügbar');
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeDisabled();
});
