/**
 * Native (De-)Kompression über CompressionStream/DecompressionStream und PNG-Predictor.
 * Format 'deflate' entspricht dem zlib-Format von /FlateDecode.
 */

async function collect(readable: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        complete = false;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // Beschädigte Daten oder fehlende Prüfsumme: bis dahin gelesene Bytes bleiben verwertbar.
    complete = false;
  }
  const bytes = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const part = chunk.byteLength > bytes.length - offset ? chunk.subarray(0, bytes.length - offset) : chunk;
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, complete };
}

function feed(writable: WritableStream<BufferSource>, data: Uint8Array): void {
  const writer = writable.getWriter();
  // Fehler werden über die Leseseite sichtbar; hier nur unbehandelte Rejections vermeiden.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);
}

/**
 * Entpackt zlib-Daten, höchstens maxBytes (Schutz vor Dekompressionsbomben).
 * complete = false, wenn abgeschnitten wurde oder die Daten am Ende beschädigt sind.
 */
export async function inflate(data: Uint8Array, maxBytes: number): Promise<{ bytes: Uint8Array; complete: boolean }> {
  const ds = new DecompressionStream('deflate');
  feed(ds.writable, data);
  return collect(ds.readable, maxBytes);
}

/** Komprimiert verlustfrei im zlib-Format (für /FlateDecode). */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  feed(cs.writable, data);
  const { bytes, complete } = await collect(cs.readable, Number.MAX_SAFE_INTEGER);
  if (!complete) throw new Error('Kompression fehlgeschlagen.');
  return bytes;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Kehrt PNG-Predictoren (Predictor >= 10, 8 bit je Kanal) um: jede Zeile beginnt mit einem
 * Filterbyte (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). Liefert null bei zu kurzen Daten oder
 * unbekanntem Filtertyp.
 */
export function undoPngPredictor(data: Uint8Array, width: number, height: number, colors: number): Uint8Array | null {
  const rowBytes = width * colors;
  if (data.length < height * (rowBytes + 1)) return null;
  const out = new Uint8Array(height * rowBytes);
  const bpp = colors;
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const prev = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x]!;
      const left = x >= bpp ? out[dst + x - bpp]! : 0;
      const up = y > 0 ? out[prev + x]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp]! : 0;
          value = raw + paeth(left, up, upLeft);
          break;
        }
        default:
          return null;
      }
      out[dst + x] = value & 0xff;
    }
  }
  return out;
}
