import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Startseite: Dateien ablegen, Typ lokal erkennen, Aktion wählen, Werkzeug mit der Datei öffnen.
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
async function open(page: Page, { width = 1440, theme = 'dark' as 'dark' | 'light' } = {}) {
  const uploads: string[] = [];
  await page.addInitScript((value) => {
    if (value === 'light') localStorage.setItem('mi-theme', 'light');
    const audit = { storage: [] as string[], csp: [] as string[] };
    document.addEventListener('securitypolicyviolation', (event) => audit.csp.push(`${event.violatedDirective}: ${event.blockedURI}; ${event.sourceFile}:${event.lineNumber}; ${event.sample}`));
    Object.assign(window, { __audit: audit });
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, item) { if (key !== 'mi-theme') audit.storage.push(`storage:${key}`); return set.call(this, key, item); };
    const idb = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<typeof indexedDB.open>) => { audit.storage.push('indexedDB'); return idb(...args); };
    if ('caches' in window) {
      const cacheOpen = caches.open.bind(caches);
      caches.open = (name) => { audit.storage.push('cache'); return cacheOpen(name); };
    }
  }, theme);
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/capabilities', (route) => route.fulfill({ json: capabilities }));
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: { csrfToken: 'quickstart-test' } }));
  await page.route('**/api/v1/jobs', (route) => { uploads.push(route.request().method()); return route.fulfill({ status: 500 }); });
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

test('Auswahl zeigt Titel, eine Dropzone und höchstens eine Textlinkliste statt Karten', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Dateien umwandeln', exact: true })).toBeVisible();
  await expect(picker(page)).toHaveAccessibleDescription(/Bilder, PDF und Audio.*hochgeladen wird erst/s);
  await expect(page.locator('.drop-zone')).toHaveCount(1);
  const links = page.getByRole('navigation', { name: 'Werkzeuge im Überblick' }).getByRole('link');
  await expect(links).toHaveText(['Bilder konvertieren', 'Bilder komprimieren', 'Bilder skalieren', 'PDF komprimieren', 'Audio konvertieren']);
  await expect(page.locator('.card, .card-link, .tool-card')).toHaveCount(0);
  const accept = await page.locator('input[type=file]').getAttribute('accept');
  for (const part of ['.png', '.pdf', 'application/pdf', '.mp3', '.flac']) expect(accept).toContain(part);
});

