import { expect, test } from '@playwright/test';

// These checks cover the published processing explanation, without an API mock.
// Actual upload, expiry and cleanup behavior requires the server acceptance suite.
test('Dateiverarbeitung unterscheidet Downloadablauf und physische Löschung', async ({ page }) => {
  await page.goto('/lokale-verarbeitung');
  const main = page.getByRole('main');
  await expect(main).toContainText('Nach Ablauf sind neue Downloads gesperrt');
  await expect(main).toContainText('Bei Serverausfällen kann sich die Bereinigung verzögern');
  await expect(main).toContainText('Das Schließen der Seite garantiert keine sofortige Löschung');
});

test('Dateiverarbeitung verspricht keine vollständige Metadatenbereinigung', async ({ page }) => {
  await page.goto('/lokale-verarbeitung');
  await expect(page.getByRole('main')).toContainText('Eine vollständige Entfernung von Metadaten ist nicht gewährleistet');
});

test('Serververarbeitung und Veröffentlichungsvoraussetzungen bleiben ohne JavaScript lesbar', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/lokale-verarbeitung');
  const main = page.getByRole('main');
  await expect(main).toContainText('Die Dateiauswahl startet keinen Upload');
  await expect(main).toContainText('Es gibt keinen automatischen Wechsel zur lokalen Verarbeitung');
  await expect(main).toContainText('Betreiberangaben, Impressum und vollständige rechtliche Datenschutzhinweise');
  await context.close();
});

test('Dateiverarbeitung erklärt Audio: Tags und Cover gehen verloren, kein M4A/AAC', async ({ page }) => {
  await page.goto('/lokale-verarbeitung');
  const audio = page.getByRole('region', { name: 'Audiodateien' });
  await expect(audio).toContainText('eingebettete Cover gehen dabei verloren');
  await expect(audio).toContainText('nicht aber M4A oder AAC');
});
