import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readdir, readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const tools = [
  { path: '/bilder/konvertieren', action: 'Konvertieren', pdf: false },
  { path: '/bilder/komprimieren', action: 'Komprimieren', pdf: false },
  { path: '/bilder/skalieren', action: 'Skalieren', pdf: false },
  { path: '/pdf/komprimieren', action: '', pdf: true },
] as const;

// Worker realms do not inherit addInitScript hooks. Audit their entire processing
// source tree separately; runtime hooks below cover the document realm only.
test('Verarbeitungscode enthaelt keine Netzwerk- oder Speicher-APIs', async () => {
  const forbidden = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\s*\(|\b(?:localStorage|sessionStorage|indexedDB|caches)\s*[.[]/;
  for (const directory of ['src/lib/image', 'src/lib/pdf']) {
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.ts')) continue;
      const source = (await readFile(`${directory}/${file}`, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(source, `${directory}/${file}: keine direkten Netzwerk-/Speicheraufrufe`).not.toMatch(forbidden);
    }
  }
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const audit = { created: [] as string[], revoked: [] as string[], storage: [] as string[], csp: [] as string[], phase: 'navigation' };
    Object.assign(window, { __audit: audit });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); audit.created.push(url); return url; };
    URL.revokeObjectURL = url => { audit.revoked.push(url); revoke(url); };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { audit.storage.push('storage'); return set.call(this, key, value); };
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args: Parameters<typeof indexedDB.open>) => { audit.storage.push('indexedDB'); return open(...args); };
    if ('caches' in window) {
      const cacheOpen = caches.open.bind(caches);
      caches.open = name => { audit.storage.push('cache'); return cacheOpen(name); };
    }
    document.addEventListener('securitypolicyviolation', event => audit.csp.push(`${audit.phase}: ${event.violatedDirective}: ${event.blockedURI}; ${event.sourceFile}:${event.lineNumber}; ${event.sample}`));
  });
}

function observeNetwork(context: BrowserContext, page: Page) {
  const requests: { url: string; method: string; type: string }[] = [];
  const sockets: string[] = [];
  // Context sees requests across document and worker contexts. Register before navigation.
  context.on('request', request => requests.push({ url: request.url(), method: request.method(), type: request.resourceType() }));
  page.on('websocket', socket => sockets.push(socket.url()));
  return { requests, sockets };
}

async function fixture(page: Page, pdf: boolean) {
  const name = 'privater-dateiname-mit-sehr-langem-namen-' + 'abcdefghij-'.repeat(12);
  if (pdf) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage().drawText('Lokaler Datenschutztest', { font });
    return { name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) };
  }
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 24);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return { name: `${name}.png`, mimeType: 'image/png', buffer: Buffer.from(png) };
}

