/** Minimale JPEG-Markeranalyse für DCTDecode-Streams. */

export interface JpegFrameInfo {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly precision: number;
  /** SOF-Typ (0xC0 baseline, 0xC2 progressive, ...). */
  readonly sofMarker: number;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

interface Segment {
  readonly marker: number;
  /** Start des Markers (0xFF). */
  readonly start: number;
  /** Ende des Segments (exklusiv). */
  readonly end: number;
}

/** Zählt die Segmente vor SOS auf. null bei ungültiger Struktur. */
function segmentsBeforeScan(bytes: Uint8Array): { segments: Segment[]; scanStart: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const segments: Segment[] = [];
  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) return null;
    const start = pos;
    while (pos < bytes.length && bytes[pos] === 0xff) pos++; // Füllbytes
    if (pos >= bytes.length) return null;
    const marker = bytes[pos]!;
    pos++;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segments.push({ marker, start, end: pos });
      continue;
    }
    if (pos + 2 > bytes.length) return null;
    const length = (bytes[pos]! << 8) | bytes[pos + 1]!;
    if (length < 2 || pos + length > bytes.length) return null;
    const end = pos + length;
    if (marker === 0xda) return { segments, scanStart: start };
    segments.push({ marker, start, end });
    pos = end;
  }
  return null;
}

export function readJpegFrame(bytes: Uint8Array): JpegFrameInfo | null {
  const parsed = segmentsBeforeScan(bytes);
  if (!parsed) return null;
  for (const segment of parsed.segments) {
    if (!SOF_MARKERS.has(segment.marker)) continue;
    // FF Cx | Länge(2) | Präzision(1) | Höhe(2) | Breite(2) | Komponenten(1)
    let p = segment.start;
    while (bytes[p] === 0xff) p++;
    p += 3; // Markerbyte + Länge
    if (p + 6 > segment.end) return null;
    return {
      precision: bytes[p]!,
      height: (bytes[p + 1]! << 8) | bytes[p + 2]!,
      width: (bytes[p + 3]! << 8) | bytes[p + 4]!,
      components: bytes[p + 5]!,
      sofMarker: segment.marker,
    };
  }
  return null;
}

/**
 * Entfernt APP1-Segmente (EXIF/XMP). PDF-Reader ignorieren die EXIF-Orientierung, Browser wenden
 * sie beim Dekodieren an – ohne Entfernen würden gedrehte Pixel in das PDF zurückgeschrieben.
 * Liefert die Eingabe unverändert, wenn es nichts zu entfernen gibt oder die Struktur unklar ist.
 */
export function stripJpegApp1(bytes: Uint8Array): Uint8Array {
  const parsed = segmentsBeforeScan(bytes);
  if (!parsed) return bytes;
  const app1 = parsed.segments.filter((s) => s.marker === 0xe1);
  if (app1.length === 0) return bytes;
  const removed = app1.reduce((sum, s) => sum + (s.end - s.start), 0);
  const out = new Uint8Array(bytes.length - removed);
  out.set(bytes.subarray(0, 2), 0);
  let offset = 2;
  for (const segment of parsed.segments) {
    if (segment.marker === 0xe1) continue;
    out.set(bytes.subarray(segment.start, segment.end), offset);
    offset += segment.end - segment.start;
  }
  out.set(bytes.subarray(parsed.scanStart), offset);
  return out;
}
