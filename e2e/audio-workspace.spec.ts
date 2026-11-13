import { Buffer } from 'node:buffer';
import { expect, test, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// API-Doubles belegen Ablauf und Darstellung des Audiowerkzeugs, keine echte Kodierung.

/** Kleine WAV-Datei: RIFF-Kopf plus 16-Bit-PCM (Sinus). */
function wav(name = 'ton.wav', { seconds = 0.1, rate = 8000, channels = 1 } = {}) {
  const frames = Math.round(seconds * rate);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / rate) * 12000);
    for (let channel = 0; channel < channels; channel++) buffer.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
  }
  return { name, mimeType: 'audio/wav', buffer };
}

const audioCapabilities = {
  inputFormats: ['mp3', 'wav', 'flac', 'ogg'], outputFormats: ['mp3', 'wav', 'flac', 'ogg'], qualityFormats: ['mp3', 'ogg'],
  defaultQuality: 0.8, maxFileBytes: 104857600, maxDurationSeconds: 1800, maxChannels: 8, maxSampleRate: 192000, maxOutputBytes: 419430400,
};

async function prepare(page: Page, { width = 1440, audio = audioCapabilities as Record<string, unknown> | null } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    tools: audio ? ['image-convert', 'image-compress', 'image-resize', 'pdf-compress', 'audio-convert'] : ['image-convert'],
    image: { inputFormats: ['png'], outputFormats: ['jpeg', 'png', 'webp', 'bmp', 'ico'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
    pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
    ...(audio ? { audio } : {}),
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'audio-test' } }));
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ status: 204 }));
  await page.goto('/audio/konvertieren');
  if (audio) await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
}

type Details = { format: string; durationSeconds: number; sampleRate: number; channels: number; qualityApplied: boolean };

function succeeded(details: Details = { format: 'mp3', durationSeconds: 65.4, sampleRate: 44100, channels: 2, qualityApplied: true }, size = 40) {
  const extension = details.format;
  return {
    id: 'audio-job', tool: 'audio-convert', state: 'succeeded', phase: null, progress: null, analysis: null, error: null, cancelRequested: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    input: { name: 'ton.wav', format: 'wav', size: 1644, width: null, height: null },
    results: [{
      id: 'result', level: null, state: 'succeeded', size, mime: 'audio/mpeg', downloadName: `ton.${extension}`,
      downloadUrl: '/api/v1/jobs/audio-job/results/result', details, error: null,
    }],
  };
}

function failed(code: string) {
  return {
    ...succeeded(), state: 'failed', error: { code },
    results: [{ id: 'result', level: null, state: 'failed', size: null, mime: 'audio/mpeg', downloadName: 'ton.mp3', downloadUrl: null, details: null, error: { code } }],
  };
}

