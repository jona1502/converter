import { describe, expect, it } from 'vitest';
import { detectFormat, sniffImage } from '../../src/lib/image/sniff';
import { ascii, base64ToBytes, concat } from './helpers/bytes';
import {
  bytesOf,
  exifApp1,
  fill,
  halfTransparent,
  insertJpegSegment,
  insertPngChunkAfterIhdr,
  makeApng,
  pngChunk,
  renderRequired,
  TINY_WEBP_BASE64,
  webpVp8Header,
  webpVp8lHeader,
  webpVp8x,
} from './helpers/images';

describe('detectFormat', () => {
  it('erkennt Signaturen und lehnt anderes ab', async () => {
    expect(detectFormat(await bytesOf(await renderRequired('png', 4, 4, fill('#123456'))))).toBe('png');
    expect(detectFormat(await bytesOf(await renderRequired('jpeg', 4, 4, fill('#123456'))))).toBe('jpeg');
    expect(detectFormat(base64ToBytes(TINY_WEBP_BASE64))).toBe('webp');
    expect(detectFormat(ascii('Hallo Welt, kein Bild'))).toBeNull();
    expect(detectFormat(ascii('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(detectFormat(new Uint8Array(0))).toBeNull();
    expect(detectFormat(Uint8Array.of(0xff, 0xd8))).toBeNull();
  });
});

describe('sniffImage – PNG', () => {
  it('liest Abmessungen aus IHDR', async () => {
    const r = sniffImage(await bytesOf(await renderRequired('png', 37, 21, fill('#ff0000'))));
    expect(r).toMatchObject({ format: 'png', width: 37, height: 21, animated: false, complete: true });
  });

  it('erkennt Transparenz (Farbtyp mit Alpha oder tRNS) und acTL', async () => {
    const png = await bytesOf(await renderRequired('png', 8, 8, halfTransparent));
    expect(sniffImage(png)?.mayHaveTransparency).toBe(true);

    // Farbtyp 2 (RGB) ohne Alpha, dann mit tRNS-Chunk.
    const ihdr = concat(ascii('\x89PNG\r\n\x1a\n'), pngChunk('IHDR', Uint8Array.of(0, 0, 0, 5, 0, 0, 0, 6, 8, 2, 0, 0, 0)));
    const rgb = concat(ihdr, pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND', new Uint8Array(0)));
    expect(sniffImage(rgb)).toMatchObject({ width: 5, height: 6, mayHaveTransparency: false, animated: false });
    const withTrns = insertPngChunkAfterIhdr(rgb, pngChunk('tRNS', Uint8Array.of(0, 0, 0, 0, 0, 0)));
    expect(sniffImage(withTrns)?.mayHaveTransparency).toBe(true);

    expect(sniffImage(makeApng(png))?.animated).toBe(true);
  });

  it('ignoriert acTL nach IDAT', () => {
    const ihdr = concat(ascii('\x89PNG\r\n\x1a\n'), pngChunk('IHDR', Uint8Array.of(0, 0, 0, 5, 0, 0, 0, 6, 8, 2, 0, 0, 0)));
    const late = concat(ihdr, pngChunk('IDAT', new Uint8Array(4)), pngChunk('acTL', new Uint8Array(8)));
    expect(sniffImage(late)?.animated).toBe(false);
  });

  it('meldet abgeschnittene Header als unvollständig ohne Abmessungen', async () => {
    const png = await bytesOf(await renderRequired('png', 8, 8, fill('#000000')));
    const r = sniffImage(png.subarray(0, 20));
    expect(r).toMatchObject({ format: 'png', width: null, height: null, complete: false });
  });
});

describe('sniffImage – JPEG', () => {
  it('liest Abmessungen aus SOF', async () => {
    const r = sniffImage(await bytesOf(await renderRequired('jpeg', 33, 17, fill('#00ff00'))));
    expect(r).toMatchObject({ format: 'jpeg', width: 33, height: 17, orientation: 1, mayHaveTransparency: false });
  });

  it('liest EXIF-Orientierung in Big und Little Endian', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 30, 10, fill('#00ff00')));
    for (const little of [false, true]) {
      for (const o of [1, 3, 6, 8]) {
        const r = sniffImage(insertJpegSegment(jpeg, exifApp1(o, little)));
        expect(r?.orientation).toBe(o);
        expect([r?.width, r?.height]).toEqual([30, 10]);
      }
    }
    expect(sniffImage(insertJpegSegment(jpeg, exifApp1(42)))?.orientation).toBe(1);
  });

  it('überspringt Füllbytes und überspringt SOF-ähnliche Marker DHT/DAC', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 12, 9, fill('#0000ff')));
    const fake = (marker: number) => concat(Uint8Array.of(0xff, marker, 0x00, 0x07), Uint8Array.of(8, 0x7f, 0xff, 0x7f, 0xff));
    const withFill = concat(jpeg.subarray(0, 2), Uint8Array.of(0xff, 0xff, 0xff), fake(0xc4), fake(0xcc), jpeg.subarray(2));
    expect(sniffImage(withFill)).toMatchObject({ width: 12, height: 9 });
  });

  it('liefert ohne SOF keine Abmessungen und hängt bei Unsinn nicht', () => {
    const noSof = Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9);
    expect(sniffImage(noSof)).toMatchObject({ width: null, complete: true });
    const garbage = concat(Uint8Array.of(0xff, 0xd8, 0xff), new Uint8Array(5000).fill(0x41));
    expect(sniffImage(garbage)?.width).toBeNull();
    const zeroLength = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xc0);
    expect(sniffImage(zeroLength)?.width).toBeNull();
  });
});

describe('sniffImage – WebP', () => {
  it('liest VP8, VP8L und VP8X', () => {
    expect(sniffImage(webpVp8Header(640, 480))).toMatchObject({ width: 640, height: 480, animated: false, mayHaveTransparency: false });
    expect(sniffImage(webpVp8lHeader(300, 200, false))).toMatchObject({ width: 300, height: 200, mayHaveTransparency: false });
    expect(sniffImage(webpVp8lHeader(16384, 1, true))).toMatchObject({ width: 16384, height: 1, mayHaveTransparency: true });
    expect(sniffImage(webpVp8x({ width: 5000, height: 7000 }))).toMatchObject({ width: 5000, height: 7000, animated: false });
    expect(sniffImage(base64ToBytes(TINY_WEBP_BASE64))).toMatchObject({ width: 1, height: 1 });
  });

  it('erkennt Animation über Flag oder ANIM-Chunk und Alpha über Flag oder ALPH', () => {
    expect(sniffImage(webpVp8x({ width: 10, height: 10, animatedFlag: true }))?.animated).toBe(true);
    expect(sniffImage(webpVp8x({ width: 10, height: 10, animChunk: true }))?.animated).toBe(true);
    expect(sniffImage(webpVp8x({ width: 10, height: 10, alphaFlag: true }))?.mayHaveTransparency).toBe(true);
    expect(sniffImage(webpVp8x({ width: 10, height: 10, alphChunk: true }))?.mayHaveTransparency).toBe(true);
    expect(sniffImage(webpVp8x({ width: 10, height: 10 }))?.mayHaveTransparency).toBe(false);
  });

  it('bleibt bei abgeschnittenen Daten robust', () => {
    const full = webpVp8x({ width: 10, height: 10 });
    for (let n = 0; n < full.length; n++) {
      expect(() => sniffImage(full.subarray(0, n))).not.toThrow();
    }
    expect(sniffImage(full.subarray(0, 20))).toMatchObject({ format: 'webp', width: null, complete: false });
  });
});
