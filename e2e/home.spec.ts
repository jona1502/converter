import { expect, test } from '@playwright/test';

// Die Startseite ist die Dropzone mit Typerkennung (QuickStart). Ablauf: quickstart.spec.ts.

test('Startseite zeigt Titel und Dropzone ohne Einleitung, Anleitung oder Kacheln', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/– MI converter$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Dateien umwandeln', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveClass(/sr-only/);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeVisible();
  await expect(page.locator('.hero')).toHaveCount(0);
  await expect(page.locator('.card-link, .tool-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'So funktioniert es' })).toHaveCount(0);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
});

test('Werkzeugliste unter der Dropzone besteht aus erreichbaren Textlinks, keine toten Links', async ({ page, request }) => {
  await page.goto('/');
  const links = page.getByRole('navigation', { name: 'Werkzeuge im Überblick' }).getByRole('link');
  const count = await links.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const href = await links.nth(i).getAttribute('href');
    expect(href).toMatch(/^\//);
    const response = await request.get(href!);
    expect(response.status(), `Link ${href}`).toBe(200);
  }
});

test('Alle internen Links der Startseite sind erreichbar', async ({ page, request }) => {
  await page.goto('/');
  const hrefs = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) => [...new Set(links.map((a) => a.getAttribute('href')!))]);
  for (const href of hrefs) {
    const response = await request.get(href);
    expect(response.status(), `Link ${href}`).toBe(200);
  }
});
