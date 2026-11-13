import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// API-Doubles belegen Darstellung und Lebenszyklus der Oberfläche, keine echte Kodierung.
async function prepare(page: Page, width = 390) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    image: { inputFormats: ['png'], outputFormats: ['jpeg', 'png', 'webp', 'bmp', 'ico'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
    pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'file-results-test' } }));
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ status: 204 }));
  await page.goto('/bilder/konvertieren');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), char => char.charCodeAt(0));
  });
  return { name: 'beispiel.png', mimeType: 'image/png', buffer: Buffer.from(bytes) };
}

function result(size: number, expiresAt = new Date(Date.now() + 60000).toISOString()) {
  return {
    id: 'file-result', state: 'succeeded', expiresAt, input: { size: 100 },
    results: [{ state: 'succeeded', size, mime: 'image/webp', downloadName: 'beispiel.webp', downloadUrl: '/api/v1/jobs/file-result/results/output', details: { width: 32, height: 24 } }],
  };
}

test('320px: vollständige lange Namen, beschriebene Auswahl und Fokus nach Entfernen', async ({ page }, testInfo) => {
  const file = await prepare(page, 320);
  const picker = page.getByRole('button', { name: 'Dateien auswählen', exact: true });
  await expect(picker).toHaveAccessibleDescription(/Formate:.*Höchstens 30 Dateien/s);
  let uploads = 0;
  await page.route('**/api/v1/jobs', route => { uploads++; return route.fulfill({ status: 500 }); });
  const name = `${'Dateiname-ohne-abgeschnittene-Information-'.repeat(5)}.png`;
  await page.locator('input[type=file]').setInputFiles([{ ...file, name }, file]);
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeEnabled();
  const nameElement = page.getByText(name, { exact: true });
  const dimensions = await nameElement.evaluate(element => ({
    height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(dimensions.height).toBeGreaterThan(dimensions.lineHeight * 2);
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('selection-320.png'), fullPage: true, style: 'astro-dev-toolbar { display: none !important; }' });
  await page.getByRole('button', { name: `Datei ${name} entfernen`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Datei beispiel.png entfernen', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Datei beispiel.png entfernen', exact: true }).click();
  await expect(picker).toBeFocused();
  // Dasselbe Dateifeld nimmt nach dem Entfernen dieselbe Datei erneut an.
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.locator('.file-row')).toHaveCount(1);
});

for (const kind of ['smaller', 'equal', 'larger'] as const) {
  test(`Vergleich ${kind}: Original, Ergebnis, Änderung und Downloadablauf gehören zur Datei`, async ({ page }, testInfo) => {
    const file = await prepare(page);
    const size = kind === 'equal' ? file.buffer.length : kind === 'larger' ? file.buffer.length * 2 : Math.floor(file.buffer.length / 2);
    await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: result(size) }));
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
    const row = page.locator('.file-row');
    await expect(row.getByRole('link', { name: /Herunterladen/ })).toBeVisible();
    await expect(row.getByRole('group', { name: 'Original', exact: true })).toContainText('PNG');
    await expect(row.getByRole('group', { name: 'Ergebnis', exact: true })).toContainText('WebP');
    await expect(row.getByText('Änderung', { exact: true })).toBeVisible();
    await expect(row.locator('[data-size-change]')).toHaveAttribute('data-size-change', kind);
    await expect(row.locator('.file-result time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
    if (kind === 'larger') await expect(row).toContainText('Größer als das Original');
    if (kind === 'equal') await expect(row).toContainText('Keine Einsparung');
    if (kind === 'smaller') await expect(row.locator('[data-size-change]')).toContainText('kleiner');
    if (kind === 'larger') await page.screenshot({ path: testInfo.outputPath('result-larger-390.png'), fullPage: true, style: 'astro-dev-toolbar { display: none !important; }' });
  });
}

test('Ablauf entfernt Download und benennt abgelaufenen Status', async ({ page }) => {
  const file = await prepare(page);
  await page.clock.install();
  const expiresAt = new Date(await page.evaluate(() => Date.now()) + 5000).toISOString();
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: result(40, expiresAt) }));
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('a[download]')).toHaveCount(1);
  await page.clock.fastForward(6000);
  const row = page.locator('.file-row');
  await expect(row.locator('a[download]')).toHaveCount(0);
  await expect(row.locator('.badge')).toContainText('Abgelaufen');
  await expect(row).not.toContainText('Verfügbar bis');
  await expect(row).toContainText('erneut');
});

