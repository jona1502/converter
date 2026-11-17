import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Startseite: Dateien ablegen, Typ lokal erkennen, Aktion wählen, Werkzeug mit der Datei öffnen.
// Direkte Ausgabeauswahl ersetzt jetzt die frühere Aktionswahl; zusätzliche Werkzeuge bleiben erreichbar.
// API-Doubles ersetzen den Server; geprüft werden Ablauf und Datenschutz, keine echte Verarbeitung.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const png = (name = 'beispiel.png') => ({ name, mimeType: 'image/png', buffer: PNG });
const pdf = (name = 'beispiel.pdf') => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n') });
const text = (name = 'notiz.txt') => ({ name, mimeType: 'text/plain', buffer: Buffer.from('Das ist keine unterstützte Datei.') });

function wav(name = 'ton.wav') {
  const frames = 800;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frames * 2, 40);
  return { name, mimeType: 'audio/wav', buffer };
}

const capabilities = {
  tools: ['image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert'],
  image: { inputFormats: ['png'], outputFormats: ['jpeg', 'png', 'webp', 'bmp', 'ico'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
  pdf: { maxFileBytes: 100000000 },
  jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  audio: {
    inputFormats: ['mp3', 'wav', 'flac', 'ogg'], outputFormats: ['mp3', 'wav', 'flac', 'ogg'], qualityFormats: ['mp3', 'ogg'],
    defaultQuality: 0.8, maxFileBytes: 104857600, maxDurationSeconds: 1800, maxChannels: 8, maxSampleRate: 192000, maxOutputBytes: 419430400,
  },
};

/** Startet die Startseite mit API-Doubles und zählt alles, was den Server als Auftrag erreichen würde. */
async function open(page: Page, { width = 1440 } = {}) {
  const uploads: string[] = [];
  await page.addInitScript(() => {
    const audit = { storage: [] as string[], csp: [] as string[] };
    document.addEventListener('securitypolicyviolation', (event) => audit.csp.push(`${event.violatedDirective}: ${event.blockedURI}; ${event.sourceFile}:${event.lineNumber}; ${event.sample}`));
    Object.assign(window, { __audit: audit });
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, item) { audit.storage.push(`storage:${key}`); return set.call(this, key, item); };
    const idb = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<typeof indexedDB.open>) => { audit.storage.push('indexedDB'); return idb(...args); };
    if ('caches' in window) {
      const cacheOpen = caches.open.bind(caches);
      caches.open = (name) => { audit.storage.push('cache'); return cacheOpen(name); };
    }
  });
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/capabilities', (route) => route.fulfill({ json: capabilities }));
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: { csrfToken: 'quickstart-test' } }));
  await page.route('**/api/v1/jobs', (route) => { const body = route.request().postData()!; uploads.push(body);
    const format = body.match(/"format":"([^"]+)"/)?.[1] ?? 'pdf';
    return route.fulfill({ json: { id: `quick-${uploads.length}`, state: 'succeeded', expiresAt: new Date(Date.now() + 3600000).toISOString(), results: [{ downloadUrl: `/api/v1/jobs/quick-${uploads.length}/result`, size: 12, mime: `application/${format}`, details: { format } }] } }); });
  await page.route('**/api/v1/jobs/*', (route) => route.fulfill({ status: 204 }));
  await page.goto('/');
  await expect(picker(page)).toBeEnabled();
  return { uploads };
}

const picker = (page: Page) => page.getByRole('button', { name: 'Dateien auswählen', exact: true });
const choose = (page: Page, files: Parameters<ReturnType<Page['locator']>['setInputFiles']>[0]) => page.locator('input[type=file]').setInputFiles(files);
const action = (page: Page, name: string) => page.getByRole('main').getByRole('button', { name, exact: true });
const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
const storageWrites = (page: Page) => page.evaluate(() => (window as unknown as { __audit: { storage: string[] } }).__audit.storage);
// WebKit meldet für jedes eingefügte native <select> eine style-src-attr-Verletzung (interne UA-Styles,
// siehe privacy.spec.ts). Rendert React das Werkzeug, ordnet WebKit sie dem React-DOM-Bundle zu.
// Nur dieses Ereignis wird in WebKit ausgenommen; Chromium und Firefox prüfen denselben Fluss streng.
const cspViolations = async (page: Page) => {
  const events = await page.evaluate(() => (window as unknown as { __audit: { csp: string[] } }).__audit.csp);
  return page.context().browser()?.browserType().name() === 'webkit' ? events.filter((event) => !/^style-src-attr: inline; (?:|https?:\/\/[^/]+\/_astro\/client\.[\w-]+\.js):\d+; $/.test(event)) : events;
};

