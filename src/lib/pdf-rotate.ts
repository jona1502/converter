/** PDF drehen: Einstellungen, Optionen für POST /jobs, lokale Vorprüfung und Fehlermeldungen. */
import { ApiError, apiMessage } from './api/client';
import type { ApiSchemas } from './api/generated';
import { formatBytes } from './format';
import { findPdfSignature } from './pdf/signature';

export const PDF_ROTATE_ACCEPT = '.pdf,application/pdf';
/** Startwerte bis der Server seine Grenzen meldet (wie PDF_MAX_INPUT_BYTES / Gesamtbudget). */
export const PDF_ROTATE_LIMITS = { maxFileBytes: 100_000_000, maxOutputBytes: 300_000_000 };

export type PdfRotateAngle = ApiSchemas['PdfRotateOptions']['angle'];
export type PdfRotateScope = 'all' | 'range';
export interface PdfRotateSettings {
  readonly angle: PdfRotateAngle;
  readonly scope: PdfRotateScope;
  /** Seitenangabe wie „1-3,5“; nur bei scope „range“ relevant. */
  readonly pages: string;
}
export const DEFAULT_PDF_ROTATE_SETTINGS: PdfRotateSettings = { angle: 90, scope: 'all', pages: '' };
export const PDF_ROTATE_ANGLES: ReadonlyArray<{ value: PdfRotateAngle; label: string }> = [
  { value: 90, label: '90° nach rechts' },
  { value: 180, label: '180°' },
  { value: 270, label: '90° nach links (270°)' },
];

const MAX_PAGES_SPEC = 256;
const PAGES = /^[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?(,[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?)*$/;

export type PagesResult = { ok: true; value: string } | { ok: false; message: string };

/** Normalisiert (ohne Leerraum, mit „-“) und prüft die Seitenangabe wie der Server; ob die Seiten existieren, prüft erst er. */
export function parsePdfPages(input: string): PagesResult {
  const text = input.replace(/\s+/g, '').replace(/[‐-―−]/g, '-');
  if (!text) return { ok: false, message: 'Geben Sie mindestens eine Seite oder einen Bereich an, z. B. 1-3,5.' };
  if (text.length > MAX_PAGES_SPEC || !PAGES.test(text)) {
    return { ok: false, message: 'Die Seitenangabe ist ungültig. Erlaubt sind Seitenzahlen ab 1 und Bereiche wie 1-3, getrennt durch Kommas.' };
  }
  for (const part of text.split(',')) {
    const [first, last] = part.split('-').map(Number);
    if (last !== undefined && first! > last) {
      return { ok: false, message: `Der Bereich ${part} ist umgekehrt. Geben Sie zuerst die kleinere Seite an.` };
    }
  }
  return { ok: true, value: text };
}

/** Optionen für POST /jobs; immer vollständig, damit der Idempotenzschlüssel zur Auswahl passt. */
export function buildPdfRotateOptions(settings: PdfRotateSettings): ApiSchemas['PdfRotateOptions'] {
  if (settings.scope === 'all') return { tool: 'pdf-rotate', angle: settings.angle, pages: 'all' };
  const pages = parsePdfPages(settings.pages);
  if (!pages.ok) throw new Error(pages.message);
  return { tool: 'pdf-rotate', angle: settings.angle, pages: pages.value };
}

export function describePdfRotateSettings(settings: PdfRotateSettings): string {
  const angle = `${settings.angle}° im Uhrzeigersinn`;
  if (settings.scope === 'all') return `${angle}, alle Seiten`;
  const pages = parsePdfPages(settings.pages);
  return `${angle}, Seiten ${pages.ok ? pages.value : settings.pages.trim()}`;
}

/** Größe und Signatur lokal prüfen; lädt nichts hoch. Verschlüsselung und Seitenzahl prüft der Server. */
export async function checkPdfRotateFile(
  file: File,
  maxBytes = PDF_ROTATE_LIMITS.maxFileBytes,
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (file.size === 0) return { ok: false, code: 'unsupported-type' };
  if (file.size > maxBytes) return { ok: false, code: 'file-too-large' };
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  return findPdfSignature(head) >= 0 ? { ok: true } : { ok: false, code: 'not-pdf' };
}

export function pdfRotateMessage(error: unknown, limits: { maxFileBytes?: number; maxOutputBytes?: number } = {}): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'unsupported-type': return 'Bitte wählen Sie eine nicht leere PDF-Datei.';
      case 'not-pdf': return 'Die Datei ist keine erkennbare PDF.';
      case 'encrypted': return 'Verschlüsselte PDFs werden nicht unterstützt. Entfernen Sie zuerst den Passwortschutz.';
      case 'parse-failed': return 'Die PDF ist beschädigt oder kann nicht gelesen werden.';
      case 'file-too-large': return `Die PDF ist zu groß. Erlaubt sind höchstens ${formatBytes(limits.maxFileBytes ?? PDF_ROTATE_LIMITS.maxFileBytes)}.`;
      case 'result-too-large': return `Die gedrehte PDF überschreitet die erlaubten ${formatBytes(limits.maxOutputBytes ?? PDF_ROTATE_LIMITS.maxOutputBytes)}.`;
      case 'invalid-options': return 'Die gewählten Seiten passen nicht zur PDF. Prüfen Sie, ob alle Seiten im Dokument vorhanden sind.';
      case 'service-unavailable': return 'PDF drehen ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
    }
  }
  return apiMessage(error);
}
