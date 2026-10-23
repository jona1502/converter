import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectEncodeSupport } from '../../src/lib/image/capabilities';
import { verifyEncodedBlob } from '../../src/lib/image/encode';
import { buildOutputFileName } from '../../src/lib/image/filename';
import { runPipeline } from '../../src/lib/image/pipeline';
import { probeImage } from '../../src/lib/image/probe';
import { detectFormat, sniffImage } from '../../src/lib/image/sniff';
import {
  FORMAT_INFO,
  IMAGE_FORMATS,
  ImageProcessingError,
  type ImageErrorCode,
  type ImageFormat,
  type ProcessOptions,
} from '../../src/lib/image/types';
import { base64ToBytes, bytesToFile } from './helpers/bytes';
import {
  bytesOf,
  exifApp1,
  fill,
  halfTransparent,
  insertJpegSegment,
  makeApng,
  makeRgbaPng,
  noise,
  readPixel,
  redLeftBlueRight,
  renderBlob,
  renderRequired,
  setPngDimensions,
  TINY_WEBP_BASE64,
  truncateJpegAfterSof,
} from './helpers/images';

const support = await detectEncodeSupport();
const encodable = IMAGE_FORMATS.filter((f) => support[f] && f !== 'ico');

function opts(format: ImageFormat, extra: Partial<ProcessOptions> = {}): ProcessOptions {
  return { format, quality: 0.9, background: '#ffffff', resize: { mode: 'none' }, ...extra };
}

async function expectCode(promise: Promise<unknown>, code: ImageErrorCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImageProcessingError);
  expect((error as ImageProcessingError).code).toBe(code);
}