/** Optionen aus dem Multipart-Body eines Uploads. */
function optionsOf(request: Request): Record<string, unknown> {
  const body = request.postDataBuffer()!.toString('latin1');
  const match = /name="options"\r\n\r\n(.*?)\r\n/s.exec(body);
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

const axe = (page: Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
const hideToolbar = 'astro-dev-toolbar { display: none !important; }';

test('320 px: Auswahl lädt nichts hoch, ist beschrieben und gibt den Fokus nach dem Entfernen weiter', async ({ page }, testInfo) => {
  await prepare(page, { width: 320 });
  let uploads = 0;
  await page.route('**/api/v1/jobs', route => { uploads++; return route.fulfill({ status: 500 }); });
  const picker = page.getByRole('button', { name: 'Dateien auswählen', exact: true });
  await expect(picker).toHaveAccessibleDescription(/Formate: MP3, WAV, FLAC und OGG.*Höchstens 30 Dateien, je bis 104,9.MB und 30.Minuten/s);
  const accept = await page.locator('input[type=file]').getAttribute('accept');
  for (const part of ['.mp3', '.wav', '.flac', '.ogg', 'audio/mpeg', 'audio/wav', 'audio/flac', 'audio/ogg']) expect(accept).toContain(part);
  const longName = `${'Sehr-langer-Audiodateiname-ohne-Kuerzung-'.repeat(4)}.wav`;
  await page.locator('input[type=file]').setInputFiles([wav(longName), wav()]);
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeEnabled();
  await expect(page.locator('.file-row').first()).toContainText('Original: WAV');
  expect(uploads).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('audio-auswahl-320.png'), fullPage: true, style: hideToolbar });
  await page.getByRole('button', { name: `Datei ${longName} entfernen`, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Datei ton.wav entfernen', exact: true })).toBeFocused();
  await expect(page.getByTestId('live-region')).toHaveText(`Datei ${longName} entfernt.`);
  await page.getByRole('button', { name: 'Datei ton.wav entfernen', exact: true }).click();
  await expect(picker).toBeFocused();
});

test('1440 px: ausdrücklicher Start sendet Optionen, Ergebnis zeigt Original, Ergebnis und Download', async ({ page }, testInfo) => {
  await prepare(page);
  const requests: Request[] = [];
  await page.route('**/api/v1/jobs', route => { requests.push(route.request()); return route.fulfill({ status: 202, json: succeeded() }); });
  await page.locator('input[type=file]').setInputFiles(wav());
  await expect(page.getByLabel('Zielformat', { exact: true })).toHaveValue('mp3');
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  const row = page.locator('.file-row');
  await expect(row.getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(optionsOf(requests[0]!)).toEqual({ tool: 'audio-convert', format: 'mp3', channels: 'original', quality: 0.8 });
  const original = row.getByRole('group', { name: 'Original', exact: true });
  await expect(original).toContainText('WAV');
  await expect(original).toContainText('Größe');
  const result = row.getByRole('group', { name: 'Ergebnis', exact: true });
  for (const text of ['MP3', '01:05', '44,1 kHz', 'Stereo', 'Größe']) await expect(result).toContainText(text);
  await expect(row.locator('a[download]')).toHaveAttribute('download', 'ton.mp3');
  await expect(row.locator('.file-result time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
  await expect(page.getByTestId('live-region')).toHaveText('Konvertierung abgeschlossen: 1 von 1 fertig.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('audio-ergebnis-1440.png'), fullPage: true, style: hideToolbar });
  // Einstellungen nach dem Ergebnis ändern: Hinweis, dass die Ergebnisse veraltet sind.
  await page.getByLabel('Zielformat', { exact: true }).selectOption('flac');
  await expect(page.getByText(/Die Einstellungen wurden geändert/)).toBeVisible();
});

test('Qualität erscheint nur bei MP3 und OGG und wird nur dort gesendet', async ({ page }) => {
  await prepare(page);
  const requests: Request[] = [];
  await page.route('**/api/v1/jobs', route => { requests.push(route.request()); return route.fulfill({ status: 202, json: succeeded() }); });
  const select = page.getByLabel('Zielformat', { exact: true });
  const slider = page.getByRole('slider', { name: 'Qualität' });
  await expect(slider).toHaveValue('80');
  await expect(slider).toHaveAccessibleDescription(/größere Dateien/);
  await select.selectOption('ogg');
  await expect(slider).toBeVisible();
  for (const format of ['wav', 'flac']) {
    await select.selectOption(format);
    await expect(slider).toHaveCount(0);
  }
  await page.locator('input[type=file]').setInputFiles(wav());
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('a[download]')).toHaveCount(1);
  expect(optionsOf(requests[0]!)).toEqual({ tool: 'audio-convert', format: 'flac', channels: 'original' });
  await select.selectOption('ogg');
  await slider.fill('35');
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(optionsOf(requests[1]!)).toEqual({ tool: 'audio-convert', format: 'ogg', channels: 'original', quality: 0.35 });
});

test('Mono wird gesendet und im Ergebnis angezeigt; gleiches Format erhält „-konvertiert“', async ({ page }) => {
  await prepare(page);
  const requests: Request[] = [];
  await page.route('**/api/v1/jobs', route => {
    requests.push(route.request());
    return route.fulfill({ status: 202, json: succeeded({ format: 'wav', durationSeconds: 0.1, sampleRate: 8000, channels: 1, qualityApplied: false }, 1644) });
  });
  const channels = page.getByRole('group', { name: 'Kanäle', exact: true });
  await expect(channels).toHaveAccessibleDescription(/Mono mischt alle Kanäle/);
  await expect(channels.getByRole('radio', { name: 'Wie im Original' })).toBeChecked();
  await channels.getByRole('radio', { name: 'Mono' }).check();
  await page.getByLabel('Zielformat', { exact: true }).selectOption('wav');
  await page.locator('input[type=file]').setInputFiles(wav('stereo.wav', { channels: 2 }));
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  const result = page.locator('.file-row').getByRole('group', { name: 'Ergebnis', exact: true });
  await expect(result).toContainText('Mono');
  await expect(result).toContainText('00:01');
  await expect(result).toContainText('8 kHz');
  expect(optionsOf(requests[0]!)).toEqual({ tool: 'audio-convert', format: 'wav', channels: 'mono' });
  await expect(page.locator('a[download]')).toHaveAttribute('download', 'stereo-konvertiert.wav');
});

const processingErrors: readonly [string, RegExp][] = [
  ['duration-too-long', /zu lang.*30.Minuten/],
  ['unsupported-audio', /8 Kanäle.*192.kHz.*Mono/],
  ['decode-failed', /beschädigt/],
  ['result-too-large', /größer als erlaubt.*419,4.MB/],
  ['timeout', /Zeitlimit/],
];

for (const [code, message] of processingErrors) {
  test(`Verarbeitungsfehler ${code} erscheint deutsch an der Datei`, async ({ page }) => {
    await prepare(page);
    await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: failed(code) }));
    await page.locator('input[type=file]').setInputFiles(wav());
    await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
    const row = page.locator('.file-row[data-status="error"]');
    await expect(row.locator('.field-error')).toContainText(message);
    await expect(page.locator('a[download]')).toHaveCount(0);
    await expect(page.getByTestId('live-region')).toHaveText('Konvertierung abgeschlossen: 0 von 1 fertig, 1 mit Fehler.');
  });
}

for (const [status, code, message] of [[415, 'unsupported-type', /keine unterstützte Audiodatei/], [413, 'file-too-large', /zu groß.*104,9.MB/]] as const) {
  test(`Annahmefehler ${status} ${code} erscheint deutsch an der Datei`, async ({ page }) => {
    await prepare(page);
    await page.route('**/api/v1/jobs', route => route.fulfill({ status, json: { error: { code } } }));
    await page.locator('input[type=file]').setInputFiles(wav());
    await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
    await expect(page.locator('.file-row[data-status="error"] .field-error')).toContainText(message);
  });
}

test('Vorprüfung lehnt fremde Signaturen, M4A und zu große Dateien ohne Upload ab', async ({ page }) => {
  await prepare(page, { audio: { ...audioCapabilities, maxFileBytes: 2000 } });
  let uploads = 0;
  await page.route('**/api/v1/jobs', route => { uploads++; return route.fulfill({ status: 500 }); });
  await expect(page.getByText(/Erst nach ausdrücklichem Start/)).toBeVisible();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'kaputt.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('kein Audio') },
    { name: 'memo.m4a', mimeType: 'audio/mp4', buffer: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ')]) },
    wav('lang.wav', { seconds: 1 }),
  ]);
  const rows = page.locator('.file-row');
  await expect(rows.filter({ hasText: 'Nicht verwendbar' })).toHaveCount(3);
  await expect(rows.nth(0).locator('.field-error')).toContainText('keine unterstützte Audiodatei');
  await expect(rows.nth(1).locator('.field-error')).toContainText('M4A- und AAC-Dateien werden nicht unterstützt');
  await expect(rows.nth(2).locator('.field-error')).toContainText('zu groß');
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeDisabled();
  await expect(page.getByTestId('live-region')).toHaveText('Prüfung abgeschlossen: 0 Dateien bereit, 3 Dateien nicht verwendbar.');
  expect((await axe(page)).violations).toEqual([]);
  expect(uploads).toBe(0);
});

test('Hinweise nennen Upload nach Start, Tags, Cover, M4A und Grenzen', async ({ page }) => {
  await prepare(page, { audio: { ...audioCapabilities, maxDurationSeconds: 600 } });
  const main = page.getByRole('main');
  await expect(main).toContainText('Erst nach ausdrücklichem Start werden Ihre Dateien auf den Server hochgeladen');
  await expect(main).toContainText('temporär gespeichert');
  await expect(main).toContainText('Tags und Metadaten');
  await expect(main).toContainText('Cover gehen');
  await expect(main).toContainText('M4A und AAC werden nicht unterstützt');
  await expect(main).toContainText(/höchstens 10.Minuten Spieldauer/);
});

test('Alle entfernen während der Verarbeitung verwirft Status und setzt den Fokus zurück', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/v1/jobs', route => route.fulfill({ status: 202, json: { ...succeeded(), state: 'queued', results: [] } }));
  await page.route('**/api/v1/jobs/audio-job', route => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 204 })
    : route.fulfill({ json: { ...succeeded(), state: 'running', phase: 'encode', results: [] } }));
  await page.locator('input[type=file]').setInputFiles(wav());
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('.file-row .badge')).toContainText('Wird verarbeitet');
  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.locator('.file-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
  await expect(page.getByTestId('live-region')).toHaveText('Alle Dateien entfernt.');
});

test('Server ohne Audiounterstützung sperrt Auswahl und Start mit Begründung', async ({ page }) => {
  await prepare(page, { audio: null });
  await expect(page.getByRole('alert')).toContainText('Der Verarbeitungsserver ist nicht verfügbar');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Konvertieren', exact: true })).toBeDisabled();
  await expect(page.getByText('Der Server unterstützt dieses Werkzeug nicht.', { exact: true })).toBeVisible();
});
