import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

// API-Doubles: belegen, wann „Alle als ZIP speichern“ erscheint und worauf es verweist.

function wav(name: string) {
  const buffer = Buffer.alloc(44 + 1600);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + 1600, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(1600, 40);
  return { name, mimeType: 'audio/wav', buffer };
}

const details = { format: 'mp3', durationSeconds: 0.1, sampleRate: 8000, channels: 1, qualityApplied: true };

function job(id: string, name: string) {
  return {
    id, tool: 'audio-convert', state: 'succeeded', phase: null, progress: null, analysis: null, error: null, cancelRequested: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    input: { name, format: 'wav', size: 1644, width: null, height: null },
    results: [{ id: `${id}-r`, level: null, state: 'succeeded', size: 40, mime: 'audio/mpeg', downloadName: name.replace('.wav', '.mp3'),
      downloadUrl: `/api/v1/jobs/${id}/results/${id}-r`, details, error: null }],
  };
}

async function prepare(page: Page) {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    tools: ['image-convert', 'audio-convert'],
    image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 52428800, maxPixels: 40000000, maxEdge: 16384 },
    pdf: { maxFileBytes: 100000000 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
    audio: { inputFormats: ['wav'], outputFormats: ['mp3', 'wav'], qualityFormats: ['mp3'], defaultQuality: 0.8, maxFileBytes: 104857600,
      maxDurationSeconds: 1800, maxChannels: 8, maxSampleRate: 192000, maxOutputBytes: 419430400 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'zip-test' } }));
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ status: 204 }));
  let uploads = 0;
  await page.route('**/api/v1/jobs', route => {
    const index = ++uploads;
    return route.fulfill({ status: 202, json: job(`job-${index}`, `ton${index}.wav`) });
  });
  await page.goto('/audio/konvertieren');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
}

test('ZIP-Link erscheint erst ab zwei fertigen Dateien und nennt alle Aufträge', async ({ page }) => {
  await prepare(page);
  const zip = page.getByRole('link', { name: 'Alle als ZIP speichern' });
  await page.locator('input[type=file]').setInputFiles(wav('ton1.wav'));
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(page.locator('.file-row').getByRole('link', { name: /Herunterladen/ })).toBeVisible();
  await expect(zip).toHaveCount(0);

  await page.getByRole('button', { name: 'Alle entfernen', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles([wav('ton2.wav'), wav('ton3.wav')]);
  await page.getByRole('button', { name: 'Konvertieren', exact: true }).click();
  await expect(zip).toBeVisible();
  const href = await zip.getAttribute('href');
  expect(href).toMatch(/^\/api\/v1\/jobs\/archive\?job_id=job-\d&job_id=job-\d$/);
  expect(await zip.getAttribute('download')).toBe('ergebnisse.zip');
});
