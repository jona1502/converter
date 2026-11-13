import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Echter Durchlauf gegen den vollständigen Stack (wie convert.spec.ts): ohne Backend schlägt er fehl.

/** WAV mit 16-Bit-PCM-Sinus, 44,1 kHz Stereo. */
function wav(name: string, seconds = 1, rate = 44100, channels = 2) {
  const frames = Math.round(seconds * rate);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
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

async function ready(page: Page) {
  await page.goto('/audio/konvertieren');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Zielformat', { exact: true })).toBeEnabled();
}

async function download(page: Page): Promise<{ name: string; bytes: Buffer }> {
  const event = page.waitForEvent('download');
  await page.getByRole('link', { name: /Herunterladen/ }).click();
  const file = await event;
  return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
}

test('WAV → MP3 und zurück → WAV in Mono mit echten Ergebnissen', async ({ page }) => {
  await ready(page);
  const action = page.getByRole('button', { name: 'Konvertieren', exact: true });
  const row = page.locator('.file-row');

  await page.locator('input[type=file]').setInputFiles(wav('sinus.wav'));
  await page.getByLabel('Zielformat', { exact: true }).selectOption('mp3');
  await action.click();
  await expect(row.getByRole('link', { name: /Herunterladen/ })).toBeVisible({ timeout: 60_000 });
  const mp3Result = row.getByRole('group', { name: 'Ergebnis', exact: true });
  await expect(mp3Result).toContainText('MP3');
  await expect(mp3Result).toContainText('00:01');
  await expect(mp3Result).toContainText('44,1 kHz');
  await expect(mp3Result).toContainText('Stereo');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  const mp3 = await download(page);
  expect(mp3.name).toBe('sinus.mp3');
  // ID3-Tag oder MPEG-Framesync am Anfang.
  expect(mp3.bytes.subarray(0, 3).toString('latin1') === 'ID3' || (mp3.bytes[0] === 0xff && (mp3.bytes[1]! & 0xe0) === 0xe0)).toBe(true);

  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'sinus.mp3', mimeType: 'audio/mpeg', buffer: mp3.bytes });
  await page.getByLabel('Zielformat', { exact: true }).selectOption('wav');
  await page.getByRole('group', { name: 'Kanäle', exact: true }).getByRole('radio', { name: 'Mono' }).check();
  await action.click();
  await expect(row.getByRole('link', { name: /Herunterladen/ })).toBeVisible({ timeout: 60_000 });
  const wavResult = row.getByRole('group', { name: 'Ergebnis', exact: true });
  await expect(wavResult).toContainText('WAV');
  await expect(wavResult).toContainText('Mono');
  await expect(row.getByRole('group', { name: 'Original', exact: true })).toContainText('MP3');
  const back = await download(page);
  expect(back.name).toBe('sinus.wav');
  expect(back.bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(back.bytes.subarray(8, 12).toString('latin1')).toBe('WAVE');
  expect(back.bytes.readUInt16LE(22)).toBe(1);
  expect(back.bytes.readUInt32LE(24)).toBe(44100);

  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeFocused();
});

test('Server lehnt beschädigte Audiodatei nach dem Start verständlich ab', async ({ page }) => {
  await ready(page);
  // Gültiger RIFF/WAVE-Kopf, aber ohne lesbare Formatangaben: Annahme ja, Dekodierung nein.
  const broken = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVE', 'latin1'), Buffer.from('kaputt'.repeat(20), 'latin1')]);
  await page.locator('input[type=file]').setInputFiles({ name: 'kaputt.wav', mimeType: 'audio/wav', buffer: broken });
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('.file-row[data-status="error"] .field-error')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('a[download]')).toHaveCount(0);
});
