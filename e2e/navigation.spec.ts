import { expect, test, type Page } from '@playwright/test';

const groups = [
  { label: 'Konvertieren', links: [{ label: 'Bilder konvertieren', path: '/bilder/konvertieren' }] },
  { label: 'Komprimieren', links: [{ label: 'Bilder komprimieren', path: '/bilder/komprimieren' }, { label: 'PDF komprimieren', path: '/pdf/komprimieren' }] },
  { label: 'Skalieren', links: [{ label: 'Bilder skalieren', path: '/bilder/skalieren' }] },
] as const;

function navigation(page: Page) { return page.getByRole('navigation', { name: 'Hauptnavigation' }); }
function summary(page: Page, label: string) { return navigation(page).locator('summary').filter({ hasText: label }); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test('Navbar zeigt drei Werkzeuggruppen und Informationslink', async ({ page }) => {
  await page.goto('/');
  await expect(navigation(page).locator('summary')).toHaveCount(3);
  for (const group of groups) await expect(summary(page, group.label)).toBeVisible();
  await expect(navigation(page).getByRole('link', { name: 'Dateiverarbeitung', exact: true })).toBeVisible();
});

test('Desktop-Hover öffnet die verfügbaren Werkzeuge jeder Gruppe', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Touch-Geräte haben keinen verlässlichen Hover-Zustand.');
  await page.goto('/');
  for (const group of groups) {
    await summary(page, group.label).hover();
    // Der erste Mausklick nach dem Hover darf das gerade geöffnete Menü nicht schließen.
    await summary(page, group.label).click();
    for (const tool of group.links) {
      const link = navigation(page).getByRole('link', { name: tool.label, exact: false });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', tool.path);
    }
  }
});

test('Touch-Klick öffnet Gruppen und navigiert zum gewählten Werkzeug', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Dieser Ablauf prüft ausdrücklich Touch-Bedienung.');
  await page.goto('/');
  for (const group of groups) {
    await summary(page, group.label).click();
    for (const tool of group.links) await expect(navigation(page).getByRole('link', { name: tool.label, exact: false })).toBeVisible();
    await summary(page, group.label).click();
    for (const tool of group.links) await expect(navigation(page).getByRole('link', { name: tool.label, exact: false })).toBeHidden();
  }
  await summary(page, 'Komprimieren').click();
  await navigation(page).getByRole('link', { name: 'PDF komprimieren', exact: false }).click();
  await expect(page).toHaveURL(/\/pdf\/komprimieren\/?$/);
});

test('Tastatur öffnet Gruppen, erreicht Links und Escape schließt mit Fokus am Auslöser', async ({ page, browserName }) => {
  await page.goto('/');
  const trigger = summary(page, 'Komprimieren');
  let reached = false;
  for (let i = 0; i < 15 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await trigger.evaluate(element => element === document.activeElement);
  }
  expect(reached, 'Komprimieren ist mit Tab erreichbar').toBe(true);
  await page.keyboard.press('Enter');
  const first = trigger.locator('..').getByRole('link').first();
  const firstPath = await first.getAttribute('href');
  await expect(first).toBeVisible();
  // WebKit unter Windows nimmt Links wie Safari ohne volle Tastaturnavigation nicht
  // in die Tab-Reihenfolge auf. Dort nur Link-Fokus + Escape prüfen; die anderen
  // Projekte prüfen zusätzlich die tatsächliche Tab-Erreichbarkeit.
  if (browserName === 'webkit') await first.focus();
  else { await page.keyboard.press('Tab'); await expect(first).toBeFocused(); }
  await page.keyboard.press('Escape');
  await expect(first).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await first.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${firstPath}/?$`));
});

for (const group of groups) {
  for (const tool of group.links) {
    test(`${tool.path}: aktiver Werkzeuglink und geöffnetes Menü bei 320 px ohne Überlauf`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(tool.path);
      const trigger = summary(page, group.label);
      await trigger.focus(); await page.keyboard.press('Enter');
      await expect(navigation(page).getByRole('link', { name: tool.label, exact: false })).toHaveAttribute('aria-current', 'page');
      await noOverflow(page);
      await page.keyboard.press('Escape');
      await noOverflow(page);
    });
  }
}