function near(actual: number, expected: number, tolerance: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('detectEncodeSupport', () => {
  it('meldet PNG und JPEG als kodierbar und ist konsistent mit echter Kodierung', async () => {
    expect(support.png).toBe(true);
    expect(support.jpeg).toBe(true);
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp'));
    expect(support.webp).toBe(blob?.type === 'image/webp');
    expect(await detectEncodeSupport()).toBe(support);
  });
});

describe('runPipeline', () => {
  it.each(encodable)('erzeugt gültiges %s (MIME, Signatur, Endung, dekodierbar)', async (format) => {
    const source = await renderRequired('png', 64, 48, redLeftBlueRight);
    const result = await runPipeline(source, opts(format));
    expect(result.format).toBe(format);
    expect(result.mime).toBe(FORMAT_INFO[format].mime);
    expect(result.blob.type).toBe(FORMAT_INFO[format].mime);
    expect(detectFormat(await bytesOf(result.blob))).toBe(format);
    expect(buildOutputFileName('quelle.png', format, 'k').endsWith(`.${FORMAT_INFO[format].extension}`)).toBe(true);
    expect(result).toMatchObject({ sourceWidth: 64, sourceHeight: 48, width: 64, height: 48, upscaled: false });
    const bitmap = await createImageBitmap(result.blob);
    expect([bitmap.width, bitmap.height]).toEqual([64, 48]);
    bitmap.close();
  });

  it('wendet die Größenänderung an', async () => {
    const source = await renderRequired('png', 64, 48, redLeftBlueRight);
    const max = await runPipeline(source, opts('png', { resize: { mode: 'maxEdge', maxEdge: 32 } }));
    expect([max.width, max.height, max.upscaled]).toEqual([32, 24, false]);
    const exact = await runPipeline(
      source,
      opts('png', { resize: { mode: 'dimensions', width: 10, height: 40, keepAspectRatio: false, allowUpscale: false } }),
    );
    expect([exact.width, exact.height]).toEqual([10, 40]);
    const up = await runPipeline(source, opts('png', { resize: { mode: 'percent', percent: 150, allowUpscale: true } }));
    expect([up.width, up.height, up.upscaled]).toEqual([96, 72, true]);
    const bitmap = await createImageBitmap(up.blob);
    expect([bitmap.width, bitmap.height]).toEqual([96, 72]);
    bitmap.close();
  });

  it('füllt transparente Bereiche bei JPEG mit der Hintergrundfarbe', async () => {
    const source = await renderRequired('png', 40, 40, halfTransparent);
    const result = await runPipeline(source, opts('jpeg', { background: '#ff0000' }));
    expect(result.transparencyFlattened).toBe(true);
    const [r, g, b, a] = await readPixel(result.blob, 5, 20);
    near(r, 255, 12);
    near(g, 0, 12);
    near(b, 0, 12);
    expect(a).toBe(255);
    const right = await readPixel(result.blob, 35, 20);
    near(right[0], 0, 12);
    near(right[1], 255, 12);

    const opaque = await renderRequired('jpeg', 10, 10, fill('#00ff00'));
    expect((await runPipeline(opaque, opts('jpeg'))).transparencyFlattened).toBe(false);
  });

  it.each(encodable.filter((f) => FORMAT_INFO[f].supportsTransparency))('%s behält den Alphakanal', async (format) => {
    const source = await renderRequired('png', 40, 40, halfTransparent);
    const result = await runPipeline(source, opts(format, { background: '#ff0000', quality: 0.9 }));
    expect(result.transparencyFlattened).toBe(false);
    const left = await readPixel(result.blob, 5, 20);
    expect(left[3]).toBeLessThanOrEqual(5);
    const right = await readPixel(result.blob, 35, 20);
    expect(right[3]).toBeGreaterThanOrEqual(250);
    near(right[1], 255, 12);
  });

  it.each(encodable.filter((f) => FORMAT_INFO[f].supportsQuality))('Qualität wirkt bei %s', async (format) => {
    const source = await renderRequired('png', 256, 256, noise(7));
    const low = await runPipeline(source, opts(format, { quality: 0.1 }));
    const high = await runPipeline(source, opts(format, { quality: 0.95 }));
    expect(low.blob.size).toBeLessThan(high.blob.size * 0.5);
  });

  it('wendet EXIF-Orientierung 6 an (Maße getauscht, Inhalt gedreht)', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 40, 20, redLeftBlueRight));
    const rotated = bytesToFile(insertJpegSegment(jpeg, exifApp1(6)), 'drehung.jpg', 'image/jpeg');
    const result = await runPipeline(rotated, opts('png'));
    expect([result.sourceWidth, result.sourceHeight, result.width, result.height]).toEqual([20, 40, 20, 40]);
    // Orientierung 6 = 90° im Uhrzeigersinn: die linke (rote) Hälfte liegt danach oben.
    const top = await readPixel(result.blob, 10, 5);
    const bottom = await readPixel(result.blob, 10, 35);
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
  });

  it('glättet bei starker Verkleinerung (feines Schachbrett wird grau)', async () => {
    const checker = await renderRequired('png', 512, 512, (ctx, w, h) => {
      const data = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = (x + y) % 2 === 0 ? 255 : 0;
          const i = (y * w + x) * 4;
          data.data.set([v, v, v, 255], i);
        }
      }
      ctx.putImageData(data, 0, 0);
    });
    const result = await runPipeline(checker, opts('png', { resize: { mode: 'maxEdge', maxEdge: 64 } }));
    expect([result.width, result.height]).toEqual([64, 64]);
    for (const [x, y] of [
      [10, 10],
      [33, 47],
      [60, 3],
    ] as const) {
      const [r] = await readPixel(result.blob, x, y);
      expect(r).toBeGreaterThan(80);
      expect(r).toBeLessThan(180);
    }
  });

  it('meldet beschädigte Dateien als decode-failed', async () => {
    const png = await bytesOf(await renderRequired('png', 16, 16, noise(3)));
    await expectCode(runPipeline(bytesToFile(png.subarray(0, 33), 'a.png'), opts('png')), 'decode-failed');
    // Hinweis: Zerstörte Bilddaten bei intaktem Header dekodieren Firefox und WebKit teilweise
    // (graue/leere Flächen) ohne Fehler; geprüft werden daher fehlende Bilddaten.
    const jpeg = await bytesOf(await renderRequired('jpeg', 16, 16, noise(3)));
    await expectCode(runPipeline(bytesToFile(truncateJpegAfterSof(jpeg), 'a.jpg'), opts('png')), 'decode-failed');
  });

  it('lehnt ungültige Optionen und zu große Ziele vor dem Dekodieren ab', async () => {
    const source = await renderRequired('png', 100, 100, fill('#000000'));
    await expectCode(runPipeline(source, opts('png', { quality: 1.5 })), 'invalid-options');
    await expectCode(runPipeline(source, opts('png', { quality: Number.NaN })), 'invalid-options');
    await expectCode(runPipeline(source, opts('png', { background: 'red' })), 'invalid-options');
    await expectCode(runPipeline(source, opts('png', { background: '#fff' })), 'invalid-options');
    await expectCode(runPipeline(source, opts('gif' as ImageFormat)), 'invalid-options');
    await expectCode(
      runPipeline(source, opts('png', { resize: { mode: 'dimensions', width: 0, keepAspectRatio: true, allowUpscale: false } })),
      'invalid-options',
    );
    await expectCode(
      runPipeline(source, opts('png', { resize: { mode: 'percent', percent: 16400, allowUpscale: true } })),
      'dimensions-too-large',
    );
    await expectCode(runPipeline(new Blob(['kein Bild']), opts('png')), 'unsupported-type');
  });

  it('bricht bei bereits abgebrochenem Signal ab', async () => {
    const source = await renderRequired('png', 10, 10, fill('#000000'));
    await expectCode(runPipeline(source, opts('png'), AbortSignal.abort()), 'aborted');
  });
});

