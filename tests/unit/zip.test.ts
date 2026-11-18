import { describe, expect, it } from 'vitest';
import { buildStoredZip, crc32 } from '../../src/lib/zip';

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Minimaler Leser nach APPNOTE: Zentralverzeichnis, dann lokale Header. */
function readZip(bytes: Uint8Array) {
  const dv = view(bytes);
  const eocd = bytes.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let central = dv.getUint32(eocd + 16, true);
  expect(dv.getUint32(eocd + 12, true)).toBe(eocd - central);
  const entries: { name: string; data: Uint8Array; crc: number; method: number; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(central, true)).toBe(0x02014b50);
    const flags = dv.getUint16(central + 8, true);
    const method = dv.getUint16(central + 10, true);
    const crc = dv.getUint32(central + 16, true);
    const compressed = dv.getUint32(central + 20, true);
    const size = dv.getUint32(central + 24, true);
    const nameLength = dv.getUint16(central + 28, true);
    const extraLength = dv.getUint16(central + 30, true);
    const commentLength = dv.getUint16(central + 32, true);
    const offset = dv.getUint32(central + 42, true);
    const name = text(bytes.subarray(central + 46, central + 46 + nameLength));
    expect(compressed).toBe(size);
    expect(dv.getUint32(offset, true)).toBe(0x04034b50);
    expect(dv.getUint16(offset + 8, true)).toBe(method);
    expect(dv.getUint32(offset + 14, true)).toBe(crc);
    expect(dv.getUint32(offset + 18, true)).toBe(size);
    const localName = dv.getUint16(offset + 26, true);
    const localExtra = dv.getUint16(offset + 28, true);
    expect(text(bytes.subarray(offset + 30, offset + 30 + localName))).toBe(name);
    const start = offset + 30 + localName + localExtra;
    entries.push({ name, data: bytes.subarray(start, start + size), crc, method, flags });
    central += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('crc32', () => {
  it('liefert die Prüfsumme des Standard-Testvektors', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('buildStoredZip', () => {
  it('schreibt ungepackte Einträge in der übergebenen Reihenfolge', async () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new TextEncoder().encode('zweites Bild');
    const blob = await buildStoredZip([
      { name: '001.png', data: new Blob([a]) },
      { name: '002.jpg', data: new Blob([b]) },
    ]);
    expect(blob.type).toBe('application/zip');
    const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.map((entry) => entry.name)).toEqual(['001.png', '002.jpg']);
    expect([...entries[0]!.data]).toEqual([...a]);
    expect([...entries[1]!.data]).toEqual([...b]);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.flags & 1).toBe(0);
      expect(entry.crc).toBe(crc32(entry.data));
    }
  });

  it('akzeptiert leere Einträge, lehnt aber unzulässige Namen und Mengen ab', async () => {
    const empty = await buildStoredZip([{ name: '001.png', data: new Blob([]) }]);
    expect(readZip(new Uint8Array(await empty.arrayBuffer()))[0]!.data.length).toBe(0);
    await expect(buildStoredZip([{ name: 'ü.png', data: new Blob([]) }])).rejects.toThrow();
    await expect(buildStoredZip([{ name: '../x.png', data: new Blob([]) }])).rejects.toThrow();
    await expect(buildStoredZip([{ name: '001.png', data: new Blob([]) }, { name: '001.png', data: new Blob([]) }])).rejects.toThrow();
    await expect(buildStoredZip([])).rejects.toThrow();
  });
});
