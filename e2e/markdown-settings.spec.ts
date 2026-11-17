import { Buffer } from 'node:buffer';
import { expect, test, type Request } from '@playwright/test';

// API-Doubles belegen Einstellungen und gesendete Optionen, keine echte PDF-Erzeugung.

function job() {
  const now = new Date().toISOString();
  return {
    id: 'markdown-job', tool: 'markdown-pdf', state: 'succeeded', phase: null, progress: null, analysis: null, error: null, cancelRequested: false,
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(),
    input: { name: 'dokument.md', format: 'markdown', size: 10, width: null, height: null },
    results: [{ id: 'result', level: null, state: 'succeeded', size: 1200, mime: 'application/pdf', downloadName: 'dokument.pdf',
      downloadUrl: '/api/v1/jobs/markdown-job/results/result', details: { pageCount: 2 }, error: null }],
  };
}

function optionsOf(request: Request): Record<string, unknown> {
  const body = request.postDataBuffer()!.toString('latin1');
  return JSON.parse(/name="options"\r\n\r\n(.*?)\r\n/s.exec(body)![1]!) as Record<string, unknown>;
}

test('Seitenformat und Ausrichtung werden gesendet und im Ergebnis genannt', async ({ page }) => {
  await page.route('**/api/v1/capabilities', route => route.fulfill({ json: {
    tools: ['markdown-pdf'], markdown: { available: true, maxFileBytes: 2097152, maxOutputBytes: 20971520, maxPages: 300 },
    image: { inputFormats: ['png'], outputFormats: ['png'], maxFileBytes: 1, maxPixels: 1, maxEdge: 1 },
    pdf: { maxFileBytes: 1 }, jobs: { ttlSeconds: 3600, maxActivePerSession: 3, maxBatchFiles: 30 },
  } }));
  await page.route('**/api/v1/session', route => route.fulfill({ json: { csrfToken: 'markdown-test' } }));
  await page.route('**/api/v1/jobs/*', route => route.fulfill({ status: 204 }));
  const requests: Request[] = [];
  await page.route('**/api/v1/jobs', route => { requests.push(route.request()); return route.fulfill({ status: 202, json: job() }); });
  await page.goto('/pdf/markdown');
  await expect(page.getByRole('button', { name: 'Dateien auswählen', exact: true })).toBeEnabled();
  await expect(page.getByRole('radio', { name: 'A4', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Hochformat', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'US Letter', exact: true }).check();
  await page.getByRole('radio', { name: 'Querformat', exact: true }).check();
  await page.locator('input[type=file]').setInputFiles({ name: 'dokument.md', mimeType: 'text/markdown', buffer: Buffer.from('# Titel\n') });
  await page.getByRole('button', { name: 'PDF erstellen', exact: true }).click();
  const result = page.locator('.file-row').getByRole('group', { name: 'Ergebnis', exact: true });
  await expect(result).toContainText('US Letter-Querformat');
  expect(requests).toHaveLength(1);
  expect(optionsOf(requests[0]!)).toEqual({ tool: 'markdown-pdf', pageSize: 'letter', orientation: 'landscape' });
});
