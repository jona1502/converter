/** PDF zusammenführen: lokale Vorprüfung, Reihenfolge und Meldungen. Nichts davon lädt Dateien hoch. */
import { ApiError, apiMessage } from './api/client';
import type { ApiSchemas } from './api/generated';
import { formatBytes } from './format';
import { findPdfSignature } from './pdf/signature';

export const PDF_MERGE_ACCEPT = '.pdf,application/pdf';
/** Vorgabe bis der Server seine Grenzen meldet; entspricht den Serverstandardwerten. */
export const PDF_MERGE_LIMITS = { minFiles: 2, maxFiles: 20, maxTotalBytes: 100_000_000, maxOutputBytes: 100_000_000, maxPages: 2000 };
export type PdfMergeLimits = typeof PDF_MERGE_LIMITS;

export function pdfMergeLimits(capabilities: ApiSchemas['PdfMergeCapabilities']): PdfMergeLimits {
  const { minFiles, maxFiles, maxTotalBytes, maxOutputBytes, maxPages } = capabilities;
  return { minFiles, maxFiles, maxTotalBytes, maxOutputBytes, maxPages };
}

/** Optionen für POST /jobs; das Werkzeug hat keine Einstellungen. */
export function buildPdfMergeOptions(): ApiSchemas['PdfMergeOptions'] {
  return { tool: 'pdf-merge' };
}

/**
 * Prüft Größe und PDF-Signatur im Browser. Verschlüsselung und Beschädigung erkennt erst der Server,
 * der die Datei bei Bedarf mit einem eindeutigen Fehler ablehnt.
 */
export async function checkPdfFile(file: File, maxBytes = PDF_MERGE_LIMITS.maxTotalBytes): Promise<{ ok: true } | { ok: false; code: string }> {
  if (file.size === 0) return { ok: false, code: 'unsupported-type' };
  if (file.size > maxBytes) return { ok: false, code: 'file-too-large' };
  try {
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    return findPdfSignature(head) >= 0 ? { ok: true } : { ok: false, code: 'not-pdf' };
  } catch {
    return { ok: false, code: 'unsupported-type' };
  }
}

/** Verschiebt das Element an `index` um `delta` Positionen; außerhalb des Bereichs bleibt die Liste gleich. */
export function moveItem<T>(items: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length || delta === 0) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Grund, warum die ausgewählten Dateien nicht zusammengeführt werden können; null = möglich. */
export function selectionIssue(sizes: readonly number[], limits: PdfMergeLimits): string | null {
  if (sizes.length < limits.minFiles) return `Wählen Sie mindestens ${limits.minFiles} PDF-Dateien aus.`;
  if (sizes.length > limits.maxFiles) return `Es sind höchstens ${limits.maxFiles} PDF-Dateien möglich.`;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > limits.maxTotalBytes) return `Alle PDFs zusammen dürfen höchstens ${formatBytes(limits.maxTotalBytes)} groß sein.`;
  return null;
}

export function pdfMergeMessage(error: unknown, limits: PdfMergeLimits = PDF_MERGE_LIMITS): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'not-pdf': return 'Mindestens eine Datei ist keine erkennbare PDF.';
      case 'unsupported-type': return 'Mindestens eine Datei ist leer oder keine PDF.';
      case 'encrypted': return 'Mindestens eine PDF ist verschlüsselt. Verschlüsselte PDFs können nicht zusammengeführt werden.';
      case 'parse-failed': return 'Mindestens eine PDF ist beschädigt oder kann nicht gelesen werden.';
      case 'file-too-large': return `Die PDFs sind zu groß. Alle zusammen dürfen höchstens ${formatBytes(limits.maxTotalBytes)} groß sein.`;
      case 'result-too-large': return `Die zusammengeführte PDF überschreitet die erlaubten ${formatBytes(limits.maxOutputBytes)}.`;
      case 'dimensions-too-large': return `Die zusammengeführte PDF überschreitet die erlaubten ${limits.maxPages} Seiten.`;
      case 'missing-file': return `Wählen Sie ${limits.minFiles} bis ${limits.maxFiles} PDF-Dateien aus.`;
      case 'service-unavailable': return 'PDF zusammenführen ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
      case 'save-failed': case 'encode-failed': case 'decode-failed': return 'Aus diesen PDFs konnte keine zusammengeführte PDF erstellt werden.';
    }
  }
  return apiMessage(error);
}
