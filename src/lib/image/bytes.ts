/**
 * Grenzsichere Byte-Leser. Außerhalb der Daten liefern sie 0 bzw. '' – Aufrufer prüfen mit has().
 */

export function byte(b: Uint8Array, o: number): number {
  return b[o] ?? 0;
}

export function has(b: Uint8Array, o: number, n: number): boolean {
  return o >= 0 && o + n <= b.length;
}

export function ascii(b: Uint8Array, o: number, n: number): string {
  if (!has(b, o, n)) return '';
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(byte(b, o + i));
  return s;
}

export function u16be(b: Uint8Array, o: number): number {
  return (byte(b, o) << 8) | byte(b, o + 1);
}

export function u16le(b: Uint8Array, o: number): number {
  return byte(b, o) | (byte(b, o + 1) << 8);
}

export function u24le(b: Uint8Array, o: number): number {
  return byte(b, o) | (byte(b, o + 1) << 8) | (byte(b, o + 2) << 16);
}

export function u32be(b: Uint8Array, o: number): number {
  return byte(b, o) * 0x1000000 + ((byte(b, o + 1) << 16) | (byte(b, o + 2) << 8) | byte(b, o + 3));
}

export function u32le(b: Uint8Array, o: number): number {
  return byte(b, o + 3) * 0x1000000 + ((byte(b, o + 2) << 16) | (byte(b, o + 1) << 8) | byte(b, o));
}

/** Vorzeichenbehaftet, 32 bit, Little Endian. */
export function i32le(b: Uint8Array, o: number): number {
  return byte(b, o) | (byte(b, o + 1) << 8) | (byte(b, o + 2) << 16) | (byte(b, o + 3) << 24);
}

export function positiveOrNull(n: number): number | null {
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Schreiber für Little-Endian-Felder in einen vorhandenen Puffer. */
export function writeU16le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}

export function writeU32le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
