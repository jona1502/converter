import {test,expect} from '@playwright/test';
import {Buffer} from 'node:buffer';
const capabilities={image:{inputFormats:['png'],outputFormats:['jpeg','png','webp','bmp','ico'],maxFileBytes:52428800,maxPixels:40000000,maxEdge:16384},pdf:{maxFileBytes:100000000},jobs:{ttlSeconds:3600,maxActivePerSession:3,maxBatchFiles:30}};
async function prepare(page:import('@playwright/test').Page){
 await page.route('**/api/v1/capabilities',route=>route.fulfill({json:capabilities}));
 await page.route('**/api/v1/session',route=>route.fulfill({json:{csrfToken:'test-token'}}));
 await page.goto('/bilder/konvertieren');await expect(page.getByRole('button',{name:'Dateien auswählen',exact:true})).toBeEnabled();
 const bytes=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=24;return Array.from(atob(c.toDataURL().split(',')[1]!),s=>s.charCodeAt(0));});
 await page.locator('input[type=file]').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(bytes)});
}
test('429 respektieren, Idempotenzschlüssel und Optionen bei Wiederholung bewahren',async({page})=>{
 await prepare(page);const keys:string[]=[];const bodies:string[]=[];
 await page.route('**/api/v1/jobs',async route=>{
  keys.push(route.request().headers()['idempotency-key']!);bodies.push(route.request().postData()!);
  if(keys.length===1)return route.fulfill({status:429,headers:{'Retry-After':'1'},json:{error:{code:'rate-limited'}}});
  return route.fulfill({status:202,json:{id:'one',state:'succeeded',expiresAt:new Date(Date.now()+60000).toISOString(),input:{size:100},results:[{state:'succeeded',size:40,mime:'image/webp',downloadName:'test.webp',downloadUrl:'/api/v1/jobs/one/results/two',details:{width:32,height:24}}]}});
 });
 await page.getByRole('button',{name:'Konvertieren',exact:true}).click();
 await expect(page.locator('a[download]')).toBeVisible();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
 for(const body of bodies){expect(body.indexOf('name="options"')).toBeLessThan(body.indexOf('name="file"'));expect(body).toContain('"tool":"image-convert"');}
});
test('Serverfehler deutsch anzeigen und keinen lokalen Ersatz erzeugen',async({page})=>{
 await prepare(page);await page.route('**/api/v1/jobs',route=>route.fulfill({status:413,json:{error:{code:'file-too-large'}}}));
 await page.getByRole('button',{name:'Konvertieren',exact:true}).click();
 await expect(page.locator('.field-error')).toContainText('zulässige Größe');await expect(page.locator('a[download]')).toHaveCount(0);
});
test('Netzwerkabbruch lädt nicht automatisch neu hoch und manueller Neustart nutzt denselben Schlüssel',async({page})=>{
 await prepare(page);const keys:string[]=[];
 await page.route('**/api/v1/jobs',route=>{keys.push(route.request().headers()['idempotency-key']!);return route.abort('failed');});
 const action=page.getByRole('button',{name:'Konvertieren',exact:true});await action.click();
 await expect(page.locator('.field-error')).toContainText('nicht erreichbar');expect(keys).toHaveLength(1);
 await action.click();await expect.poll(()=>keys.length).toBe(2);
 expect(keys[0]).toBe(keys[1]);await expect(page.locator('a[download]')).toHaveCount(0);
});