const rows = (page: Page) => page.locator('.file-row:visible');
const output = (page: Page, index = 0) => rows(page).nth(index).getByLabel('Ausgabe');
const remove = (page: Page, index = 0) => rows(page).nth(index).getByRole('button', { name: /entfernen/i });
const heading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Dateien umwandeln', exact: true });
const back = (page: Page) => action(page, '← Zur Dateiliste');

test('Auswahl zeigt Titel, eine Dropzone und höchstens eine Textlinkliste statt Karten', async ({ page }) => {
  await open(page);
  await expect(heading(page)).toBeVisible();
  await expect(picker(page)).toHaveAccessibleDescription(/Bilder, PDF, Audio und Markdown.*hochgeladen wird erst/s);
  await expect(page.locator('.drop-zone')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Werkzeuge im Überblick' }).getByRole('link')).toHaveText(['Bilder konvertieren', 'Bilder komprimieren', 'Bilder skalieren', 'Markdown zu PDF', 'PDF komprimieren', 'Audio konvertieren']);
  await expect(page.locator('.card, .card-link, .tool-card')).toHaveCount(0);
  const accept = await page.locator('input[type=file]').getAttribute('accept');
  for (const part of ['.png', '.pdf', 'application/pdf', '.mp3', '.flac']) expect(accept).toContain(part);
  await choose(page, png());
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Was soll passieren?' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test('Bild: direkte Ausgabe und sekundäres Komprimieren ohne Upload', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, png());
  await expect(heading(page)).toBeFocused();
  await expect(rows(page)).toContainText('PNG');
  await expect(output(page).locator('option')).toHaveText(['JPEG', 'PNG', 'WebP', 'BMP', 'ICO']);
  await output(page).selectOption('webp');
  await action(page, 'Komprimieren').click();
  await expect(page).toHaveURL(/#bilder-komprimieren$/);
  await expect(page.getByRole('heading', { name: 'Bilder komprimieren', exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('beispiel.png');
  // Dieselbe Vorprüfung wie bei der eigenen Dropzone: danach ist die Datei bereit.
  await expect(action(page, 'Komprimieren')).toBeEnabled();
  await back(page).click();
  await expect(output(page)).toHaveValue('webp');
  expect(uploads).toEqual([]);
  expect(await storageWrites(page)).toEqual([]);
});

test('Bild: direkte Konvertierung hält Ergebnis und Skalieren erhält Auswahl', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, png());
  await output(page).selectOption('webp');
  await action(page, 'Konvertieren').click();
  await expect(rows(page).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'beispiel.webp');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain('"format":"webp"');
  expect(uploads[0]).toContain('"tool":"image-convert"');
  await action(page, 'Skalieren').click();
  await expect(page.getByRole('heading', { name: 'Bilder skalieren', exact: true })).toBeVisible();
  await expect(rows(page)).toContainText('beispiel.png');
  await back(page).click();
  await expect(output(page)).toHaveValue('webp');
  await expect(rows(page).getByRole('link', { name: /Download/ })).toBeVisible();
  expect(uploads).toHaveLength(1);
});

test('PDF: nur Komprimieren, Werkzeug übernimmt Datei ohne vorzeitigen Upload', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, pdf());
  await expect(rows(page)).toContainText('PDF');
  await expect(output(page)).toHaveCount(0);
  await expect(action(page, 'Konvertieren')).toBeDisabled();
  await expect(action(page, 'Skalieren')).toHaveCount(0);
  await action(page, 'PDF komprimieren').click();
  await expect(page).toHaveURL(/#pdf-komprimieren$/);
  await expect(page.getByRole('heading', { name: 'PDF komprimieren', exact: true })).toBeVisible();
  await expect(page.getByText('Ausgewählte PDF')).toBeVisible();
  await expect(page.getByText('beispiel.pdf', { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(action(page, 'Komprimieren')).toBeEnabled();
  expect(uploads).toEqual([]);
});

test('Audio: WAV bietet direkte Ziele und MP3 erreicht tatsächlichen Auftrag', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, wav());
  await expect(rows(page)).toContainText('Audio');
  await expect(output(page).locator('option')).toHaveText(['MP3', 'WAV', 'FLAC', 'OGG']);
  await expect(action(page, 'Komprimieren')).toHaveCount(0);
  await output(page).selectOption('mp3');
  expect(uploads).toEqual([]);
  await action(page, 'Konvertieren').click();
  await expect(rows(page).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'ton.mp3');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain('"format":"mp3"');
  expect(uploads[0]).toContain('"tool":"audio-convert"');
  await expect(page).toHaveURL(/\/$/);
});

test('Typ folgt der Signatur, nicht der Endung', async ({ page }) => {
  await open(page);
  await choose(page, png('foto.pdf'));
  await expect(rows(page)).toContainText('PNG');
  await expect(output(page)).toBeEnabled();
  await expect(action(page, 'Skalieren')).toBeVisible();
  await expect(action(page, 'PDF komprimieren')).toHaveCount(0);
});

test('Unbekannter Typ bleibt sichtbar und blockiert gültigen Nachbarn nicht', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, text());
  await expect(rows(page)).toContainText('nicht unterstützt');
  await expect(rows(page)).toContainText('notiz.txt');
  await expect(output(page)).toHaveCount(0);
  await expect(action(page, 'Konvertieren')).toBeDisabled();
  await choose(page, png());
  await expect(rows(page)).toHaveCount(2);
  await expect(output(page, 1)).toBeEnabled();
  await expect(action(page, 'Konvertieren')).toBeEnabled();
  await remove(page).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText('beispiel.png');
  expect(uploads).toEqual([]);
});

test('Gemischte Typen behalten Optionen und sekundäre PDF-Rückkehr bewahrt Liste', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, [png(), pdf(), text()]);
  await expect(rows(page)).toHaveCount(3);
  await output(page).selectOption('webp');
  await expect(output(page, 1)).toHaveCount(0);
  await expect(output(page, 2)).toHaveCount(0);
  await expect(rows(page).nth(2)).toContainText('nicht unterstützt');
  await rows(page).nth(1).getByRole('button', { name: 'PDF komprimieren' }).click();
  await expect(page.getByText('Ausgewählte PDF')).toBeVisible();
  await expect(page.getByText('beispiel.png', { exact: true })).not.toBeVisible();
  await back(page).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(output(page)).toHaveValue('webp');
  expect(uploads).toEqual([]);
  await action(page, 'Konvertieren').click();
  await expect(rows(page).nth(0).getByRole('link', { name: /Download/ })).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  expect(uploads).toHaveLength(1);
});

