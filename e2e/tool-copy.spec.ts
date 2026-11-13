import { expect, test } from '@playwright/test';

// The initial HTML must explain the data contract before an upload is possible.
// No API is mocked or exercised here; runtime behavior belongs to privacy.spec.ts.
test.use({ javaScriptEnabled: false });

for (const path of ['/bilder/konvertieren', '/bilder/komprimieren', '/bilder/skalieren']) {
  test(`${path}: Serverhinweis verspricht keine vollständige Metadatenbereinigung`, async ({ page }) => {
    await page.goto(path);
    const main = page.getByRole('main');
    await expect(main).toContainText('Erst nach ausdrücklichem Start werden Ihre Dateien auf den Server hochgeladen');
    await expect(main).toContainText('temporär');
    await expect(main).toContainText('Eine vollständige Entfernung von Metadaten ist nicht gewährleistet');
  });
}

test('PDF erklärt Upload und temporäre Speicherung vor dem Start', async ({ page }) => {
  await page.goto('/pdf/komprimieren');
  const main = page.getByRole('main');
  await expect(main).toContainText('Erst mit „Komprimieren“ wird Ihre PDF auf den Server hochgeladen');
  await expect(main).toContainText('Datei und Ergebnisse werden temporär gespeichert');
  await expect(main).toContainText('der Erhalt von PDF/A ist nicht garantiert');
});
