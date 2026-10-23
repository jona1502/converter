import { describe, expect, it } from 'vitest';
import { detectDecodeSupport } from '../../src/lib/image/capabilities';
import { decodeSample } from '../../src/lib/image/decode-samples';
import { runPipeline } from '../../src/lib/image/pipeline';
import { probeImage } from '../../src/lib/image/probe';
import { sniffImage } from '../../src/lib/image/sniff';
import { extractLargestIcoEntry } from '../../src/lib/image/sniff-formats';
import { writeU32le } from '../../src/lib/image/bytes';
import { FORMAT_INFO, type ProcessOptions } from '../../src/lib/image/types';
import { fill, halfTransparent, readPixel, renderRequired } from './helpers/images';

const options = (format: ProcessOptions['format'], extra: Partial<ProcessOptions> = {}): ProcessOptions => ({
  format, quality: .8, background: '#ff0000', resize: { mode: 'none' }, ...extra,
});
const blob = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>]);
const support = await detectDecodeSupport();

describe('weitere Bildformate', () => {
  it.each(['gif', 'bmp', 'ico', 'avif'] as const)('erkennt %s und prüft tatsächliche Dekodierfähigkeit', async format => {
    const sample = blob(decodeSample(format));
    expect(await probeImage(sample)).toMatchObject({ format, width: 1, height: 1 });
    if (support[format]) {
      const result = await runPipeline(sample, options('png'));
      expect([result.width, result.height]).toEqual([1, 1]);
    } else {
      await expect(runPipeline(sample, options('png'))).rejects.toMatchObject({ code: 'decode-unsupported' });
    }
  });

  it('kodiert BMP mit Zeilenpadding, korrekten Farben und Hintergrund', async () => {
    const source = await renderRequired('png', 3, 2, halfTransparent);
    const result = await runPipeline(source, options('bmp'));
    expect(result.blob.size).toBe(54 + 12 * 2);
    expect(result.transparencyFlattened).toBe(true);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(10, true)).toBe(54);
    expect(view.getUint16(28, true)).toBe(24);
    expect(await readPixel(result.blob, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(await readPixel(result.blob, 2, 1)).toEqual([0, 255, 0, 255]);
  });

  it('erzeugt ICO-Einträge mit echten Größen und transparentem Rand', async () => {
    const source = await renderRequired('png', 40, 20, fill('#00ff00'));
    const result = await runPipeline(source, options('ico', { icoSizes: [16, 64] }));
    expect(result.mime).toBe(FORMAT_INFO.ico.mime);
    expect([result.width, result.height, result.upscaled]).toEqual([64, 64, true]);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(4, true)).toBe(2);
    for (let i = 0; i < 2; i++) {
      const e = 6 + 16 * i;
      const offset = view.getUint32(e + 12, true);
      const size = view.getUint32(e + 8, true);
      const png = blob(bytes.slice(offset, offset + size));
      const bitmap = await createImageBitmap(png);
      expect([bitmap.width, bitmap.height]).toEqual(i === 0 ? [16, 16] : [64, 64]);
      bitmap.close();
      expect((await readPixel(png, 0, 0))[3]).toBe(0);
    }
    expect(sniffImage(bytes)).toMatchObject({ width: 64, height: 64 });
    const single = extractLargestIcoEntry(bytes)!;
    expect(new DataView(single.buffer as ArrayBuffer).getUint16(4, true)).toBe(1);
    if (support.ico) {
      expect(await runPipeline(blob(bytes), options('png'))).toMatchObject({ width: 64, height: 64 });
    }
  });

  it('lehnt ungültige ICO-Optionen und zu große BMP-Ausgaben ab', async () => {
    const source = await renderRequired('png', 3, 2, fill('#fff'));
    for (const extra of [{ icoSizes: [] }, { icoSizes: [16, 16] }, { icoSizes: [1024] }, { resize: { mode: 'percent', percent: 50 } }]) {
      await expect(runPipeline(source, options('ico', extra as Partial<ProcessOptions>))).rejects.toMatchObject({ code: 'invalid-options' });
    }
    await expect(runPipeline(source, options('bmp', { resize: { mode: 'dimensions', width: 6000, height: 6000, keepAspectRatio: false, allowUpscale: true } })))
      .rejects.toMatchObject({ code: 'dimensions-too-large' });
  });

  it('erkennt GIF mit zweitem Frame als Animation', async () => {
    const sample = decodeSample('gif');
    const start = sample.indexOf(0x2c, 13);
    const animated = new Uint8Array(sample.length + sample.length - start - 1);
    animated.set(sample.subarray(0, sample.length - 1));
    animated.set(sample.subarray(start), sample.length - 1);
    await expect(probeImage(blob(animated))).rejects.toMatchObject({ code: 'animated-unsupported' });
  });

  it('lehnt AVIF-Bildfolgen und übergroße Header vor dem Dekodieren ab', async () => {
    const animated = decodeSample('avif');
    animated.set([97, 118, 105, 115], 8);
    await expect(probeImage(blob(animated))).rejects.toMatchObject({ code: 'animated-unsupported' });
    const bmp = decodeSample('bmp');
    writeU32le(bmp, 18, 100000);
    await expect(probeImage(blob(bmp))).rejects.toMatchObject({ code: 'dimensions-too-large' });
  });
});
