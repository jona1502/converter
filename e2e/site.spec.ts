import { expect, test, type Page } from '@playwright/test';

const PAGES = [
  { path: '/', heading: 'Dateien umwandeln', status: 200 },
  { path: '/lokale-verarbeitung', heading: 'Dateiverarbeitung', status: 200 },
  { path: '/gibt-es-nicht', heading: 'Seite nicht gefunden', status: 404 },
] as const;

/** Sammelt CSP-Verletzungen, Konsolenfehler, Skriptfehler und Anfragen an fremde Hosts. */
async function watchPage(page: Page, baseURL: string, documentStatus = 200) {
  const problems: string[] = [];
  const allowedOrigin = new URL(baseURL).origin;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // Bei der 404-Seite meldet der Browser den Status des Dokuments selbst als Konsolenfehler.
    // Fehlende Unterressourcen werden unabhängig davon über die Antworten unten erkannt.
    const isDocumentStatus = documentStatus === 404 && message.text().includes('404');
    if (!isDocumentStatus) problems.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'document' && response.status() >= 400) {
      problems.push(`Ressource ${response.status()}: ${response.url()}`);
    }
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== allowedOrigin) problems.push(`fremder Host: ${request.url()}`);
  });
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return {
    async assertClean() {
      const violations = await page.evaluate(
        () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
      );
      expect(violations, 'CSP-Verletzungen').toEqual([]);
      expect(problems).toEqual([]);
    },
  };
}

for (const { path, heading, status } of PAGES) {
  test(`${path} rendert ohne CSP-Verletzungen und ohne fremde Anfragen`, async ({ page, baseURL }) => {
    const watcher = await watchPage(page, baseURL!, status);
    const response = await page.goto(path);
    expect(response?.status()).toBe(status);
    await page.waitForLoadState('load');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.locator('meta[http-equiv="content-security-policy" i]')).toHaveCount(1);
    await expect(page.locator('[style]')).toHaveCount(0);
    await watcher.assertClean();
  });
}

test('Unbekannte Adresse zeigt die 404-Seite mit Link zur Startseite', async ({ page }) => {
  const response = await page.goto('/gibt-es-nicht');
  expect(response?.status()).toBe(404);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByRole('heading', { level: 1, name: 'Seite nicht gefunden' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Zur Startseite' }).click();
  await expect(page).toHaveURL(/\/$/);
});

/**
 * WebKit nimmt Links (wie Safari ohne „Tab hebt alle Objekte hervor“) nicht in die Tab-Reihenfolge auf,
 * und die Safari-Kombination Wahl+Tab gibt es in Playwrights WebKit-Build nicht. Dort wird der Link
 * daher programmatisch fokussiert; geprüft wird dann die Aktivierung per Enter. Die Tab-Erreichbarkeit
 * prüfen Chromium, Firefox und Mobil.
 */
const linksAreTabbable = (browserName: string) => browserName !== 'webkit';

test('Skip-Link ist per Tastatur erreichbar und springt zum Inhalt', async ({ page, browserName }) => {
  await page.goto('/lokale-verarbeitung');
  const skip = page.getByRole('link', { name: 'Zum Inhalt springen' });
  if (linksAreTabbable(browserName)) await page.keyboard.press('Tab');
  else await skip.focus();
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#inhalt$/);
  await expect(page.locator('main#inhalt')).toBeFocused();
});

test('Navigation ist per Tastatur bedienbar und markiert die aktive Seite', async ({ page, browserName }) => {
  await page.goto('/');
  const target = page.getByRole('navigation', { name: 'Fußzeile' }).getByRole('link', {
    name: 'Dateiverarbeitung',
  });
  if (linksAreTabbable(browserName)) {
    let reached = false;
    for (let i = 0; i < 30 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await target.evaluate((element) => element === document.activeElement);
    }
    expect(reached, 'Navigationslink per Tab erreichbar').toBe(true);
  } else {
    await target.focus();
  }
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/lokale-verarbeitung\/?$/);
  await expect(
    page.getByRole('navigation', { name: 'Fußzeile' }).getByRole('link', { name: 'Dateiverarbeitung' }),
  ).toHaveAttribute('aria-current', 'page');
});

for (const path of ['/', '/lokale-verarbeitung', '/gibt-es-nicht']) {
  test(`${path} hat bei 320 px Breite keine horizontale Scrollleiste`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
