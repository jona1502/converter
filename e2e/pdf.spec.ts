import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

async function fixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  page.drawText('Lokale PDF-Testdatei', { font: await doc.embedFont(StandardFonts.Helvetica) });
  return { name: 'test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) };
}

test('PDF analysieren, drei echte Ergebnisse oder Browsergrenze, Reset', async ({ page }) => {
  await page.addInitScript(() => {
    const urls = new Set<string>();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    (window as unknown as { pdfUrls: Set<string> }).pdfUrls = urls;
  });
  await page.goto('/pdf/komprimieren');
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeEnabled();
  await expect(page.getByText('Digitale Signaturen werden durch das Neuschreiben ungültig.', { exact: false })).toBeVisible();
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles(await fixture());
  await expect(page.getByText('Original:', { exact: false })).toBeVisible();
  if (await page.evaluate(() => typeof OffscreenCanvas !== 'undefined')) {
    for (const label of ['Hohe Qualität', 'Ausgewogen', 'Kleine Datei']) {
      await expect(page.getByRole('link', { name: `${label} herunterladen`, exact: true })).toBeVisible({ timeout: 30_000 });
    }
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Ausgewogen herunterladen', exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toBe('test-balanced.pdf');
  } else {
    await expect(page.locator('p.notice-error').filter({ hasText: 'Dieser Browser unterstützt die lokale PDF-Komprimierung nicht vollständig.' })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Zurücksetzen', exact: true }).click();
  await expect(page.getByRole('link', { name: /herunterladen/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pdfUrls: Set<string> }).pdfUrls.size)).toBe(0);
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeFocused();
});

test('beschädigte PDF verständlich ablehnen', async ({ page }) => {
  await page.goto('/pdf/komprimieren');
  await expect(page.getByRole('button', { name: 'PDF auswählen', exact: true })).toBeEnabled();
  await page.getByLabel('PDF-Datei', { exact: true }).setInputFiles({ name: 'kaputt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('keine PDF') });
  await expect(page.locator('p.notice-error').filter({ hasText: 'Die Datei ist keine erkennbare PDF.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Hohe Qualität', exact: true })).toHaveCount(0);
  await expect(page.getByText('Wartet auf Berechnung', { exact: true })).toHaveCount(0);
});
