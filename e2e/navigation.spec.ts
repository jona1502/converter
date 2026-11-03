import { expect, test, type Page } from '@playwright/test';

const tools = [
  { label: 'Bilder konvertieren', path: '/bilder/konvertieren' },
  { label: 'Bilder komprimieren', path: '/bilder/komprimieren' },
  { label: 'Bilder skalieren', path: '/bilder/skalieren' },
  { label: 'PDF komprimieren', path: '/pdf/komprimieren' },
] as const;

function navigation(page: Page) { return page.getByRole('navigation', { name: 'Hauptnavigation' }); }
function trigger(page: Page) { return page.getByRole('button', { name: 'Werkzeuge auswählen' }); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test('Desktop zeigt vier direkte Werkzeuge und Information in der schmalen Seitennavigation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  for (const tool of tools) {
    const link = navigation(page).getByRole('link', { name: tool.label, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', tool.path);
  }
  await expect(navigation(page).getByRole('link', { name: 'Dateiverarbeitung', exact: true })).toBeVisible();
  const rail = await page.getByRole('banner').boundingBox();
  const main = await page.getByRole('main').boundingBox();
  expect(rail!.width).toBeGreaterThanOrEqual(208);
  expect(rail!.width).toBeLessThanOrEqual(232);
  expect(main!.x).toBeGreaterThanOrEqual(rail!.width);
  await noOverflow(page);
});

test('Kompakte Auswahl öffnet alle Werkzeuge und navigiert per Klick', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  for (const tool of tools) await expect(navigation(page).getByRole('link', { name: tool.label, exact: true })).toBeVisible();
  await trigger(page).click();
  await expect(navigation(page)).toBeHidden();
  await trigger(page).click();
  await navigation(page).getByRole('link', { name: 'PDF komprimieren', exact: true }).click();
  await expect(page).toHaveURL(/\/pdf\/komprimieren\/?$/);
});

test('Tastatur erreicht Werkzeuglinks und Escape schließt mit Rückfokus', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const control = trigger(page);
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await control.evaluate(element => element === document.activeElement);
  }
  expect(reached, 'Werkzeugauswahl ist mit Tab erreichbar').toBe(true);
  await page.keyboard.press('Enter');
  const first = navigation(page).getByRole('link', { name: 'Alle Werkzeuge', exact: true });
  // WebKit überspringt Links ohne volle Tastaturnavigation, daher dort Linkfokus explizit setzen.
  if (browserName === 'webkit') await first.focus();
  else { await page.keyboard.press('Tab'); await expect(first).toBeFocused(); }
  await page.keyboard.press('Escape');
  await expect(navigation(page)).toBeHidden();
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await navigation(page).getByRole('link', { name: tools[0].label, exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/bilder\/konvertieren\/?$/);
});

test('Außenklick und Fokuswechsel schließen die kompakte Auswahl', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await trigger(page).click();
  await page.getByRole('main').click({ position: { x: 4, y: 4 } });
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  await trigger(page).click();
  await page.getByRole('main').getByRole('link').first().focus();
  await expect(navigation(page)).toBeHidden();
});

for (const tool of tools) {
  test(`${tool.path}: aktive Route und kompakte Auswahl bei 320 px ohne Überlauf`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(tool.path);
    await trigger(page).click();
    await expect(navigation(page).getByRole('link', { name: tool.label, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Fußzeile' }).getByRole('link', { name: tool.label, exact: true })).toHaveAttribute('aria-current', 'page');
    await noOverflow(page);
    await page.keyboard.press('Escape');
    await noOverflow(page);
  });
}

test('Ohne JavaScript bleiben alle Werkzeuge und die Informationsseite zugänglich', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    for (const tool of tools) await expect(navigation(page).getByRole('link', { name: tool.label, exact: true })).toBeVisible();
    // Playwrights Textsuche schließt noscript aus, auch wenn der Browser es ohne JavaScript rendert.
    await expect(page.locator('noscript p')).toBeVisible();
    await navigation(page).getByRole('link', { name: 'Dateiverarbeitung', exact: true }).click();
    await expect(page).toHaveURL(/\/lokale-verarbeitung\/?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dateiverarbeitung' })).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
});

test('Wechsel zur kompakten Navigation führt verborgenen Linkfokus zum Auslöser zurück', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await navigation(page).getByRole('link', { name: tools[0].label, exact: true }).focus();
  // 720 CSS-Pixel entsprechen der verfügbaren Breite eines 1440-Pixel-Fensters bei 200 Prozent Zoom.
  await page.setViewportSize({ width: 720, height: 450 });
  await expect(trigger(page)).toBeFocused();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  await trigger(page).press('Enter');
  for (const tool of tools) await expect(navigation(page).getByRole('link', { name: tool.label, exact: true })).toBeVisible();
  await noOverflow(page);
});