describe('Ergebnisprüfung (kein stiller Formatwechsel)', () => {
  it('meldet falschen MIME-Typ als encode-unsupported, leere oder falsche Daten als encode-failed', async () => {
    const png = await renderRequired('png', 2, 2, fill('#000000'));
    await expectCode(verifyEncodedBlob(png, 'webp'), 'encode-unsupported');
    await expectCode(verifyEncodedBlob(png, 'jpeg'), 'encode-unsupported');
    await expectCode(verifyEncodedBlob(null, 'png'), 'encode-failed');
    await expectCode(verifyEncodedBlob(new Blob([], { type: 'image/png' }), 'png'), 'encode-failed');
    await expectCode(verifyEncodedBlob(new Blob(['kein png'], { type: 'image/png' }), 'png'), 'encode-failed');
    const verified = await verifyEncodedBlob(png, 'png');
    expect(verified).toBe(png);
    expect(verified.type).toBe('image/png');
  });

  it.runIf(!support.webp)('Browser ohne WebP-Kodierung liefert encode-unsupported statt Ersatzformat', async () => {
    const source = await renderRequired('png', 8, 8, fill('#000000'));
    await expectCode(runPipeline(source, opts('webp')), 'encode-unsupported');
  });

  it('Pipeline meldet encode-unsupported, wenn der Encoder ein anderes Format liefert (wie Safari bei WebP)', async () => {
    const source = await renderRequired('png', 8, 8, fill('#000000'));
    // Verhalten von Browsern ohne WebP-Encoder nachstellen: Canvas liefert PNG statt WebP.
    await withEncoderStub(
      (type, encode) => encode(type === 'image/webp' ? 'image/png' : type),
      () => expectCode(runPipeline(source, opts('webp')), 'encode-unsupported'),
    );
  });

  it('leeres Encoder-Ergebnis: encode-failed, bei großer Fläche dimensions-too-large', async () => {
    const source = await renderRequired('png', 10, 10, fill('#000000'));
    await withEncoderStub(
      async () => null,
      async () => {
        await expectCode(runPipeline(source, opts('png')), 'encode-failed');
        const huge = opts('png', {
          resize: { mode: 'dimensions', width: 4200, height: 4000, keepAspectRatio: false, allowUpscale: true },
        });
        await expectCode(runPipeline(source, huge), 'dimensions-too-large');
      },
    );
  });
});

