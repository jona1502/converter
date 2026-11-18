import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Echter Server (Compose-Stack, E2E_BASE_URL): echte Verarbeitung durch den isolierten Konverter.

/** Kleine, strikt gültige PDF mit n leeren Seiten (korrekte xref-Offsets). */
function samplePdf(pages: number): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pages }, (_, index) => `${3 + index} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let index = 0; index < pages; index++) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(out)); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const file = (pages: number) => ({ name: 'Scan.pdf', mimeType: 'application/pdf', buffer: samplePdf(pages) });

async function ready(page: Page) {
  await page.goto('/pdf/drehen');
  await expect(page.getByRole('heading', { name: 'PDF drehen', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
}
const start = (page: Page) => page.getByRole('button', { name: 'PDF drehen', exact: true });

test('Echte Verarbeitung: ausgewählte Seiten drehen, herunterladen, entfernen', async ({ page }) => {
  await ready(page);
  const creates: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/jobs')) creates.push(request.url()); });
  await page.locator('input[type=file]').setInputFiles(file(3));
  await page.getByRole('radio', { name: '180°' }).check();
  await page.getByRole('radio', { name: 'Bestimmte Seiten' }).check();
  await page.getByRole('textbox', { name: 'Seitenangabe' }).fill('1,3');
  await expect(start(page)).toBeEnabled();
  expect(creates).toHaveLength(0);
  await start(page).click();
  const row = page.locator('.file-row');
  const link = row.getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible({ timeout: 60_000 });
  await expect(link).toHaveAttribute('download', 'Scan-gedreht.pdf');
  await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('2 von 3');
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('Scan-gedreht.pdf');
  expect((await readFile((await download.path())!)).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  const deletion = page.waitForResponse(response => response.request().method() === 'DELETE' && /\/api\/v1\/jobs\//.test(response.url()));
  await row.getByRole('button', { name: /entfernen/i }).click();
  expect((await deletion).ok()).toBe(true);
  await expect(row).toHaveCount(0);
});

test('Echte Verarbeitung: Seite hinter dem Dokumentende ergibt einen verständlichen Fehler', async ({ page }) => {
  await ready(page);
  await page.locator('input[type=file]').setInputFiles(file(2));
  await page.getByRole('radio', { name: 'Bestimmte Seiten' }).check();
  await page.getByRole('textbox', { name: 'Seitenangabe' }).fill('5');
  await start(page).click();
  await expect(page.locator('.file-row[data-status="error"] .field-error')).toContainText('passen nicht zur PDF', { timeout: 60_000 });
  await expect(page.locator('a[download]')).toHaveCount(0);
});
