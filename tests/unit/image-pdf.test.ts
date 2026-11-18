import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api/client';
import {
  buildImageBundle,
  buildImagePdfOptions,
  checkImageForPdf,
  DEFAULT_IMAGE_PDF_SETTINGS,
  IMAGE_PDF_BUNDLE_NAME,
  IMAGE_PDF_LIMITS,
  imagePdfMessage,
  imagePdfPageLabel,
  imagePdfSelectionProblem,
  moveItem,
  normalizeImagePdfSettings,
} from '../../src/lib/imagepdf';
import { base64ToBytes, bytesToFile, concat, u16le, u32le } from './helpers/bytes';
import { fill, renderRequired, TINY_WEBP_BASE64 } from './helpers/images';

describe('Bild-zu-PDF-Einstellungen', () => {
  it('sendet immer vollständige Optionen mit Standardwerten', () => {
    expect(buildImagePdfOptions(DEFAULT_IMAGE_PDF_SETTINGS)).toEqual({
      tool: 'image-pdf', pageSize: 'a4', orientation: 'auto', margin: 'small',
    });
    expect(buildImagePdfOptions({ pageSize: 'letter', orientation: 'landscape', margin: 'none' })).toEqual({
      tool: 'image-pdf', pageSize: 'letter', orientation: 'landscape', margin: 'none',
    });
  });

  it('erzwingt bei Bildgröße die automatische Ausrichtung, wie es der Server verlangt', () => {
    const fit = { pageSize: 'fit', orientation: 'landscape', margin: 'medium' } as const;
    expect(normalizeImagePdfSettings(fit).orientation).toBe('auto');
    expect(buildImagePdfOptions(fit)).toEqual({ tool: 'image-pdf', pageSize: 'fit', orientation: 'auto', margin: 'medium' });
    expect(normalizeImagePdfSettings(DEFAULT_IMAGE_PDF_SETTINGS)).toBe(DEFAULT_IMAGE_PDF_SETTINGS);
  });

  it('beschreibt die Auswahl in einer Zeile', () => {
    expect(imagePdfPageLabel(DEFAULT_IMAGE_PDF_SETTINGS)).toBe('A4 · Automatisch je Bild · Klein (10 mm)');
    expect(imagePdfPageLabel({ pageSize: 'fit', orientation: 'portrait', margin: 'none' })).toBe('Bildgröße · Kein Rand');
  });
});

describe('Reihenfolge', () => {
  it('verschiebt Einträge und lässt unmögliche Züge unverändert', () => {
    const list = ['a', 'b', 'c'] as const;
    expect(moveItem(list, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(list, 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 2, 1)).toBe(list);
    expect(moveItem(list, 5, -1)).toBe(list);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('Vorprüfung ohne Upload', () => {
  it('nimmt JPEG, PNG und WebP an und liefert Format und Maße', async () => {
    const png = await renderRequired('png', 40, 30, fill('#336699'));
    expect(await checkImageForPdf(bytesToFile(new Uint8Array(await png.arrayBuffer()), 'a.png'))).toEqual({ ok: true, format: 'png', width: 40, height: 30 });
    const jpeg = await renderRequired('jpeg', 31, 41, fill('#808080'));
    expect(await checkImageForPdf(new File([jpeg], 'b.jpg'))).toEqual({ ok: true, format: 'jpeg', width: 31, height: 41 });
    expect(await checkImageForPdf(bytesToFile(base64ToBytes(TINY_WEBP_BASE64), 'c.webp'))).toMatchObject({ ok: true, format: 'webp' });
  });

  it('weist ICO, Text, leere Dateien und zu große Dateien zurück', async () => {
    const payload = new Uint8Array(await (await renderRequired('png', 16, 16, fill('#ff0000'))).arrayBuffer());
    const ico = concat(Uint8Array.of(0, 0, 1, 0, 1, 0, 16, 16, 0, 0), u16le(1), u16le(32), u32le(payload.length), u32le(22), payload);
    expect(await checkImageForPdf(bytesToFile(ico, 'a.ico'))).toEqual({ ok: false, code: 'unsupported-type' });
    expect(await checkImageForPdf(new File(['Kein Bild'], 'x.png'))).toEqual({ ok: false, code: 'unsupported-type' });
    expect(await checkImageForPdf(new File([], 'leer.png'))).toEqual({ ok: false, code: 'unsupported-type' });
    const png = await renderRequired('png', 10, 10, fill('#000000'));
    expect(await checkImageForPdf(new File([png], 'a.png'), { ...IMAGE_PDF_LIMITS, maxImageBytes: 10 })).toEqual({ ok: false, code: 'file-too-large' });
    expect(await checkImageForPdf(new File([png], 'a.png'), { ...IMAGE_PDF_LIMITS, maxEdge: 9 })).toEqual({ ok: false, code: 'dimensions-too-large' });
  });
});

describe('Bündel', () => {
  it('nummeriert die Einträge in Seitenreihenfolge und verrät keine Originalnamen', async () => {
    const png = await renderRequired('png', 4, 4, fill('#ff0000'));
    const jpeg = await renderRequired('jpeg', 4, 4, fill('#00ff00'));
    const bundle = await buildImageBundle([
      { file: jpeg, format: 'jpeg' },
      { file: png, format: 'png' },
    ]);
    expect(bundle.name).toBe(IMAGE_PDF_BUNDLE_NAME);
    expect(bundle.type).toBe('application/zip');
    const bytes = new Uint8Array(await bundle.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('001.jpg');
    expect(text).toContain('002.png');
    expect(text.indexOf('001.jpg')).toBeLessThan(text.indexOf('002.png'));
    expect(bytes.length).toBe(30 * 2 + 46 * 2 + 7 * 4 + jpeg.size + png.size + 22);
  });

  it('lehnt nicht unterstützte Formate ab', async () => {
    await expect(buildImageBundle([{ file: new Blob(['x']), format: 'ico' }])).rejects.toThrow();
  });
});

describe('Grenzen und Meldungen', () => {
  it('prüft Anzahl und Gesamtgröße', () => {
    expect(imagePdfSelectionProblem([1, 2, 3])).toBeNull();
    expect(imagePdfSelectionProblem(new Array(31).fill(1))).toMatch(/30 Bilder/);
    expect(imagePdfSelectionProblem([60_000_000, 60_000_000])).toMatch(/zusammen/);
  });

  it('erklärt Fehlercodes auf Deutsch und fällt sonst auf die allgemeine Meldung zurück', () => {
    expect(imagePdfMessage(new ApiError('unsupported-type'))).toMatch(/JPEG, PNG, WebP, GIF und BMP/);
    expect(imagePdfMessage(new ApiError('file-too-large'))).toMatch(/je Bild/);
    expect(imagePdfMessage(new ApiError('dimensions-too-large'))).toMatch(/Megapixel/);
    expect(imagePdfMessage(new ApiError('animated-unsupported'))).toMatch(/Animierte/);
    expect(imagePdfMessage(new ApiError('result-too-large'))).toMatch(/PDF/);
    expect(imagePdfMessage(new ApiError('service-unavailable'))).toMatch(/verfügbar/);
    expect(imagePdfMessage(new ApiError('rate-limited'))).toMatch(/Zu viele Anfragen/);
    expect(imagePdfMessage(new Error('x'))).toMatch(/nicht erreichbar/);
  });
});
