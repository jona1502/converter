import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/lib/image/limits';
import { probeImage } from '../../src/lib/image/probe';
import { ImageProcessingError, type ImageErrorCode } from '../../src/lib/image/types';
import { base64ToBytes, bytesToFile, concat } from './helpers/bytes';
import {
  bytesOf,
  exifApp1,
  fill,
  halfTransparent,
  insertJpegSegment,
  makeApng,
  paddingSegment,
  renderRequired,
  setJpegDimensions,
  setPngDimensions,
  TINY_WEBP_BASE64,
  webpVp8x,
} from './helpers/images';

async function expectCode(promise: Promise<unknown>, code: ImageErrorCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ImageProcessingError);
  expect((error as ImageProcessingError).code).toBe(code);
}

describe('probeImage', () => {
  it('erkennt Formate und Abmessungen anhand der Bytes', async () => {
    const png = await renderRequired('png', 40, 30, halfTransparent);
    expect(await probeImage(png)).toEqual({ format: 'png', width: 40, height: 30, orientation: 1, mayHaveTransparency: true });

    const jpeg = await renderRequired('jpeg', 41, 31, fill('#808080'));
    expect(await probeImage(jpeg)).toEqual({ format: 'jpeg', width: 41, height: 31, orientation: 1, mayHaveTransparency: false });

    const webp = bytesToFile(base64ToBytes(TINY_WEBP_BASE64), 'x.webp');
    expect(await probeImage(webp)).toMatchObject({ format: 'webp', width: 1, height: 1 });
  });

  it('ignoriert Dateiendung und MIME-Typ', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 10, 12, fill('#808080')));
    const disguised = bytesToFile(jpeg, 'foto.png', 'image/png');
    expect(await probeImage(disguised)).toMatchObject({ format: 'jpeg', width: 10, height: 12 });

    const text = bytesToFile(new TextEncoder().encode('Das ist kein Bild.'), 'bild.jpg', 'image/jpeg');
    await expectCode(probeImage(text), 'unsupported-type');
    await expectCode(probeImage(new Blob([])), 'unsupported-type');
  });

  it('tauscht Breite und Höhe bei EXIF-Orientierung 5–8', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 40, 20, fill('#808080')));
    expect(await probeImage(bytesToFile(insertJpegSegment(jpeg, exifApp1(6)), 'a.jpg'))).toMatchObject({
      width: 20,
      height: 40,
      orientation: 6,
    });
    expect(await probeImage(bytesToFile(insertJpegSegment(jpeg, exifApp1(3, true)), 'a.jpg'))).toMatchObject({
      width: 40,
      height: 20,
      orientation: 3,
    });
  });

  it('findet SOF auch hinter großen Segmenten am Dateianfang', async () => {
    const jpeg = await bytesOf(await renderRequired('jpeg', 23, 19, fill('#808080')));
    const padded = insertJpegSegment(jpeg, concat(paddingSegment(65000), paddingSegment(65000), paddingSegment(65000)));
    expect(padded.length).toBeGreaterThan(128 * 1024);
    expect(await probeImage(bytesToFile(padded, 'a.jpg'))).toMatchObject({ width: 23, height: 19 });
  });

  it('lehnt animierte PNG und WebP ab', async () => {
    const png = await bytesOf(await renderRequired('png', 8, 8, fill('#808080')));
    await expectCode(probeImage(bytesToFile(makeApng(png), 'a.png')), 'animated-unsupported');
    await expectCode(probeImage(bytesToFile(webpVp8x({ width: 8, height: 8, animatedFlag: true }), 'a.webp')), 'animated-unsupported');
    await expectCode(probeImage(bytesToFile(webpVp8x({ width: 8, height: 8, animChunk: true }), 'a.webp')), 'animated-unsupported');
  });

  it('lehnt zu große Dateien vor dem Lesen ab', async () => {
    const big = new Blob([new Uint8Array(LIMITS.maxFileBytes + 1)]);
    await expectCode(probeImage(big), 'file-too-large');
  });

  it('lehnt zu viele Pixel oder zu lange Kanten anhand des Headers ab', async () => {
    const png = await bytesOf(await renderRequired('png', 8, 8, fill('#808080')));
    await expectCode(probeImage(bytesToFile(setPngDimensions(png, 10_000, 10_000), 'a.png')), 'dimensions-too-large');
    await expectCode(probeImage(bytesToFile(setPngDimensions(png, LIMITS.maxEdge + 1, 10), 'a.png')), 'dimensions-too-large');
    // Genau an der Grenze ist erlaubt.
    expect(await probeImage(bytesToFile(setPngDimensions(png, LIMITS.maxEdge, 2000), 'a.png'))).toMatchObject({
      width: LIMITS.maxEdge,
    });

    const jpeg = await bytesOf(await renderRequired('jpeg', 8, 8, fill('#808080')));
    await expectCode(probeImage(bytesToFile(setJpegDimensions(jpeg, 9000, 9000), 'a.jpg')), 'dimensions-too-large');
    await expectCode(probeImage(bytesToFile(webpVp8x({ width: 20_000, height: 100 }), 'a.webp')), 'dimensions-too-large');
  });

  it('meldet beschädigte Header als decode-failed', async () => {
    const png = await bytesOf(await renderRequired('png', 8, 8, fill('#808080')));
    await expectCode(probeImage(bytesToFile(png.subarray(0, 20), 'a.png')), 'decode-failed');
    const jpegNoSof = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9);
    await expectCode(probeImage(bytesToFile(jpegNoSof, 'a.jpg')), 'decode-failed');
    await expectCode(probeImage(bytesToFile(setPngDimensions(png, 0, 8), 'a.png')), 'decode-failed');
  });
});
