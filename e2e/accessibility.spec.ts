import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument } from '@cantoo/pdf-lib';
import { Buffer } from 'node:buffer';

for (const tool of [
  { path: '/bilder/konvertieren', action: 'Konvertieren', pdf: false },
  { path: '/bilder/komprimieren', action: 'Komprimieren', pdf: false },
  { path: '/bilder/skalieren', action: 'Skalieren', pdf: false },
  { path: '/pdf/komprimieren', action: 'Komprimieren', pdf: true },
]) {
  test(`${tool.path}: automatisierte Barrierefreiheit nach Verarbeitung`, async ({ page }) => {
    await page.goto(tool.path);
    const picker = page.locator('button').filter({ hasText: tool.pdf ? /^PDF auswählen$/ : /^Dateien auswählen$/ });
    await expect(picker).toBeEnabled();
    let bytes: Buffer;
    if (tool.pdf) {
      const document = await PDFDocument.create();
      document.addPage().drawText('Barrierefreiheit');
      bytes = Buffer.from(await document.save());
    } else {
      bytes = Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
        canvas.getContext('2d')!.fillRect(0, 0, 48, 32);
        const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }));
    }
    await page.locator('input[type=file]').setInputFiles({
      name: tool.pdf ? 'zugang.pdf' : 'zugang.png',
      mimeType: tool.pdf ? 'application/pdf' : 'image/png', buffer: bytes,
    });
    await page.getByRole('button', { name: tool.action, exact: true }).click();
    await expect(page.locator('a[download]')).toHaveCount(tool.pdf ? 3 : 1, {timeout: 60_000});
    // One useful populated state per tool; keyboard and responsive behaviour are
    // separately exercised in privacy.spec.ts. No axe rules are disabled.
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations).toEqual([]);
  });
}

// Navigation: Start und eine Werkzeugseite ohne Verarbeitung, dunkel und hell, schmal und breit.
// Mit geöffnetem Dropdown bzw. mobilem Menü, damit auch die aufgeklappte Karte geprüft wird.
for (const path of ['/', '/audio/konvertieren']) {
  for (const theme of ['dark', 'light'] as const) {
    for (const width of [390, 1440]) {
      test(`${path}: Navigation ohne axe-Verstöße (${theme}, ${width} px)`, async ({ page }) => {
        await page.addInitScript((value) => {
          // Lesen nur: das Head-Skript übernimmt die Wahl; geschrieben wird hier nur für den Test.
          if (value === 'light') localStorage.setItem('mi-theme', 'light');
        }, theme);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        else await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
        const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
        const scan = async () => {
          const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          expect(result.violations).toEqual([]);
        };
        await scan();
        if (width < 768) await page.getByRole('button', { name: 'Menü', exact: true }).click();
        else await nav.getByRole('button', { name: 'Konvertieren', exact: true }).click();
        await expect(nav.getByRole('link', { name: 'Bilder konvertieren' })).toBeVisible();
        await scan();
      });
    }
  }
}