test('Ergänzen bewahrt Auswahl, letzte Entfernung fokussiert ursprüngliche Dropzone', async ({ page }) => {
  await open(page);
  await choose(page, png());
  await output(page).selectOption('webp');
  await choose(page, png('zweites.png'));
  await expect(action(page, 'Weitere Dateien hinzufügen')).toBeVisible();
  await expect(output(page)).toHaveValue('webp');
  await remove(page, 1).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(output(page)).toHaveValue('webp');
  await remove(page).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(picker(page)).toBeFocused();
  await expect(page.locator('.drop-zone')).toHaveCount(1);
});

test('Browser-Zurück und Vor bewahren sekundäres Werkzeug und persistente Dateiliste', async ({ page }) => {
  await open(page);
  await choose(page, png());
  await output(page).selectOption('webp');
  await action(page, 'Komprimieren').click();
  await expect(page).toHaveURL(/#bilder-komprimieren$/);
  await page.goBack();
  await expect(heading(page)).toBeVisible();
  await expect(output(page)).toHaveValue('webp');
  await expect(page).toHaveURL(/\/$/);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Bilder komprimieren', exact: true })).toBeVisible();
  await expect(rows(page)).toContainText('beispiel.png');
});

test('Ablegen per Drag and Drop ergänzt dieselbe Liste wie die Auswahl ohne Upload', async ({ page }) => {
  const { uploads } = await open(page);
  const data = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'abgelegt.png', { type: 'image/png' }));
    return transfer;
  }, [...PNG]);
  await page.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: data });
  await expect(rows(page)).toContainText('abgelegt.png');
  await expect(rows(page)).toContainText('PNG');
  await expect(output(page)).toBeEnabled();
  await choose(page, png());
  await expect(rows(page)).toHaveCount(2);
  await expect(output(page, 1).locator('option')).toHaveText(await output(page).locator('option').allTextContents());
  await expect(page).toHaveURL(/\/$/);
  expect(uploads).toEqual([]);
});

