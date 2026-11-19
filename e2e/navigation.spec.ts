import { expect, test, type Page } from '@playwright/test';

const tools = [
  { label: 'Bilder konvertieren', path: '/bilder/konvertieren', group: 'Konvertieren' },
  { label: 'Markdown zu PDF', path: '/pdf/markdown', group: 'Konvertieren' },
  { label: 'Bild zu PDF', path: '/pdf/aus-bildern', group: 'Konvertieren' },
  { label: 'PDF zu Bild', path: '/pdf/zu-bild', group: 'Konvertieren' },
  { label: 'Audio konvertieren', path: '/audio/konvertieren', group: 'Konvertieren' },
  { label: 'Bilder komprimieren', path: '/bilder/komprimieren', group: 'Komprimieren' },
  { label: 'PDF komprimieren', path: '/pdf/komprimieren', group: 'Komprimieren' },
  { label: 'Bilder skalieren', path: '/bilder/skalieren', group: 'Skalieren' },
  { label: 'PDF drehen', path: '/pdf/drehen', group: 'Drehen' },
  { label: 'PDF teilen', path: '/pdf/teilen', group: 'Teilen' },
  { label: 'PDF zusammenführen', path: '/pdf/zusammenfuehren', group: 'Zusammenführen' },
] as const;
const groups = ['Konvertieren', 'Komprimieren', 'Skalieren', 'Drehen', 'Teilen', 'Zusammenführen'] as const;

