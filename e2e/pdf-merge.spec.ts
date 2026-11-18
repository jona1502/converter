import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from '@cantoo/pdf-lib';

// Die API-Doubles belegen Auswahl, Reihenfolge und gesendete Teile, nicht die echte Zusammenführung;
// der letzte Test läuft nur gegen den echten Stack (E2E_BASE_URL).

const MERGE = { available: true, minFiles: 2, maxFiles: 20, maxTotalBytes: 100_000_000, maxOutputBytes: 100_000_000, maxPages: 2000 };

function pdf(label: string) { return { name: `${label}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.7\n% ${label}\n`) }; }

function job(sources: number) {
  const now = new Date().toISOString();
  return {
    id: 'merge-job', tool: 'pdf-merge', state: 'succeeded', phase: null, progress: null, analysis: null, error: null, cancelRequested: false,
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(),
    input: { name: 'a.pdf', format: 'pdf', size: 10, width: null, height: null },
    results: [{ id: 'result', level: null, state: 'succeeded', size: 2400, mime: 'application/pdf', downloadName: 'zusammengefuehrt.pdf',
      downloadUrl: '/api/v1/jobs/merge-job/results/result', details: { pageCount: sources * 2, sourceCount: sources }, error: null }],
  };
}

function uploadedNames(request: Request): string[] {
  const body = request.postDataBuffer()!.toString('latin1');
  return [...body.matchAll(/name="file"; filename="([^"]*)"/g)].map(match => match[1]!);
}
function optionsOf(request: Request): unknown {
  return JSON.parse(/name="options"\r\n\r\n(.*?)\r\n/s.exec(request.postDataBuffer()!.toString('latin1'))![1]!);
}

async function mockServer(page: Page, handler?: (request: Request) => { status: number; json: unknown }) {
  const creates: Request[] = [];
  const deletes: string[] = [];
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    tools: ['pdf-merge'], pdfMerge: MERGE,
    image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 1, maxPixels: 1, maxEdge: 1 },
    pdf: { maxFileBytes: 1 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'merge-test' } }));
  await page.route('**/api/v1/jobs/*', route => {
    if (route.request().method() === 'DELETE') { deletes.push(route.request().url()); return route.fulfill({ status: 204 }); }
    return route.fulfill({ json: job(2) });
  });
  await page.route('**/api/v1/jobs', route => {
    creates.push(route.request());
    const reply = handler?.(route.request()) ?? { status: 202, json: job(uploadedNames(route.request()).length) };
    return route.fulfill({ status: reply.status, json: reply.json });
  });
  await page.goto('/pdf/zusammenfuehren');
  await expect(page.getByRole('heading', { name: 'PDF zusammenführen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PDF-Dateien auswählen', exact: true })).toBeEnabled();
  return { creates, deletes };
}

const rowNames = (page: Page) => page.locator('.file-row .file-name').allInnerTexts();
const action = (page: Page) => page.getByRole('button', { name: 'PDFs zusammenführen', exact: true });

test('Auswahl und Sortierung bleiben lokal; der Start sendet die Dateien in Listenreihenfolge', async ({ page }, testInfo) => {
  const { creates } = await mockServer(page);
  await page.locator('input[type=file]').setInputFiles([pdf('a'), pdf('b'), pdf('c')]);
  await expect(page.locator('.file-row[data-status="ready"]')).toHaveCount(3);
  await expect(action(page)).toBeEnabled();
  expect(await rowNames(page)).toEqual(['1. a.pdf', '2. b.pdf', '3. c.pdf']);

  await page.getByRole('button', { name: /^a\.pdf nach unten verschieben/ }).click();
  await expect(page.getByRole('button', { name: /^a\.pdf nach unten verschieben, derzeit Position 2 von 3/ })).toBeFocused();
  await page.getByRole('button', { name: /^c\.pdf nach oben verschieben/ }).click();
  expect(await rowNames(page)).toEqual(['1. b.pdf', '2. c.pdf', '3. a.pdf']);
  await expect(page.getByTestId('live-region')).toContainText('c.pdf steht jetzt an Position 2 von 3.');
  expect(creates).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('merge-selected.png'), fullPage: true });

  await action(page).click();
  const link = page.getByTestId('merge-result').getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('download', 'zusammengefuehrt.pdf');
  expect(creates).toHaveLength(1);
  expect(uploadedNames(creates[0]!)).toEqual(['b.pdf', 'c.pdf', 'a.pdf']);
  expect(optionsOf(creates[0]!)).toEqual({ tool: 'pdf-merge' });
  const result = page.getByTestId('merge-result').getByRole('group', { name: 'Ergebnis', exact: true });
  await expect(result).toContainText('Quelldateien');
  await expect(result).toContainText('6');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('Eine Änderung der Liste verwirft das Ergebnis und löscht den Auftrag', async ({ page }) => {
  const { deletes } = await mockServer(page);
  await page.locator('input[type=file]').setInputFiles([pdf('a'), pdf('b')]);
  await action(page).click();
  await expect(page.getByTestId('merge-result')).toBeVisible();
  await page.getByRole('button', { name: /^b\.pdf nach oben verschieben/ }).click();
  await expect(page.getByTestId('merge-result')).toHaveCount(0);
  await expect.poll(() => deletes.length).toBe(1);
  await expect(action(page)).toBeEnabled();
});

