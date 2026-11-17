import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';

async function image(page: Page, name = 'test.png') {
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 60, 80);
    return Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), c => c.charCodeAt(0));
  });
  return { name, mimeType: 'image/png', buffer: Buffer.from(bytes) };
}

async function ready(page: Page) {
  await page.goto('/bilder/konvertieren');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Zielformat', { exact: true })).toBeEnabled();
}

test('Konvertierung, erneute Verarbeitung und Ressourcenfreigabe', async ({ page }) => {
  await page.addInitScript(() => {
    const urls = new Set<string>();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); urls.add(url); return url; };
    URL.revokeObjectURL = url => { urls.delete(url); revoke(url); };
    (window as unknown as { activeUrls: Set<string> }).activeUrls = urls;
  });
  await ready(page);
  await page.locator('input[type=file]').setInputFiles([await image(page), await image(page)]);
  const action = page.getByRole('button', { name: 'Konvertieren', exact: true });
  await expect(action).toBeEnabled();
  await page.getByLabel('Zielformat', { exact: true }).selectOption('jpeg');
  await action.click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(2);
  await expect(page.getByText('test.jpg', { exact: true })).toBeVisible();
  await expect(page.getByText('test-2.jpg', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Herunterladen/ }).first().click();
  expect((await download).suggestedFilename()).toBe('test.jpg');
  await page.getByLabel('Zielformat', { exact: true }).selectOption('png');
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(page.getByText(/Die Einstellungen wurden geändert/)).toBeVisible();
  await action.click();
  await expect(page.getByText('test-konvertiert.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { activeUrls: Set<string> }).activeUrls.size)).toBe(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
});

test('ICO-Größen, BMP-Hintergrund und ungültige Dateien', async ({ page }) => {
  await ready(page);
  await page.locator('input[type=file]').setInputFiles(await image(page));
  const action = page.getByRole('button', { name: 'Konvertieren', exact: true });
  await expect(action).toBeEnabled();
  await page.getByLabel('Zielformat', { exact: true }).selectOption('ico');
  await expect(page.getByRole('group', { name: 'ICO-Größen' })).toBeVisible();
  await page.getByLabel('128 px', { exact: true }).check();
  await action.click();
  await expect(page.locator('a[download="test.ico"]')).toBeVisible();
  await page.getByLabel('Zielformat', { exact: true }).selectOption('bmp');
  await expect(page.getByLabel('Hintergrundfarbe', { exact: true })).toBeVisible();
  await action.click();
  await expect(page.locator('a[download="test.bmp"]')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(page.getByText(/Diese Datei ist kein unterstütztes Bild/)).toBeVisible();
});

test('Stapelgrenze und Fokus nach Entfernen', async ({ page }) => {
  await ready(page);
  const fixture = await image(page);
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: 31 }, (_, i) => ({ ...fixture, name: `bild-${i}.png` })));
  await expect(page.getByRole('alert')).toContainText('1 Datei wurde nicht hinzugefügt');
  await expect(page.locator('.file-row')).toHaveCount(30);
  await page.getByRole('button', { name: 'Datei bild-0.png entfernen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Datei bild-1.png entfernen', exact: true })).toBeFocused();
});

test('Zurücksetzen während der Verarbeitung verwirft alte Statusmeldungen', async ({ page }) => {
  await ready(page);
  await page.locator('input[type=file]').setInputFiles(await image(page));
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    buttons.find(button => button.textContent === 'Konvertieren')!.click();
    buttons.find(button => button.textContent === 'Alle entfernen')!.click();
  });
  await expect(page.getByText('Fügen Sie zuerst mindestens ein verwendbares Bild hinzu.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('live-region')).toHaveText('Alle Dateien entfernt.');
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(0);
});

test('Ablegen mehrerer Dateien nimmt gültige auf und blockiert sie nicht durch ungültige', async ({ page }) => {
  await ready(page);
  const png = await image(page);
  const files = [
    { ...png, name: 'eins.png' },
    { ...png, name: 'zwei.png' },
    { name: 'kaputt.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
  ];
  const data = await page.evaluateHandle(items => {
    const transfer = new DataTransfer();
    for (const item of items) transfer.items.add(new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType }));
    return transfer;
  }, files.map(file => ({ name: file.name, mimeType: file.mimeType, bytes: Array.from(file.buffer) })));
  const zone = page.locator('.drop-zone');
  await zone.dispatchEvent('dragenter', { dataTransfer: data });
  await expect(zone).toHaveAttribute('data-dragging', 'true');
  await zone.dispatchEvent('drop', { dataTransfer: data });
  await expect(zone).not.toHaveAttribute('data-dragging', 'true');
  await expect(page.locator('.file-row')).toHaveCount(3);
  await expect(page.getByText('3 Dateien in der Liste, davon 2 verarbeitbar, 1 nicht verwendbar.')).toBeVisible();
  await expect(page.getByText(/Diese Datei ist kein unterstütztes Bild/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeEnabled();
});
