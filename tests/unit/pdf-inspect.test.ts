import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { inspectPdf, LOCAL_PARSE_MAX_BYTES } from '../../src/lib/pdfInspect';

async function pdfWithPages(count: number): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([200, 200]);
  return new File([await doc.save()], 'a.pdf', { type: 'application/pdf' });
}

describe('PDF lokal vorprüfen (ohne Upload)', () => {
  it('liest die Seitenzahl', async () => {
    expect(await inspectPdf(await pdfWithPages(3))).toEqual({ ok: true, pageCount: 3 });
  });
  it('lehnt Dateien ohne PDF-Signatur ab', async () => {
    expect(await inspectPdf(new File(['Hallo'], 'a.pdf'))).toEqual({ ok: false, code: 'not-pdf' });
    expect(await inspectPdf(new File([], 'leer.pdf'))).toEqual({ ok: false, code: 'not-pdf' });
  });
  it('lehnt verschlüsselte PDFs ab', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.encrypt({ userPassword: 'u', ownerPassword: 'o', permissions: {} });
    const file = new File([await doc.save()], 'enc.pdf', { type: 'application/pdf' });
    expect(await inspectPdf(file)).toEqual({ ok: false, code: 'encrypted' });
  });
  it('lässt unlesbare, aber signierte Dateien mit unbekannter Seitenzahl durch', async () => {
    expect(await inspectPdf(new File(['%PDF-1.7\nkaputt'], 'k.pdf'))).toEqual({ ok: true, pageCount: null });
  });
  it('parst große Dateien nicht im Browser', async () => {
    const big = new File(['%PDF-1.7\n', new Uint8Array(LOCAL_PARSE_MAX_BYTES)], 'big.pdf');
    expect(await inspectPdf(big)).toEqual({ ok: true, pageCount: null });
  });
});