function navigation(page: Page) { return page.getByRole('navigation', { name: 'Hauptnavigation' }); }
function group(page: Page, name: string) { return navigation(page).getByRole('button', { name: `${name}-Menü`, exact: true }); }
function menuButton(page: Page) { return page.getByRole('button', { name: 'Menü', exact: true }); }
function link(page: Page, label: string) { return navigation(page).getByRole('link', { name: label, exact: true }); }
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe('Desktop (1440 px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Kopfzeile: Logo links, vier Menüs, Theme-Umschalter rechts, keine Seitenleiste', async ({ page }) => {
    await page.goto('/');
    const header = await page.getByRole('banner').boundingBox();
    const main = await page.getByRole('main').boundingBox();
    // Die frühere 14rem-Seitenleiste entfällt: Kopfzeile ist eine niedrige Leiste über dem Inhalt.
    expect(header!.height).toBeLessThan(100);
    expect(header!.width).toBeGreaterThan(1000);
    expect(main!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    await expect(page.getByText('Alle Werkzeuge', { exact: true })).toHaveCount(0);
    await expect(page.locator('.tool-picker')).toHaveCount(0);
    const logo = await page.getByRole('banner').getByRole('link', { name: 'MI converter' }).boundingBox();
    const first = await group(page, 'Konvertieren').boundingBox();
    expect(logo!.x).toBeLessThan(first!.x);
    for (const name of groups) {
      await expect(group(page, name)).toBeVisible();
      await expect(group(page, name)).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(menuButton(page)).toBeHidden();
    await noOverflow(page);
  });

  test('Klick öffnet ein Menü mit den Werkzeugen der Aktion; es ist immer nur eins offen', async ({ page }) => {
    await page.goto('/');
    for (const tool of tools) await expect(link(page, tool.label)).toBeHidden();
    await group(page, 'Konvertieren').click();
    await expect(group(page, 'Konvertieren')).toHaveAttribute('aria-expanded', 'true');
    await expect(group(page, 'Konvertieren')).toHaveAttribute('aria-controls', 'menue-convert');
    for (const tool of tools) {
      if (tool.group === 'Konvertieren') {
        await expect(link(page, tool.label)).toBeVisible();
        await expect(link(page, tool.label)).toHaveAttribute('href', tool.path);
      } else await expect(link(page, tool.label)).toBeHidden();
    }
    await group(page, 'Komprimieren').click();
    await expect(group(page, 'Konvertieren')).toHaveAttribute('aria-expanded', 'false');
    await expect(group(page, 'Komprimieren')).toHaveAttribute('aria-expanded', 'true');
    await expect(link(page, 'PDF komprimieren')).toBeVisible();
    await expect(link(page, 'Audio konvertieren')).toBeHidden();
    await group(page, 'Komprimieren').click();
    await expect(group(page, 'Komprimieren')).toHaveAttribute('aria-expanded', 'false');
    await expect(link(page, 'PDF komprimieren')).toBeHidden();
  });

  test('Tastatur: Enter öffnet, Pfeiltasten wandern, Escape schließt und gibt den Fokus zurück', async ({ page, browserName }) => {
    await page.goto('/');
    const trigger = group(page, 'Konvertieren');
    if (browserName === 'webkit') await trigger.focus();
    else {
      let reached = false;
      for (let i = 0; i < 10 && !reached; i++) {
        await page.keyboard.press('Tab');
        reached = await trigger.evaluate(element => element === document.activeElement);
      }
      expect(reached, 'Menü ist mit Tab erreichbar').toBe(true);
    }
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(link(page, 'Bilder konvertieren')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(link(page, 'Markdown zu PDF')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(link(page, 'Bild zu PDF')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(link(page, 'PDF zu Bild')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(link(page, 'Audio konvertieren')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(link(page, 'Audio konvertieren')).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await link(page, 'Audio konvertieren').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/audio\/konvertieren\/?$/);
  });

  test('Klick außerhalb und Fokuswechsel schließen das Menü', async ({ page }) => {
    await page.goto('/');
    await group(page, 'Skalieren').click();
    await expect(link(page, 'Bilder skalieren')).toBeVisible();
    await page.getByRole('main').click({ position: { x: 4, y: 4 } });
    await expect(group(page, 'Skalieren')).toHaveAttribute('aria-expanded', 'false');
    await expect(link(page, 'Bilder skalieren')).toBeHidden();
    await group(page, 'Skalieren').click();
    // WebKit fokussiert Buttons bei einem Mausklick nicht: Fokus vor dem Verlassen herstellen.
    await group(page, 'Skalieren').focus();
    await expect(group(page, 'Skalieren')).toBeFocused();
    await page.getByRole('main').getByRole('link').first().focus();
    await expect(group(page, 'Skalieren')).toHaveAttribute('aria-expanded', 'false');
  });

  for (const tool of tools) {
    test(`${tool.path}: aktiver Eintrag trägt aria-current="page"`, async ({ page }) => {
      await page.goto(tool.path);
      await group(page, tool.group).click();
      await expect(link(page, tool.label)).toHaveAttribute('aria-current', 'page');
      for (const other of tools.filter(entry => entry.group === tool.group && entry !== tool)) {
        await expect(link(page, other.label)).not.toHaveAttribute('aria-current', /.*/);
      }
    });
  }

  test('Startseite markiert nur das Logo als aktuell', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('banner').getByRole('link', { name: 'MI converter' })).toHaveAttribute('aria-current', 'page');
    await expect(navigation(page).locator('[aria-current]')).toHaveCount(0);
  });
});

test.describe('Mobil (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Menü-Button klappt eine Liste mit denselben Gruppen auf und navigiert per Klick', async ({ page }) => {
    await page.goto('/');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toHaveAttribute('aria-controls', 'hauptnavigation');
    await expect(navigation(page)).toBeHidden();
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    for (const name of groups) await expect(navigation(page).locator('.nav-label', { hasText: name })).toBeVisible();
    for (const name of groups) await expect(group(page, name)).toBeHidden();
    for (const tool of tools) await expect(link(page, tool.label)).toBeVisible();
    await noOverflow(page);
    await menuButton(page).click();
    await expect(navigation(page)).toBeHidden();
    await menuButton(page).click();
    await link(page, 'PDF komprimieren').click();
    await expect(page).toHaveURL(/\/pdf\/komprimieren\/?$/);
  });

  test('Escape schließt das Menü mit Fokus auf dem Menü-Button, Außenklick ebenfalls', async ({ page }) => {
    await page.goto('/');
    await menuButton(page).click();
    await link(page, 'Bilder konvertieren').focus();
    await page.keyboard.press('Escape');
    await expect(navigation(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await menuButton(page).click();
    await page.getByRole('main').click({ position: { x: 4, y: 4 } });
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  for (const tool of tools) {
    test(`${tool.path}: aktive Route bei 320 px ohne Überlauf`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(tool.path);
      await menuButton(page).click();
      await expect(link(page, tool.label)).toHaveAttribute('aria-current', 'page');
      await noOverflow(page);
      await page.keyboard.press('Escape');
      await noOverflow(page);
    });
  }
});

test('Ohne JavaScript bleiben alle Werkzeuge und die Informationsseite zugänglich', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 720 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    for (const tool of tools) await expect(link(page, tool.label)).toBeVisible();
    // Playwrights Textsuche schließt noscript aus, auch wenn der Browser es ohne JavaScript rendert.
    await expect(page.locator('noscript p')).toBeVisible();
    await page.getByRole('navigation', { name: 'Fußzeile' }).getByRole('link', { name: 'Dateiverarbeitung', exact: true }).click();
    await expect(page).toHaveURL(/\/lokale-verarbeitung\/?$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dateiverarbeitung' })).toBeVisible();
    await noOverflow(page);
  } finally {
    await context.close();
  }
});

test('Breitenwechsel von Desktop auf mobil: Navigation hinter dem Menü-Button, alle Werkzeuge erreichbar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await group(page, 'Konvertieren').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(navigation(page)).toBeHidden();
  await menuButton(page).click();
  for (const tool of tools) await expect(link(page, tool.label)).toBeVisible();
  await noOverflow(page);
});
