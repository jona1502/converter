/**
 * Eigene Encoder ohne Bibliothek: BMP (24 bit) und ICO (PNG-Einträge).
 */
import { writeU16le, writeU32le } from './bytes';
import type { AnyContext2D } from './canvas';
import type { IcoSize } from './types';

/** Pixel je getImageData-Aufruf beim BMP-Export (begrenzt den Zusatzspeicher auf wenige MB). */
const STRIP_PIXELS = 1 << 20;

/**
 * BMP: BITMAPINFOHEADER, 24 bit BI_RGB, von unten nach oben, Zeilen auf 4 Byte aufgefüllt, 72 dpi.
 * 24 bit ohne Alpha ist die mit Abstand kompatibelste BMP-Variante (Alpha in 32-bit-BMP wird von
 * vielen Programmen ignoriert oder falsch dargestellt). Die Canvas muss bereits deckend sein
 * (Transparenz mit der Hintergrundfarbe gefüllt).
 */
export function encodeBmp(ctx: AnyContext2D, width: number, height: number): Blob {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const imageSize = stride * height;
  const header = new Uint8Array(54);
  header[0] = 0x42; // B
  header[1] = 0x4d; // M
  writeU32le(header, 2, 54 + imageSize);
  writeU32le(header, 10, 54); // Offset der Pixeldaten
  writeU32le(header, 14, 40); // BITMAPINFOHEADER
  writeU32le(header, 18, width);
  writeU32le(header, 22, height); // positiv = von unten nach oben
  writeU16le(header, 26, 1); // Ebenen
  writeU16le(header, 28, 24); // Bit pro Pixel
  writeU32le(header, 30, 0); // BI_RGB
  writeU32le(header, 34, imageSize);
  writeU32le(header, 38, 2835); // 72 dpi in Pixel pro Meter
  writeU32le(header, 42, 2835);

  const parts: Uint8Array<ArrayBuffer>[] = [header];
  const rows = Math.max(1, Math.floor(STRIP_PIXELS / width));
  // Von der untersten Zeile aufwärts, damit die Teile in Dateireihenfolge entstehen.
  for (let yEnd = height; yEnd > 0; yEnd -= rows) {
    const y0 = Math.max(0, yEnd - rows);
    const n = yEnd - y0;
    const data = ctx.getImageData(0, y0, width, n).data;
    const chunk = new Uint8Array(stride * n);
    for (let r = 0; r < n; r++) {
      const src = (n - 1 - r) * width * 4;
      const dst = r * stride;
      for (let x = 0; x < width; x++) {
        const s = src + x * 4;
        const d = dst + x * 3;
        chunk[d] = data[s + 2] ?? 0; // B
        chunk[d + 1] = data[s + 1] ?? 0; // G
        chunk[d + 2] = data[s] ?? 0; // R
      }
    }
    parts.push(chunk);
  }
  return new Blob(parts, { type: 'image/bmp' });
}

export interface IcoImage {
  readonly size: IcoSize;
  /** Geprüftes PNG der Größe size × size. */
  readonly png: Blob;
}

/**
 * ICO: ICONDIR (reserved 0, type 1, Anzahl) + je Eintrag ICONDIRENTRY (Breite/Höhe, 0 steht für 256;
 * Farben 0; Ebenen 1; 32 bit; Größe; Offset) + PNG-Daten. PNG-Einträge unterstützen Windows ab
 * Vista und alle aktuellen Browser. Einträge aufsteigend nach Größe.
 */
export function assembleIco(images: readonly IcoImage[]): Blob {
  const sorted = [...images].sort((a, b) => a.size - b.size);
  const dir = new Uint8Array(6 + 16 * sorted.length);
  writeU16le(dir, 0, 0);
  writeU16le(dir, 2, 1);
  writeU16le(dir, 4, sorted.length);
  let offset = dir.length;
  sorted.forEach((image, i) => {
    const e = 6 + i * 16;
    dir[e] = image.size >= 256 ? 0 : image.size;
    dir[e + 1] = image.size >= 256 ? 0 : image.size;
    dir[e + 2] = 0; // Palettenfarben
    dir[e + 3] = 0; // reserviert
    writeU16le(dir, e + 4, 1); // Ebenen
    writeU16le(dir, e + 6, 32); // Bit pro Pixel
    writeU32le(dir, e + 8, image.png.size);
    writeU32le(dir, e + 12, offset);
    offset += image.png.size;
  });
  return new Blob([dir, ...sorted.map((i) => i.png)], { type: 'image/x-icon' });
}

/** Einpassen (contain) einer Quelle in ein Quadrat der Kantenlänge size, zentriert. */
export function fitIntoSquare(sourceWidth: number, sourceHeight: number, size: number) {
  const scale = size / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(1, Math.min(size, Math.round(sourceWidth * scale)));
  const height = Math.max(1, Math.min(size, Math.round(sourceHeight * scale)));
  return { x: Math.floor((size - width) / 2), y: Math.floor((size - height) / 2), width, height, scale };
}