/**
 * Ersetzt vorübergehend die Kodierung von OffscreenCanvas und HTMLCanvasElement.
 * replace erhält den angefragten MIME-Typ und eine Funktion, die mit dem echten Encoder kodiert.
 */
async function withEncoderStub(
  replace: (type: string | undefined, encode: (type: string | undefined) => Promise<Blob | null>) => Promise<Blob | null>,
  run: () => Promise<void>,
): Promise<void> {
  const offscreen = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas.prototype : null;
  const originalConvert = offscreen?.convertToBlob;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  if (offscreen && originalConvert) {
    offscreen.convertToBlob = function (this: OffscreenCanvas, options?: ImageEncodeOptions) {
      return replace(options?.type, (type) => originalConvert.call(this, { ...options, type })) as Promise<Blob>;
    };
  }
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, type?: string, q?: number) {
    void replace(type, (t) => new Promise<Blob | null>((r) => originalToBlob.call(this, r, t, q))).then(cb);
  };
  try {
    await run();
  } finally {
    if (offscreen && originalConvert) offscreen.convertToBlob = originalConvert;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  }
}

describe('Transparenzmeldung anhand der tatsächlichen Pixel', () => {
  it('deckendes RGBA-PNG -> JPEG meldet keine gefüllte Transparenz, halbtransparentes schon', async () => {
    const opaque = await makeRgbaPng(20, 20, (x) => (x < 10 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const opaqueFile = bytesToFile(opaque, 'deckend.png');
    expect((await probeImage(opaqueFile)).mayHaveTransparency).toBe(true);
    const r1 = await runPipeline(opaqueFile, opts('jpeg', { background: '#00ff00' }));
    expect(r1.transparencyFlattened).toBe(false);
    const p1 = await readPixel(r1.blob, 2, 10);
    expect(p1[0]).toBeGreaterThan(220);
    expect(p1[1]).toBeLessThan(40);

    const translucent = await makeRgbaPng(20, 20, (x) => (x < 10 ? [0, 0, 0, 0] : [0, 0, 255, 255]));
    const r2 = await runPipeline(bytesToFile(translucent, 'halb.png'), opts('jpeg', { background: '#00ff00' }));
    expect(r2.transparencyFlattened).toBe(true);
    const p2 = await readPixel(r2.blob, 2, 10);
    expect(p2[1]).toBeGreaterThan(220);
    expect(p2[0]).toBeLessThan(40);
  });
});

describe('Eingabeformate und Orientierungen', () => {
  it('verarbeitet JPEG-Eingaben', async () => {
    const jpeg = await renderRequired('jpeg', 30, 20, redLeftBlueRight);
    for (const format of encodable) {
      const result = await runPipeline(jpeg, opts(format));
      expect([result.width, result.height, result.format]).toEqual([30, 20, format]);
      expect(detectFormat(await bytesOf(result.blob))).toBe(format);
    }
  });

  it('verarbeitet das dekodierbare 1x1-WebP aus Bytes', async () => {
    const result = await runPipeline(bytesToFile(base64ToBytes(TINY_WEBP_BASE64), 'a.webp'), opts('png'));
    expect([result.width, result.height]).toEqual([1, 1]);
  });

  it.runIf(support.webp)('erkennt und verarbeitet browserkodierte WebP-Dateien (verlustbehaftet und mit Alpha)', async () => {
    const lossy = await renderBlob('webp', 30, 20, redLeftBlueRight, 0.8);
    const alpha = await renderBlob('webp', 30, 20, halfTransparent, 0.8);
    if (!lossy || !alpha) throw new Error('WebP laut Fähigkeitsprüfung kodierbar, aber nicht erzeugt');
    expect(sniffImage(await bytesOf(lossy))).toMatchObject({ format: 'webp', width: 30, height: 20, animated: false });
    expect(await probeImage(lossy)).toMatchObject({ format: 'webp', width: 30, height: 20 });
    expect(await probeImage(alpha)).toMatchObject({ format: 'webp', width: 30, height: 20, mayHaveTransparency: true });

    const fromLossy = await runPipeline(lossy, opts('png'));
    expect([fromLossy.width, fromLossy.height]).toEqual([30, 20]);
    const left = await readPixel(fromLossy.blob, 3, 10);
    expect(left[0]).toBeGreaterThan(200);

    const fromAlpha = await runPipeline(alpha, opts('jpeg', { background: '#ff0000' }));
    expect(fromAlpha.transparencyFlattened).toBe(true);
    const filled = await readPixel(fromAlpha.blob, 3, 10);
    expect(filled[0]).toBeGreaterThan(220);
    expect(filled[1]).toBeLessThan(40);
  });

  it.each([
    // [Orientierung, erwartete Maße, Punkt in Rot, Punkt in Blau]; Quelle: 40x20, links rot, rechts blau
    [3, [40, 20], [35, 10], [5, 10]],
    [6, [20, 40], [10, 5], [10, 35]],
    [8, [20, 40], [10, 35], [10, 5]],
  ] as const)('wendet EXIF-Orientierung %i über die Pipeline an', async (orientation, size, red, blue) => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 40, 20, redLeftBlueRight));
    const file = bytesToFile(insertJpegSegment(jpeg, exifApp1(orientation)), 'o.jpg');
    const result = await runPipeline(file, opts('png'));
    expect([result.width, result.height]).toEqual([...size]);
    const r = await readPixel(result.blob, red[0], red[1]);
    const b = await readPixel(result.blob, blue[0], blue[1]);
    expect(r[0]).toBeGreaterThan(200);
    expect(r[2]).toBeLessThan(60);
    expect(b[2]).toBeGreaterThan(200);
    expect(b[0]).toBeLessThan(60);
  });
});