test('Ohne zwei gültige PDFs bleibt der Start gesperrt und es wird nichts hochgeladen', async ({ page }) => {
  const { creates } = await mockServer(page);
  await page.locator('input[type=file]').setInputFiles([pdf('einzeln')]);
  await expect(action(page)).toBeDisabled();
  await expect(page.getByText('Wählen Sie mindestens 2 PDF-Dateien aus.')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'bild.pdf', mimeType: 'application/pdf', buffer: Buffer.from('GIF89a nope') });
  await expect(page.locator('.file-row[data-status="invalid"] .field-error')).toContainText('keine erkennbare PDF');
  await expect(action(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Datei bild.pdf entfernen' }).click();
  await page.locator('input[type=file]').setInputFiles([pdf('zwei')]);
  await expect(action(page)).toBeEnabled();
  expect(creates).toHaveLength(0);
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'PDF-Dateien auswählen', exact: true })).toBeFocused();
});

test('Mehr als zwanzig Dateien werden abgewiesen', async ({ page }) => {
  await mockServer(page);
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: 21 }, (_, index) => pdf(`datei-${index + 1}`)));
  await expect(page.locator('.file-row')).toHaveCount(20);
  await expect(page.getByRole('alert').filter({ hasText: 'höchstens 20' })).toContainText('1 Datei wurde nicht hinzugefügt');
});

test('Verschlüsselte PDFs führen zu einer verständlichen Fehlermeldung ohne Download', async ({ page }) => {
  await mockServer(page, () => ({ status: 422, json: { error: { code: 'encrypted', message: 'x' }, requestId: 'r' } }));
  await page.locator('input[type=file]').setInputFiles([pdf('a'), pdf('b')]);
  await action(page).click();
  await expect(page.getByRole('alert').filter({ hasText: 'verschlüsselt' })).toBeVisible();
  await expect(page.locator('a[download]')).toHaveCount(0);
  await expect(action(page)).toBeEnabled();
});

test('Ist die Funktion auf dem Server nicht verfügbar, bleibt die Auswahl gesperrt', async ({ page }) => {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    tools: ['pdf-compress'], image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 1, maxPixels: 1, maxEdge: 1 },
    pdf: { maxFileBytes: 1 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.goto('/pdf/zusammenfuehren');
  await expect(page.getByRole('alert')).toContainText('Verarbeitungsserver');
  await expect(page.getByRole('button', { name: 'PDF-Dateien auswählen', exact: true })).toBeDisabled();
});

test('Echter Server: zwei PDFs werden in der gewählten Reihenfolge zusammengeführt', async ({ page }) => {
  test.skip(!process.env.E2E_BASE_URL, 'braucht den Compose-Stack (E2E_BASE_URL)');
  test.setTimeout(120_000);
  const make = async (pages: number) => Buffer.from(await (async () => {
    const doc = await PDFDocument.create();
    for (let index = 0; index < pages; index++) doc.addPage([200, 200]);
    return doc.save();
  })());
  await page.goto('/pdf/zusammenfuehren');
  await expect(page.getByRole('button', { name: 'PDF-Dateien auswählen', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'drei.pdf', mimeType: 'application/pdf', buffer: await make(3) },
    { name: 'zwei.pdf', mimeType: 'application/pdf', buffer: await make(2) },
  ]);
  await action(page).click();
  const link = page.getByTestId('merge-result').getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible({ timeout: 90_000 });
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('zusammengefuehrt.pdf');
  const merged = await PDFDocument.load(await readFile((await download.path())!));
  expect(merged.getPageCount()).toBe(5);
  await expect(page.getByTestId('merge-result')).toContainText('5');
});