for (const tool of tools) {
  test(`${tool.path}: Verarbeitung lokal, Ergebnis-URLs freigegeben`, async ({ page, context, baseURL, browserName }) => {
    await instrument(page);
    const network = observeNetwork(context, page);
    await page.goto(tool.path);
    const picker = page.locator('button').filter({ hasText: tool.pdf ? /^PDF auswählen$/ : /^Dateien auswählen$/ });
    const unsupported = page.getByText(/^Dieser Browser unterstützt die lokale PDF-Komprimierung nicht vollständig\./).first();
    await expect(picker).toBeEnabled();
    await page.evaluate(() => { (window as unknown as { __audit: { phase: string } }).__audit.phase = 'fixture'; });
    const input = await fixture(page, tool.pdf);
    const before = network.requests.length;
    await page.evaluate(() => { (window as unknown as { __audit: { phase: string } }).__audit.phase = 'select'; });
    await page.locator('input[type=file]').setInputFiles(input);
    await page.evaluate(() => { const audit = (window as unknown as { __audit?: { phase: string } }).__audit; if (audit) audit.phase = 'process'; });
    if (!tool.pdf) await page.getByRole('button', { name: tool.action, exact: true }).click();
    if (tool.pdf) await expect(page.locator('a[download]').first().or(unsupported)).toBeVisible({ timeout: 60_000 });
    else await expect(page.locator('a[download]').first()).toBeVisible({ timeout: 60_000 });
    const hasResults = !tool.pdf || !(await unsupported.isVisible());
    if (!hasResults) await expect(page.locator('a[download]')).toHaveCount(0);
    else if (tool.pdf) await expect(page.locator('a[download]')).toHaveCount(3, { timeout: 60_000 });
    const firstUrl = hasResults ? await page.locator('a[download]').first().getAttribute('href') : null;
    if (!tool.pdf) {
      await page.getByRole('button', { name: tool.action, exact: true }).click();
      await expect(page.locator('a[download]').first()).not.toHaveAttribute('href', firstUrl!);
    }
    await page.getByRole('button', { name: /Alle entfernen|Zurücksetzen|Neue PDF/ }).click();
    await expect(page.locator('a[download]')).toHaveCount(0);
    const audit = await page.evaluate(() => (window as unknown as { __audit: {
      created: string[]; revoked: string[]; storage: string[]; csp: string[];
    } }).__audit);
    expect(audit.created.length).toBeGreaterThanOrEqual(hasResults ? 1 : 0);
    expect(audit.created.every(url => audit.revoked.includes(url))).toBe(true);
    expect(audit.storage).toEqual([]);
    // WebKit's native <select> emits this event even in minimal script-free HTML.
    // No JS style setter is involved. Keep all other violations fatal and prohibit
    // actual inline style attributes in the application DOM below.
    const violations = browserName === 'webkit'
      ? audit.csp.filter(event => !/^(navigation|fixture|select|process): style-src-attr: inline; :1; $/.test(event))
      : audit.csp;
    expect(violations).toEqual([]);
    await expect(page.locator('[style]')).toHaveCount(0);
    expect(network.sockets).toEqual([]);
    for (const request of network.requests.slice(before)) {
      const url = new URL(request.url);
      expect(url.origin).toBe(new URL(baseURL!).origin);
      expect(request.method).toBe('GET');
      // WebKit reports native bitmap blob reads and module-worker loading as xhr.
      // Blob URLs still resolve to this document's origin and never leave the device.
      if (url.protocol === 'blob:') {
        expect(browserName).toBe('webkit');
        expect(request.type).toBe('xhr');
        continue;
      }
      if (browserName === 'webkit' && request.type === 'xhr') {
        expect(url.pathname).toMatch(/^\/_astro\/worker-[\w-]+\.js$/);
      } else {
        expect(['script', 'other']).toContain(request.type);
      }
      expect(url.pathname).toMatch(/^\/_astro\/[^/]+\.js$/);
      expect(url.search).toBe('');
      expect(decodeURIComponent(request.url)).not.toContain(input.name);
    }
  });

  test(`${tool.path}: Tastatur und mobile Ergebnisse mit langem Dateinamen`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(tool.path);
    const picker = page.locator('button').filter({ hasText: tool.pdf ? /^PDF auswählen$/ : /^Dateien auswählen$/ });
    const unsupported = page.getByText(/^Dieser Browser unterstützt die lokale PDF-Komprimierung nicht vollständig\./).first();
    await expect(picker).toBeEnabled();
    let reached = false;
    for (let i = 0; i < 30 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await picker.evaluate(element => element === document.activeElement);
    }
    expect(reached, 'Dateiauswahl ist per Tab erreichbar').toBe(true);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(await fixture(page, tool.pdf));
    await page.evaluate(() => { const audit = (window as unknown as { __audit?: { phase: string } }).__audit; if (audit) audit.phase = 'process'; });
    if (!tool.pdf) await page.getByRole('button', { name: tool.action, exact: true }).click();
    if (tool.pdf) await expect(page.locator('a[download]').first().or(unsupported)).toBeVisible({ timeout: 60_000 });
    else await expect(page.locator('a[download]').first()).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await expect(page.locator('[style]')).toHaveCount(0);
  });
}