describe('Dekodierung', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ruft createImageBitmap bei abgelehnten Eingaben nicht auf', async () => {
    const png = await bytesOf(await renderRequired('png', 8, 8, fill('#808080')));
    const spy = vi.spyOn(globalThis, 'createImageBitmap');
    await expectCode(runPipeline(bytesToFile(setPngDimensions(png, 10_000, 10_000), 'a.png'), opts('png')), 'dimensions-too-large');
    await expectCode(runPipeline(bytesToFile(makeApng(png), 'a.png'), opts('png')), 'animated-unsupported');
    await expectCode(runPipeline(new Blob(['kein Bild']), opts('png')), 'unsupported-type');
    expect(spy).not.toHaveBeenCalled();
  });

  it('lehnt ab, wenn der Browser die EXIF-Drehung nicht anwendet, statt still falsch zu drehen', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 40, 20, redLeftBlueRight));
    const original = globalThis.createImageBitmap.bind(globalThis);
    // Browser nachstellen, der imageOrientation nicht kennt und ungedreht dekodiert.
    // Ungedrehte Pixel (wie im JPEG gespeichert) als Canvas bereitstellen.
    const unrotated = document.createElement('canvas');
    unrotated.width = 40;
    unrotated.height = 20;
    const ctx = unrotated.getContext('2d');
    if (!ctx) throw new Error('Kein 2D-Kontext');
    redLeftBlueRight(ctx, 40, 20);
    const fake = (_source: ImageBitmapSource, options?: ImageBitmapOptions): Promise<ImageBitmap> =>
      options ? Promise.reject(new TypeError('imageOrientation unbekannt')) : original(unrotated);
    vi.spyOn(globalThis, 'createImageBitmap').mockImplementation(fake as typeof createImageBitmap);
    const rotated = bytesToFile(insertJpegSegment(jpeg, exifApp1(6)), 'o.jpg');
    await expectCode(runPipeline(rotated, opts('png')), 'decode-failed');
    // Ohne Drehbedarf funktioniert der Rückfall.
    const plain = await runPipeline(bytesToFile(jpeg, 'p.jpg'), opts('png'));
    expect([plain.width, plain.height]).toEqual([40, 20]);
  });
});
