/**
 * Minimaler ZIP-Schreiber für ungepackte Einträge ("stored").
 *
 * Bild zu PDF überträgt mehrere Bilder als ein Bündel, weil die Auftrags-API genau eine Datei
 * annimmt. Bilder sind bereits komprimiert; ohne Deflate bleibt das Bündel einfach, vorhersagbar
 * groß und für den Server ohne Entpackrisiko prüfbar. Kein ZIP64: höchstens 65 535 Einträge und
 * 4 GiB insgesamt, die Werkzeuggrenzen liegen weit darunter.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) wie im ZIP-Format. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** ASCII-Name ohne Verzeichnisanteil, z. B. "001.png". */
  readonly name: string;
  readonly data: Blob;
}

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
// 1980-01-01 00:00: feste Zeit, damit das Bündel keine Uhrzeit verrät und reproduzierbar ist.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const VERSION = 20;

function header(size: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** Baut ein ZIP aus ungepackten Einträgen. Wirft bei unzulässigen Namen, Mengen oder Größen. */
export async function buildStoredZip(entries: readonly ZipEntry[]): Promise<Blob> {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) throw new Error('Ungültige Anzahl an ZIP-Einträgen.');
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(entry.name) || entry.name.startsWith('.') || names.has(entry.name)) {
      throw new Error('Ungültiger ZIP-Eintragsname.');
    }
    names.add(entry.name);
    const name = new TextEncoder().encode(entry.name);
    const size = entry.data.size;
    if (size > MAX_BYTES || offset + 30 + name.length + size > MAX_BYTES) throw new Error('ZIP-Eintrag ist zu groß.');
    const crc = crc32(new Uint8Array(await entry.data.arrayBuffer()));

    const local = header(30 + name.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, VERSION, true);
    // flags 0 (kein Datendeskriptor, kein UTF-8-Bit nötig), method 0 = stored
    local.view.setUint16(10, DOS_TIME, true);
    local.view.setUint16(12, DOS_DATE, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, size, true);
    local.view.setUint32(22, size, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);

    const dir = header(46 + name.length);
    dir.view.setUint32(0, 0x02014b50, true);
    dir.view.setUint16(4, VERSION, true);
    dir.view.setUint16(6, VERSION, true);
    dir.view.setUint16(12, DOS_TIME, true);
    dir.view.setUint16(14, DOS_DATE, true);
    dir.view.setUint32(16, crc, true);
    dir.view.setUint32(20, size, true);
    dir.view.setUint32(24, size, true);
    dir.view.setUint16(28, name.length, true);
    dir.view.setUint32(42, offset, true);
    dir.bytes.set(name, 46);

    parts.push(local.bytes, entry.data);
    central.push(dir.bytes);
    offset += local.bytes.length + size;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + directorySize + 22 > MAX_BYTES) throw new Error('ZIP ist zu groß.');
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.bytes], { type: 'application/zip' });
}
