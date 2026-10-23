import { Buffer } from 'node:buffer';
import { test, expect } from '@playwright/test';

test('Komprimieren zeigt echte Ergebnisse, PNG-Hinweis und optionale Verkleinerung', async ({ page }) => {
  await page.goto('/bilder/komprimieren');
  await expect(page.getByLabel('Zielformat', { exact: true })).toBeEnabled();
  const bytes = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 80;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#abcdef'; ctx.fillRect(0,0,160,80);
    return Array.from(atob(canvas.toDataURL().split(',')[1]!), char => char.charCodeAt(0));
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await page.getByLabel('Zielformat', { exact: true }).selectOption('png');
  await expect(page.getByRole('slider')).toHaveCount(0);
  await expect(page.getByText(/PNG wird nur neu kodiert/)).toBeVisible();
  await page.getByLabel('Maximale Kantenlänge (optional)', { exact: true }).fill('80');
  const button = page.getByRole('button', { name: 'Komprimieren', exact: true });
  await expect(button).toBeEnabled(); await button.click();
  await expect(page.locator('a[download="foto-komprimiert.png"]')).toBeVisible();
  await expect(page.getByText('PNG · 80 × 40 px', { exact: true })).toBeVisible();
  await page.getByLabel('Zielformat', { exact: true }).selectOption('jpeg');
  await expect(page.getByRole('slider', { name: 'Qualität', exact: true })).toBeVisible();
  await expect(page.getByText(/Einstellungen geändert/)).toBeVisible();
  await button.click();
  await expect(page.locator('a[download="foto-komprimiert.jpg"]')).toBeVisible();
  await page.getByLabel('Maximale Kantenlänge (optional)', { exact: true }).fill('0');
  await expect(button).toBeDisabled();
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
});
