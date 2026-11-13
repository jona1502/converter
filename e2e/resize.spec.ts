import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

// Ergebnisgruppe mit Format und Maßen (FileList: Gruppen „Original“ und „Ergebnis“).
const resultGroup = (page: Page, format: string, dimensions: string) =>
  page.getByRole('group', { name: 'Ergebnis', exact: true })
    .filter({ has: page.getByText(format, { exact: true }) })
    .filter({ has: page.getByText(dimensions, { exact: true }) });

test('Skalieren erhält Format und Verhältnis und schützt vor versehentlicher Vergrößerung', async ({ page }) => {
  await page.goto('/bilder/skalieren');
  await expect(page.getByLabel('Zielformat', { exact: true })).toBeEnabled();
  const bytes = await page.evaluate(() => { const c=document.createElement('canvas'); c.width=120; c.height=80; c.getContext('2d')!.fillRect(0,0,120,80); return Array.from(atob(c.toDataURL().split(',')[1]!), ch=>ch.charCodeAt(0)); });
  await page.locator('input[type=file]').setInputFiles({name:'bild.png',mimeType:'image/png',buffer:Buffer.from(bytes)});
  const action=page.getByRole('button',{name:'Skalieren',exact:true});
  await expect(action).toBeEnabled(); await action.click();
  await expect(resultGroup(page, 'PNG', '60 × 40 px')).toBeVisible();
  await expect(page.locator('a[download="bild-skaliert.png"]')).toBeVisible();
  await page.getByLabel('Größe in Prozent',{exact:true}).fill('200');
  await expect(action).toBeDisabled();
  await page.getByLabel('Vergrößerung erlauben',{exact:true}).check();
  await action.click(); await expect(resultGroup(page, 'PNG', '240 × 160 px')).toBeVisible();
  await expect(page.getByText(/Das Bild wurde vergrößert/)).toBeVisible();
  await page.getByLabel('Größenangabe',{exact:true}).selectOption('dimensions');
  await expect(page.getByLabel('Seitenverhältnis erhalten',{exact:true})).toBeChecked();
  await page.getByLabel('Breite (Pixel)',{exact:true}).fill('90');
  await action.click(); await expect(resultGroup(page, 'PNG', '90 × 60 px')).toBeVisible();
  await page.getByLabel('Seitenverhältnis erhalten',{exact:true}).uncheck();
  await expect(action).toBeDisabled();
  await page.getByLabel('Höhe (Pixel)',{exact:true}).fill('30');
  await action.click(); await expect(resultGroup(page, 'PNG', '90 × 30 px')).toBeVisible();
});

test('Gemischter Stapel behält jedes Originalformat', async ({ page }) => {
  await page.goto('/bilder/skalieren');
  await expect(page.getByLabel('Zielformat',{exact:true})).toBeEnabled();
  const samples=await page.evaluate(()=>{
    const c=document.createElement('canvas'); c.width=40;c.height=20;c.getContext('2d')!.fillRect(0,0,40,20);
    return ['image/png','image/jpeg'].map(type=>Array.from(atob(c.toDataURL(type).split(',')[1]!),ch=>ch.charCodeAt(0)));
  });
  await page.locator('input[type=file]').setInputFiles([
    {name:'eins.png',mimeType:'image/png',buffer:Buffer.from(samples[0]!)},
    {name:'zwei.jpg',mimeType:'image/jpeg',buffer:Buffer.from(samples[1]!)}
  ]);
  const action=page.getByRole('button',{name:'Skalieren',exact:true});await expect(action).toBeEnabled();await action.click();
  await expect(page.locator('a[download="eins-skaliert.png"]')).toBeVisible();
  await expect(page.locator('a[download="zwei-skaliert.jpg"]')).toBeVisible();
  await expect(resultGroup(page, 'PNG', '20 × 10 px')).toBeVisible();
  await expect(resultGroup(page, 'JPEG', '20 × 10 px')).toBeVisible();
});