test('Bild: Aktionen erscheinen, Komprimieren öffnet das Werkzeug mit der Datei ohne Upload', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, png());
  await expect(page.getByRole('heading', { level: 1, name: 'Was soll passieren?' })).toBeFocused();
  await expect(page.getByRole('listitem').filter({ hasText: 'beispiel.png (Bild)' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('noch nichts hochgeladen');
  await expect(action(page, 'Konvertieren')).toBeVisible();
  await expect(action(page, 'Komprimieren')).toBeVisible();
  await expect(action(page, 'Skalieren')).toBeVisible();
  await expect(action(page, 'Andere Dateien')).toBeVisible();
  await action(page, 'Komprimieren').click();
  await expect(page).toHaveURL(/\/#bilder-komprimieren$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Bilder komprimieren' })).toBeVisible();
  await expect(page.getByRole('button', { name: '← Andere Dateien' })).toBeVisible();
  const row = page.locator('.file-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('beispiel.png');
  // Dieselbe Vorprüfung wie bei der eigenen Dropzone: danach ist die Datei bereit.
  await expect(action(page, 'Komprimieren')).toBeEnabled();
  expect(uploads).toEqual([]);
  expect(await storageWrites(page)).toEqual([]);
});

test('Bild: Konvertieren und Skalieren öffnen ihr Werkzeug mit der Datei', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, png());
  await action(page, 'Konvertieren').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bilder konvertieren' })).toBeVisible();
  await expect(page.locator('.file-row')).toContainText('beispiel.png');
  await expect(page.getByLabel('Zielformat')).toBeVisible();
  await page.getByRole('button', { name: '← Andere Dateien' }).click();
  await choose(page, png('zweites.png'));
  await action(page, 'Skalieren').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bilder skalieren' })).toBeVisible();
  await expect(page.locator('.file-row')).toContainText('zweites.png');
  expect(uploads).toEqual([]);
});

test('PDF: nur Komprimieren, das Werkzeug zeigt die Datei, kein Upload vor dem Start', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, pdf());
  await expect(page.getByRole('main')).toContainText('PDF');
  await expect(action(page, 'Komprimieren')).toBeVisible();
  await expect(action(page, 'Konvertieren')).toHaveCount(0);
  await expect(action(page, 'Skalieren')).toHaveCount(0);
  await action(page, 'Komprimieren').click();
  await expect(page).toHaveURL(/\/#pdf-komprimieren$/);
  await expect(page.getByRole('heading', { level: 1, name: 'PDF komprimieren' })).toBeVisible();
  await expect(page.getByText('Ausgewählte PDF')).toBeVisible();
  await expect(page.getByText('beispiel.pdf', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Komprimieren', exact: true })).toBeEnabled();
  expect(uploads).toEqual([]);
});

test('Audio: nur Konvertieren, das Werkzeug zeigt die Datei, kein Upload vor dem Start', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, wav());
  await expect(page.getByRole('main')).toContainText('Audio');
  await expect(action(page, 'Konvertieren')).toBeVisible();
  await expect(action(page, 'Komprimieren')).toHaveCount(0);
  await action(page, 'Konvertieren').click();
  await expect(page).toHaveURL(/\/#audio-konvertieren$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Audio konvertieren' })).toBeVisible();
  await expect(page.locator('.file-row')).toContainText('ton.wav');
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeEnabled();
  expect(uploads).toEqual([]);
});

test('Typ folgt der Signatur, nicht der Endung', async ({ page }) => {
  await open(page);
  await choose(page, { ...png('foto.pdf') });
  await expect(action(page, 'Skalieren')).toBeVisible();
});

test('Unbekannter Typ: verständliche Meldung, keine Aktion außer Andere Dateien', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, text());
  await expect(page.getByRole('heading', { level: 1, name: 'Dateityp nicht erkannt' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Unterstützt werden Bilder, PDF und Audio');
  await expect(page.getByRole('status').filter({ hasText: 'notiz.txt' })).toBeVisible();
  for (const name of ['Konvertieren', 'Komprimieren', 'Skalieren']) await expect(action(page, name)).toHaveCount(0);
  await action(page, 'Andere Dateien').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dateien umwandeln' })).toBeVisible();
  expect(uploads).toEqual([]);
});

test('Gemischte Typen: Aktionen je Gruppe, das Werkzeug erhält nur die Dateien der Gruppe', async ({ page }) => {
  const { uploads } = await open(page);
  await choose(page, [png(), pdf(), text()]);
  await expect(page.getByRole('main')).toContainText('verschiedenen Typen');
  await expect(page.getByRole('region', { name: /Bild, 1 Datei/ })).toBeVisible();
  await expect(page.getByRole('region', { name: /PDF, 1 Datei/ })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('1 Datei nicht erkannt und nicht übernommen');
  await page.getByRole('region', { name: /PDF, 1 Datei/ }).getByRole('button', { name: 'Komprimieren' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'PDF komprimieren' })).toBeVisible();
  await expect(page.getByText('beispiel.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('beispiel.png')).toHaveCount(0);
  expect(uploads).toEqual([]);
});

test('Andere Dateien setzt aus Auswahl und Werkzeug zurück und gibt den Fokus an die Dropzone', async ({ page }) => {
  await open(page);
  await choose(page, png());
  await action(page, 'Andere Dateien').click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dateien umwandeln' })).toBeVisible();
  await expect(picker(page)).toBeFocused();
  await choose(page, png());
  await action(page, 'Komprimieren').click();
  await expect(page.locator('.file-row')).toHaveCount(1);
  await page.getByRole('button', { name: '← Andere Dateien' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dateien umwandeln' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(picker(page)).toBeFocused();
  await expect(page.locator('.file-row')).toHaveCount(0);
});

test('Browser-Zurück führt vom Werkzeug zur Auswahl, Vor zurück zum Werkzeug', async ({ page }) => {
  await open(page);
  await choose(page, png());
  await action(page, 'Komprimieren').click();
  await expect(page).toHaveURL(/#bilder-komprimieren$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Was soll passieren?' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Bilder komprimieren' })).toBeVisible();
  await expect(page.locator('.file-row')).toContainText('beispiel.png');
});

test('Ablegen per Drag and Drop erkennt die Datei wie die Auswahl', async ({ page }) => {
  const { uploads } = await open(page);
  const data = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'abgelegt.png', { type: 'image/png' }));
    return transfer;
  }, [...PNG]);
  await page.locator('.drop-zone').dispatchEvent('drop', { dataTransfer: data });
  await expect(page.getByRole('listitem').filter({ hasText: 'abgelegt.png (Bild)' })).toBeVisible();
  await expect(action(page, 'Komprimieren')).toBeVisible();
  expect(uploads).toEqual([]);
});

test('Tastatur: Auswahl öffnen, Aktion wählen, zurück zur Dropzone', async ({ page }) => {
  const { uploads } = await open(page);
  await picker(page).focus();
  await expect(picker(page)).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(png());
  await expect(page.getByRole('heading', { level: 1, name: 'Was soll passieren?' })).toBeFocused();
  await action(page, 'Konvertieren').focus();
  await page.keyboard.press('Tab');
  await expect(action(page, 'Komprimieren')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Bilder komprimieren' })).toBeFocused();
  await page.getByRole('button', { name: '← Andere Dateien' }).focus();
  await page.keyboard.press('Space');
  await expect(picker(page)).toBeFocused();
  expect(uploads).toEqual([]);
});

test('Datenschutz: nichts in Web Storage, IndexedDB oder Cache, keine fremden Hosts', async ({ page }) => {
  await open(page);
  const hosts: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== new URL(page.url()).origin) hosts.push(request.url());
  });
  await choose(page, [png(), pdf()]);
  await action(page, 'Komprimieren').first().click();
  await expect(page.locator('.file-row')).toHaveCount(1);
  expect(await storageWrites(page)).toEqual([]);
  expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
  expect(hosts).toEqual([]);
  // Die lazy geladenen Werkzeugchunks laufen unter der strengen CSP ohne Verletzung.
  expect(await cspViolations(page)).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`axe: Auswahl, Erkennung und Werkzeug ohne Verstöße (${theme}, ${width} px)`, async ({ page }) => {
      await open(page, { width, theme });
      if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect((await axe(page)).violations).toEqual([]);
      await choose(page, [png(), pdf(), text()]);
      await expect(page.getByRole('heading', { level: 1, name: 'Was soll passieren?' })).toBeVisible();
      expect((await axe(page)).violations).toEqual([]);
      await page.getByRole('region', { name: /Bild, 1 Datei/ }).getByRole('button', { name: 'Komprimieren' }).click();
      await expect(page.locator('.file-row')).toContainText('beispiel.png');
      await expect(action(page, 'Komprimieren')).toBeEnabled();
      expect((await axe(page)).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  }
}
