/**
 * Lokale Vorprüfung einer PDF für PDF teilen: Signatur, Verschlüsselung und Seitenzahl.
 * Nichts wird hochgeladen. Kann die Seitenzahl nicht ermittelt werden (sehr große oder für den
 * Browser unlesbare Datei), bleibt sie `null`; dann prüft allein der Server die Bereiche.
 */
import { findPdfSignature } from './pdf/signature';

/** Ab dieser Größe wird die Datei nicht im Browser geparst, um den Tab nicht zu blockieren. */
export const LOCAL_PARSE_MAX_BYTES = 30_000_000;
const SIGNATURE_BYTES = 1024;

export type PdfInspection =
  | { readonly ok: true; readonly pageCount: number | null }
  | { readonly ok: false; readonly code: 'not-pdf' | 'encrypted' };

export async function inspectPdf(file: Blob): Promise<PdfInspection> {
  const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
  if (findPdfSignature(head) < 0) return { ok: false, code: 'not-pdf' };
  if (file.size > LOCAL_PARSE_MAX_BYTES) return { ok: true, pageCount: null };
  try {
    const { loadPdfDocument } = await import('./pdf/document');
    const doc = await loadPdfDocument(new Uint8Array(await file.arrayBuffer()));
    return { ok: true, pageCount: doc.getPageCount() };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'encrypted') return { ok: false, code: 'encrypted' };
    return { ok: true, pageCount: null };
  }
}
