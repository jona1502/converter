import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function ready(page: Page) {
  await page.goto('/pdf/markdown');
  await expect(page.getByRole('heading', { name: 'Markdown zu PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
}
const markdown = { name: 'dokument.md', mimeType: 'text/markdown', buffer: Buffer.from('\ufeff# Grüße\n\nText mit **Gewicht**.\n\n| Kopf | Wert |\n| --- | --- |\n| Äpfel | 3 |\n\n![Bildbeschreibung](https://example.invalid/bild.png)') };

test('Auswahl bleibt lokal; ausdrücklicher Start erstellt PDF; Entfernen löscht Auftrag', async ({ page }, testInfo) => {
  await ready(page);
  const creates: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/jobs')) creates.push(request.url()); });
  const action = page.getByRole('button', { name: 'PDF erstellen', exact: true });
  await page.locator('input[type=file]').setInputFiles(markdown);
  await expect(action).toBeEnabled();
  expect(creates).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('markdown-selected.png'), fullPage: true });
  await action.click();
  const row = page.locator('.file-row');
  const link = row.getByRole('link', { name: /Herunterladen/ });
  await expect(link).toBeVisible({ timeout: 60_000 });
  await expect(link).toHaveAttribute('download', 'dokument.pdf');
  expect(creates).toHaveLength(1);
  await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('PDF');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('markdown-result.png'), fullPage: true });
  const downloadEvent = page.waitForEvent('download');
  await link.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('dokument.pdf');
  expect((await readFile((await download.path())!)).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  const deletion = page.waitForResponse(response => response.request().method() === 'DELETE' && /\/api\/v1\/jobs\//.test(response.url()));
  await row.getByRole('button', { name: /entfernen/i }).click();
  expect((await deletion).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
});

test('Ungültige und zu große Quellen zeigen Fehler ohne Upload; Reset entfernt sie', async ({ page }) => {
  await ready(page);
  const creates: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/jobs')) creates.push(request.url()); });
  await page.locator('input[type=file]').setInputFiles({ name: 'leer.md', mimeType: 'text/markdown', buffer: Buffer.from(' \t\n') });
  await expect(page.locator('.field-error')).toContainText('UTF-8');
  await expect(page.getByRole('button', { name: 'PDF erstellen', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'groß.md', mimeType: 'text/markdown', buffer: Buffer.alloc(2097153, 65) });
  await expect(page.locator('.field-error')).toContainText('Eingabe');
  expect(creates).toHaveLength(0);
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
});

test('Verarbeitungsfehler bleibt verständlich und ohne Download', async ({ page }) => {
  test.setTimeout(150_000);
  await ready(page);
  // Echte Verarbeitung: deutlich mehr als die erlaubten 300 A4-Seiten.
  await page.locator('input[type=file]').setInputFiles({ name: 'seiten.md', mimeType: 'text/markdown', buffer: Buffer.from(('# Überschrift\n\nText\n\n').repeat(12000)) });
  await page.getByRole('button', { name: 'PDF erstellen', exact: true }).click();
  await expect(page.locator('.file-row[data-status="error"] .field-error')).toContainText('Seiten', { timeout: 120_000 });
  await expect(page.locator('a[download]')).toHaveCount(0);
});

test('Entfernen während des Pollings bricht ab und löscht den bekannten Auftrag', async ({ page }) => {
  await ready(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let polling!: () => void;
  const seen = new Promise<void>(resolve => { polling = resolve; });
  await page.route('**/api/v1/jobs/*', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    polling();
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await page.locator('input[type=file]').setInputFiles(markdown);
    await page.getByRole('button', { name: 'PDF erstellen', exact: true }).click();
    await seen;
    const deletion = page.waitForResponse(response => response.request().method() === 'DELETE' && /\/api\/v1\/jobs\//.test(response.url()));
    await page.locator('.file-row').getByRole('button', { name: /entfernen/i }).click();
    expect((await deletion).ok()).toBe(true);
    release();
    await expect(page.locator('.file-row')).toHaveCount(0);
    await expect(page.locator('a[download]')).toHaveCount(0);
    await page.locator('input[type=file]').setInputFiles(markdown);
    await expect(page.getByRole('button', { name: 'PDF erstellen', exact: true })).toBeEnabled();
  } finally { release(); }
});

test('Fehlende Markdown-Verfügbarkeit sperrt Auswahl und Start', async ({ page }) => {
  await page.route('**/api/v1/capabilities', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.markdown.available = false;
    body.tools = body.tools.filter((tool: string) => tool !== 'markdown-pdf');
    await route.fulfill({ response, json: body });
  });
  await page.goto('/pdf/markdown');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'PDF erstellen', exact: true })).toBeDisabled();
});

test('Startseite erkennt Markdown und öffnet nur sein Werkzeug ohne Upload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles(markdown);
  await page.getByRole('button', { name: 'PDF erstellen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Markdown zu PDF', exact: true })).toBeVisible();
  await expect(page.locator('.file-row')).toContainText('dokument.md');
  await expect(page.getByRole('button', { name: 'PDF erstellen', exact: true })).toBeEnabled();
});

test('Unicode-Dateistamm bleibt in Ergebnis und Downloadattribut erhalten', async ({ page }) => {
  await ready(page);
  await page.locator('input[type=file]').setInputFiles({ ...markdown, name: 'Grüße.md' });
  await page.getByRole('button', { name: 'PDF erstellen', exact: true }).click();
  const link = page.getByRole('link', { name: /Herunterladen/ });
  await expect(link).toHaveAttribute('download', 'Grüße.pdf', { timeout: 60_000 });
  await expect(page.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('Grüße.pdf');
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
});
