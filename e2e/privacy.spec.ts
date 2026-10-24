import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { readdir, readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const tools = [
  { path: '/bilder/konvertieren', action: 'Konvertieren', pdf: false },
  { path: '/bilder/komprimieren', action: 'Komprimieren', pdf: false },
  { path: '/bilder/skalieren', action: 'Skalieren', pdf: false },
  { path: '/pdf/komprimieren', action: 'Komprimieren', pdf: true },
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
  test(`${tool.path}: Upload nur nach Start, API gleicher Origin und Löschung`, async ({page,context,baseURL,browserName})=>{
    await instrument(page);
    const network=observeNetwork(context,page);
    await page.goto(tool.path);
    const picker=page.getByRole('button',{name:tool.pdf?'PDF auswählen':'Dateien auswählen',exact:true});
    await expect(picker).toBeEnabled();
    const input=await fixture(page,tool.pdf);
    await page.locator('input[type=file]').setInputFiles(input);
    const action=page.getByRole('button',{name:tool.action,exact:true});
    await expect(action).toBeEnabled();
    expect(network.requests.filter(r=>r.method==='POST')).toHaveLength(0);
    await action.click();
    await expect(page.locator('a[download]')).toHaveCount(tool.pdf?3:1,{timeout:60_000});
    const firstUrl=await page.locator('a[download]').first().getAttribute('href');
    expect(firstUrl).toMatch(/^\/api\/v1\/jobs\/[^/]+\/results\//);
    const deleted=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().includes('/jobs/'));
    await page.getByRole('button',{name:/Alle entfernen|Zurücksetzen/}).click();
    expect((await deleted).status()).toBe(204);
    await expect(page.locator('a[download]')).toHaveCount(0);
    const audit=await page.evaluate(()=>(window as unknown as {__audit:{storage:string[];csp:string[]}}).__audit);
    expect(audit.storage).toEqual([]);
    const violations=browserName==='webkit'?audit.csp.filter(event=>!/^navigation: style-src-attr: inline; :1; $/.test(event)):audit.csp;
    expect(violations).toEqual([]);expect(network.sockets).toEqual([]);
    expect(network.requests.some(r=>r.method==='POST'&&new URL(r.url).pathname==='/api/v1/jobs')).toBe(true);
    for(const request of network.requests){
      const url=new URL(request.url);expect(url.origin).toBe(new URL(baseURL!).origin);
      expect(url.search).toBe('');expect(decodeURIComponent(url.href)).not.toContain(input.name);
      if(['fetch','xhr'].includes(request.type)) {
        const allowed = [
          /^\/api\/v1\/(?:capabilities|session)$/,
          /^\/api\/v1\/jobs(?:\/[0-9a-f-]{36}(?:\/cancel|\/results\/[0-9a-f-]{36})?)?$/,
        ];
        expect(allowed.some(pattern=>pattern.test(url.pathname)), `API-Pfad ${url.pathname}`).toBe(true);
      } else {
        expect(url.pathname===tool.path || url.pathname===`${tool.path}/` || url.pathname==='/favicon.svg' || /^\/_astro\/[\w.\/-]+\.(?:css|js|woff2?)$/.test(url.pathname), `Statischer Pfad ${url.pathname}`).toBe(true);
      }
    }
  });
  test(`${tool.path}: Tastatur und mobile Ergebnisse mit langem Dateinamen`,async({page,browserName})=>{
    await page.setViewportSize({width:320,height:720});await page.goto(tool.path);
    const picker=page.getByRole('button',{name:tool.pdf?'PDF auswählen':'Dateien auswählen',exact:true});
    await expect(picker).toBeEnabled();
    if(browserName==='webkit')await picker.focus();
    else{for(let i=0;i<30&&!await picker.evaluate(e=>e===document.activeElement);i++)await page.keyboard.press('Tab');}
    await expect(picker).toBeFocused();
    const chooser=page.waitForEvent('filechooser');await page.keyboard.press('Enter');await(await chooser).setFiles(await fixture(page,tool.pdf));
    await page.getByRole('button',{name:tool.action,exact:true}).click();
    await expect(page.locator('a[download]')).toHaveCount(tool.pdf?3:1,{timeout:60000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await expect(page.locator('[style]')).toHaveCount(0);
  });
}