test('Queue, Verarbeitung und Reset zeigen echten Status ohne verspätetes Ergebnis', async ({ page }) => {
  const file = await prepare(page);
  let polls = 0;
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: { ...result(40), state: 'queued', results: [] } }));
  await page.route('**/api/v1/jobs/file-result', route => {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
    polls++;
    return route.fulfill({ json: { ...result(40), state: 'running', results: [] } });
  });
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('.file-row .badge')).toContainText('Wartet auf Verarbeitung');
  await expect(page.locator('.file-row .badge')).toContainText('Wird verarbeitet');
  expect(polls).toBeGreaterThan(0);
  await expect(page.locator('.file-row progress')).not.toHaveAttribute('value');
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
  await expect(page.getByTestId('live-region')).toHaveText('Alle Dateien entfernt.');
  await expect(page.locator('a[download]')).toHaveCount(0);
});

test('Axe in leerer, fertiger und fehlerhafter Dateiliste; Teilfehler erhält erfolgreichen Download', async ({ page }) => {
  const file = await prepare(page);
  const axe = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect((await axe()).violations).toEqual([]);
  let calls = 0;
  await page.route('**/api/v1/jobs', route => {
    calls++;
    return calls === 1 ? route.fulfill({ status: 202, json: result(40) }) : route.fulfill({ status: 413, json: { error: { code: 'file-too-large' } } });
  });
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('a[download]')).toHaveCount(1);
  expect((await axe()).violations).toEqual([]);
  // Ein neuer Stapel enthält gleichzeitig einen Erfolg und einen Fehler.
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  calls = 0;
  await page.locator('input[type=file]').setInputFiles([file, { ...file, name: 'zweite.png' }]);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('.file-row[data-status="error"]')).toHaveCount(1);
  await expect(page.locator('a[download]')).toHaveCount(1);
  await expect(page.locator('.file-row[data-status="error"]')).toContainText('zulässige Größe');
  expect((await axe()).violations).toEqual([]);
});

test('ICO-Auswahl erklärt die erforderliche Mindestgröße an der Gruppe', async ({ page }) => {
  await prepare(page);
  await page.getByLabel('Zielformat', { exact: true }).selectOption('ico');
  const sizes = page.getByRole('group', { name: 'ICO-Größen', exact: true });
  await expect(sizes).toHaveAccessibleDescription('Mindestens eine Größe ist erforderlich.');
  const checked = sizes.getByRole('checkbox', { checked: true });
  while (await checked.count() > 1) await checked.first().uncheck();
  await expect(checked).toBeDisabled();
});

test('Drop, gleiche Namen, Servergrenze und ungültige Signatur bleiben lokal prüfbar', async ({ page }) => {
  const file = await prepare(page);
  let uploads = 0;
  await page.route('**/api/v1/jobs', route => { uploads++; return route.fulfill({ status: 500 }); });
  await expect(page.getByText(/Erst nach ausdrücklichem Start/)).toBeVisible();
  const transfer = await page.evaluateHandle(({ name, bytes }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    return transfer;
  }, { name: file.name, bytes: [...file.buffer] });
  await page.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: transfer });
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.locator('.file-row')).toHaveCount(2);
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: 29 }, (_, index) => ({ ...file, name: `stapel-${index}.png` })));
  await expect(page.locator('.file-row')).toHaveCount(30);
  await expect(page.getByRole('alert')).toContainText('1 Datei wurde nicht hinzugefügt');
  expect(uploads).toBe(0);
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('kein Bild') });
  await expect(page.locator('.file-row')).toContainText('Nicht verwendbar');
  await expect(page.locator('.field-error')).toContainText('kein unterstütztes Bild');
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeDisabled();
  expect(uploads).toBe(0);
});

for (const action of ['Alle entfernen', 'Datei beispiel.png entfernen']) {
  test(`Späte Uploadantwort nach „${action}“ stellt keine Datei wieder her`, async ({ page }) => {
    const file = await prepare(page);
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    let responded = false;
    await page.route('**/api/v1/jobs', async route => {
      started = true;
      await delayed;
      await route.fulfill({ status: 202, json: result(40) });
      responded = true;
    });
    await page.locator('input[type=file]').setInputFiles(file);
    await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await expect(page.locator('.file-row .badge')).toContainText('Wird hochgeladen');
    await page.getByRole('button', { name: action, exact: true }).click();
    release();
    await expect.poll(() => responded).toBe(true);
    await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
    await expect(page.locator('.file-row')).toHaveCount(0);
    await expect(page.locator('a[download]')).toHaveCount(0);
  });
}

test('Serverausfall verhindert die Dateiauswahl und erklärt den Grund', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/v1/capabilities', route => route.fulfill({ status: 503, json: { error: { code: 'server-busy' } } }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Der Verarbeitungsserver ist nicht verfügbar');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeDisabled();
  await expect(page.getByText('Der Server unterstützt dieses Werkzeug nicht.', { exact: true })).toBeVisible();
});
