import { expect, test } from '@playwright/test';

test('Startseite zeigt Einleitung und Werkzeugbereich; Ablauf nur bei verfügbaren Werkzeugen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/– Dateiwerkzeuge$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Werkzeuge' })).toBeVisible();
  const hasTools = (await page.locator('section[aria-labelledby="werkzeuge"] a.card-link').count()) > 0;
  await expect(page.getByRole('heading', { level: 2, name: 'So funktioniert es' })).toHaveCount(hasTools ? 1 : 0);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
});

test('Werkzeugbereich zeigt Kacheln oder einen Hinweis, aber keine toten Links', async ({ page, request }) => {
  await page.goto('/');
  const section = page.locator('section[aria-labelledby="werkzeuge"]');
  const tiles = section.locator('a.card-link');
  const count = await tiles.count();
  if (count === 0) {
    await expect(section.locator('.notice')).toBeVisible();
    return;
  }
  for (let i = 0; i < count; i++) {
    const href = await tiles.nth(i).getAttribute('href');
    expect(href).toMatch(/^\//);
    const response = await request.get(href!);
    expect(response.status(), `Kachel-Link ${href}`).toBe(200);
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