test('Ablegen mehrerer Dateien gleichzeitig ergänzt die Liste, Unbekanntes blockiert nicht', async ({ page }) => {
  const { uploads } = await open(page);
  const dropped = [png('eins.png'), pdf('zwei.pdf'), text('drei.txt')];
  const data = await page.evaluateHandle((items) => {
    const transfer = new DataTransfer();
    for (const item of items) transfer.items.add(new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType }));
    return transfer;
  }, dropped.map((file) => ({ name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] })));
  await page.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: data });
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText('eins.png');
  await expect(rows(page).nth(1)).toContainText('zwei.pdf');
  await expect(rows(page).nth(2)).toContainText('Dateityp nicht erkannt oder nicht unterstützt');
  await expect(output(page, 0)).toBeEnabled();
  expect(uploads).toEqual([]);
});

test('Tastatur: Auswahl, Ausgabe, Start und Entfernen funktionieren ohne Maus', async ({ page }) => {
  const { uploads } = await open(page);
  await picker(page).focus();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(png());
  await expect(heading(page)).toBeFocused();
  await expect(output(page)).toBeEnabled();
  await output(page).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(output(page)).toHaveValue('png');
  await expect(remove(page)).toBeFocused();
  await action(page, 'Konvertieren').focus();
  expect(uploads).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(rows(page).getByRole('status')).toHaveText('Fertig');
  await expect(rows(page).getByRole('link', { name: /Download/ })).toBeVisible();
  await remove(page).focus();
  await page.keyboard.press('Space');
  await expect(picker(page)).toBeFocused();
  expect(uploads).toHaveLength(1);
});

test('Datenschutz: nichts in Web Storage, IndexedDB oder Cache, keine fremden Hosts', async ({ page }) => {
  const { uploads } = await open(page);
  const hosts: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== new URL(page.url()).origin) hosts.push(request.url());
  });
  await choose(page, [png(), pdf()]);
  await output(page).selectOption('webp');
  await action(page, 'Komprimieren').click();
  await expect(rows(page)).toHaveCount(1);
  await back(page).click();
  expect(uploads).toEqual([]);
  await action(page, 'Konvertieren').click();
  await expect(rows(page).nth(0).getByRole('link', { name: /Download/ })).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(await storageWrites(page)).toEqual([]);
  expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
  expect(hosts).toEqual([]);
  // Die lazy geladenen Werkzeugchunks laufen unter der strengen CSP ohne Verletzung.
  expect(await cspViolations(page)).toEqual([]);
});

{
  for (const width of [390, 1440]) {
    test(`axe: Auswahl, direkte Ausgabe und Ergebnis ohne Verstöße (${width} px)`, async ({ page }) => {
      await open(page, { width });
      expect((await axe(page)).violations).toEqual([]);
      await choose(page, [png(`${'langer-name-'.repeat(12)}.png`), pdf(), text()]);
      await expect(output(page)).toBeEnabled();
      expect((await axe(page)).violations).toEqual([]);
      await action(page, 'Konvertieren').click();
      await expect(rows(page).nth(0).getByRole('link', { name: /Download/ })).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  }
}
