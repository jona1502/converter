/**
 * Kleine Beispieldateien (je 1×1 Pixel) für die Dekodierungs-Fähigkeitsprüfung.
 * Herkunft: selbst erzeugt mit sharp/libvips (Abhängigkeit von Astro) aus einem einfarbigen Pixel;
 * keine fremden Werke, keine Lizenzbindung. BMP und ICO werden zur Laufzeit gebaut.
 */
import { writeU16le, writeU32le } from './bytes';
import type { InputFormat } from './types';

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWMwTpsJAAICATMDms/iAAAAAElFTkSuQmCC';
const JPEG = '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCaAoAv/9k=';
const WEBP = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQs840s/+BiOh/AAA=';
const GIF = 'R0lGODlhAQABAIAAAExpcTNmmSH5BAUAAAAALAAAAAABAAEAAAICTAEAOw==';
const AVIF = 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACUAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAtbWRhdBIACgc4AAaQENBpMhgZQmMEw88880EgAJBBEdVEljT0kcXmC7g=';

/** 1×1, 24 bit, BITMAPINFOHEADER. */
function bmp(): Uint8Array {
  const b = new Uint8Array(58);
  b[0] = 0x42;
  b[1] = 0x4d;
  writeU32le(b, 2, 58);
  writeU32le(b, 10, 54);
  writeU32le(b, 14, 40);
  writeU32le(b, 18, 1);
  writeU32le(b, 22, 1);
  writeU16le(b, 26, 1);
  writeU16le(b, 28, 24);
  writeU32le(b, 34, 4);
  b.set([0x99, 0x66, 0x33, 0], 54);
  return b;
}

/** ICO mit einem 1×1-PNG-Eintrag. */
function ico(): Uint8Array {
  const png = fromBase64(PNG);
  const b = new Uint8Array(22 + png.length);
  writeU16le(b, 2, 1);
  writeU16le(b, 4, 1);
  b[6] = 1;
  b[7] = 1;
  writeU16le(b, 10, 1);
  writeU16le(b, 12, 32);
  writeU32le(b, 14, png.length);
  writeU32le(b, 18, 22);
  b.set(png, 22);
  return b;
}

export function decodeSample(format: InputFormat): Uint8Array {
  switch (format) {
    case 'png':
      return fromBase64(PNG);
    case 'jpeg':
      return fromBase64(JPEG);
    case 'webp':
      return fromBase64(WEBP);
    case 'gif':
      return fromBase64(GIF);
    case 'avif':
      return fromBase64(AVIF);
    case 'bmp':
      return bmp();
    case 'ico':
      return ico();
  }
}
