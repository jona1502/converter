import {expect,test} from '@playwright/test';
import {Buffer} from 'node:buffer';
import {PDFDocument} from '@cantoo/pdf-lib';
async function fixture(){const doc=await PDFDocument.create();doc.addPage().drawText('Server-PDF');return {name:'test.pdf',mimeType:'application/pdf',buffer:Buffer.from(await doc.save())};}
test('PDF erst nach Klick hochladen, drei echte Ergebnisse herunterladen und löschen',async({page})=>{
 await page.goto('/pdf/komprimieren');
 await expect(page.getByRole('button',{name:'PDF auswählen',exact:true})).toBeEnabled();
 await expect(page.getByText('Digitale Signaturen werden beim Neuschreiben ungültig.',{exact:false})).toBeVisible();
 const uploads:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/jobs'))uploads.push(r.url());});
 await page.getByLabel('PDF-Datei',{exact:true}).setInputFiles(await fixture());
 await expect(page.getByRole('button',{name:'Komprimieren',exact:true})).toBeEnabled();
 expect(uploads).toHaveLength(0);
 await page.getByRole('button',{name:'Komprimieren',exact:true}).click();
 for(const label of ['Hohe Qualität','Ausgewogen','Kleine Datei'])await expect(page.getByRole('link',{name:`${label} herunterladen`,exact:true})).toBeVisible({timeout:60000});
 expect(uploads).toHaveLength(1);
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'Ausgewogen herunterladen',exact:true}).click();
 expect((await download).suggestedFilename()).toBe('test-balanced.pdf');
 const removed=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().includes('/jobs/'));
 await page.getByRole('button',{name:'Zurücksetzen',exact:true}).click();expect((await removed).status()).toBe(204);
 await expect(page.locator('a[download]')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'PDF auswählen',exact:true})).toBeFocused();
});
test('beschädigte PDF nach ausdrücklichem Start verständlich ablehnen',async({page})=>{
 await page.goto('/pdf/komprimieren');await expect(page.getByRole('button',{name:'PDF auswählen',exact:true})).toBeEnabled();
 await page.getByLabel('PDF-Datei',{exact:true}).setInputFiles({name:'kaputt.pdf',mimeType:'application/pdf',buffer:Buffer.from('keine PDF')});
 await page.getByRole('button',{name:'Komprimieren',exact:true}).click();
 await expect(page.locator('p.notice-error')).toContainText('keine erkennbare PDF');await expect(page.locator('a[download]')).toHaveCount(0);
});
