/**
 * PDF zu Bild: Einstellungen, Seitenauswahl, Optionen für den Server und lokale Vorprüfung.
 * Rendern geschieht ausschließlich auf dem Server; hier wird nichts hochgeladen. Die Regeln der
 * Seitenauswahl entsprechen server/internal/jobs/pdfimage.go.
 */
import { PdfProcessingError } from './pdf/types';
import { findPdfSignature } from './pdf/signature';
import { ApiError, apiMessage } from './api/client';
import type { ApiSchemas } from './api/generated';
import { formatBytes } from './format';

export const PDF_IMAGE_ACCEPT = '.pdf,application/pdf';
/** Startwerte bis der Server seine Grenzen meldet (capabilities.pdfImage). */
export const PDF_IMAGE_LIMITS = {
  maxFileBytes: 100_000_000,
  maxOutputBytes: 300_000_000,
  maxPages: 100,
  maxPixels: 40_000_000,
  minDpi: 72,
  maxDpi: 300,
  defaultDpi: 150,
};
export type PdfImageLimits = typeof PDF_IMAGE_LIMITS;

export type PdfImageFormat = ApiSchemas['PdfImageOptions']['format'];
export const PDF_IMAGE_FORMATS: ReadonlyArray<{ value: PdfImageFormat; label: string }> = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];
/** Angebotene Auflösungen; der Server erlaubt jeden ganzzahligen Wert von 72 bis 300. */
export const PDF_IMAGE_DPI: ReadonlyArray<{ value: number; label: string }> = [
  { value: 72, label: '72 dpi (Bildschirm, klein)' },
  { value: 150, label: '150 dpi (Standard)' },
  { value: 300, label: '300 dpi (Druck, groß)' },
];

export type PageMode = 'all' | 'selection';
export interface PdfImageSettings {
  readonly format: PdfImageFormat;
  readonly dpi: number;
  readonly mode: PageMode;
  /** Eingabe wie „1-3, 5“; nur bei mode 'selection' wirksam. */
  readonly selection: string;
}
export const DEFAULT_PDF_IMAGE_SETTINGS: PdfImageSettings = { format: 'png', dpi: 150, mode: 'all', selection: '' };

export type SelectionFailure = 'syntax' | 'range' | 'beyond' | 'too-many';
export type PageSelection = { ok: true; pages: number[] } | { ok: false; reason: SelectionFailure };
const MAX_PAGE_NUMBER = 9999;
const TOKEN = /^([0-9]+)(?:\s*-\s*([0-9]+))?$/;

/** Liest „1-3, 5“; sortiert, ohne Duplikate. Leerzeichen um Komma und Bindestrich sind erlaubt. */
export function parsePageSelection(text: string, limits: { pageCount?: number; maxPages?: number } = {}): PageSelection {
  const maxPages = limits.maxPages ?? PDF_IMAGE_LIMITS.maxPages;
  if (!text.trim()) return { ok: false, reason: 'syntax' };
  const seen = new Set<number>();
  for (const raw of text.split(',')) {
    const match = TOKEN.exec(raw.trim());
    if (!match) return { ok: false, reason: 'syntax' };
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first < 1 || last < first || last > MAX_PAGE_NUMBER) return { ok: false, reason: 'range' };
    if (limits.pageCount !== undefined && last > limits.pageCount) return { ok: false, reason: 'beyond' };
    if (last - first + 1 > maxPages) return { ok: false, reason: 'too-many' };
    for (let page = first; page <= last; page++) seen.add(page);
    if (seen.size > maxPages) return { ok: false, reason: 'too-many' };
  }
  return { ok: true, pages: [...seen].sort((a, b) => a - b) };
}

/** Kanonische Kurzschreibweise des Servers: Läufe als „a-b“, ohne Leerzeichen. */
export function normalizePageSelection(pages: readonly number[]): string {
  const parts: string[] = [];
  let start = pages[0]!;
  let previous = start;
  const flush = () => parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    flush();
    start = previous = page;
  }
  flush();
  return parts.join(',');
}

/** Seiten, die der Auftrag rendert; bei unbekannter Seitenzahl und „alle“ ist `pages` undefined. */
export function resolvePages(
  settings: PdfImageSettings,
  pageCount: number | undefined,
  maxPages = PDF_IMAGE_LIMITS.maxPages,
): { ok: true; pages: number[] | undefined } | { ok: false; reason: SelectionFailure } {
  if (settings.mode === 'selection') return parsePageSelection(settings.selection, { pageCount, maxPages });
  if (pageCount === undefined) return { ok: true, pages: undefined };
  if (pageCount > maxPages) return { ok: false, reason: 'too-many' };
  return { ok: true, pages: Array.from({ length: pageCount }, (_, index) => index + 1) };
}

/** Genau eine ausdrücklich gewählte Seite ergibt ein Bild, jede andere Auswahl ein ZIP. */
export function resultKind(settings: PdfImageSettings, pageCount: number | undefined): 'image' | 'archive' {
  if (settings.mode === 'selection') {
    const parsed = parsePageSelection(settings.selection);
    return parsed.ok && parsed.pages.length === 1 ? 'image' : 'archive';
  }
  return pageCount === 1 ? 'image' : 'archive';
}

/**
 * Optionen für POST /jobs, immer vollständig, damit der Idempotenzschlüssel zur Auswahl passt.
 * Bei einseitigen PDFs wird die Seite 1 ausdrücklich gewählt, damit ein Bild statt eines
 * Archivs entsteht. Wirft bei ungültiger Seitenauswahl.
 */
export function buildPdfImageOptions(settings: PdfImageSettings, pageCount?: number): ApiSchemas['PdfImageOptions'] {
  let pages = 'all';
  if (settings.mode === 'selection') {
    const parsed = parsePageSelection(settings.selection, { pageCount });
    if (!parsed.ok) throw new Error(`Ungültige Seitenauswahl: ${parsed.reason}`);
    pages = normalizePageSelection(parsed.pages);
  } else if (pageCount === 1) {
    pages = '1';
  }
  return { tool: 'pdf-to-image', format: settings.format, dpi: settings.dpi, pages };
}

export type PdfCheck = { ok: true; pageCount: number | undefined } | { ok: false; code: string };

/**
 * Lokale Prüfung ohne Upload: Größe, Signatur, Verschlüsselung und Seitenzahl. Kann pdf-lib das
 * Dokument nicht lesen, entscheidet der Server (pageCount bleibt unbekannt).
 */
export async function checkPdfFile(file: File, maxBytes = PDF_IMAGE_LIMITS.maxFileBytes): Promise<PdfCheck> {
  if (file.size > maxBytes) return { ok: false, code: 'file-too-large' };
  if (file.size === 0) return { ok: false, code: 'not-pdf' };
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (findPdfSignature(head) < 0) return { ok: false, code: 'not-pdf' };
  try {
    // pdf-lib erst bei Bedarf laden: Die Startseite nutzt nur die Signaturprüfung.
    const { loadPdfDocument } = await import('./pdf/document');
    const document = await loadPdfDocument(new Uint8Array(await file.arrayBuffer()));
    return { ok: true, pageCount: document.getPageCount() };
  } catch (error) {
    if (error instanceof PdfProcessingError && error.code === 'encrypted') return { ok: false, code: 'encrypted' };
    return { ok: true, pageCount: undefined };
  }
}

export function pdfImageMessage(error: unknown, limits: PdfImageLimits = PDF_IMAGE_LIMITS): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'not-pdf': return 'Die Datei ist keine erkennbare PDF.';
      case 'encrypted': return 'Verschlüsselte PDFs werden nicht unterstützt. Entfernen Sie den Schutz und versuchen Sie es erneut.';
      case 'parse-failed': return 'Die PDF ist beschädigt, kann nicht gelesen werden oder enthält die gewählten Seiten nicht.';
      case 'file-too-large': return `Die PDF ist zu groß. Erlaubt sind höchstens ${formatBytes(limits.maxFileBytes)}.`;
      case 'dimensions-too-large': return `Mindestens eine Seite wäre bei dieser Auflösung größer als ${limits.maxPixels / 1_000_000} Megapixel. Wählen Sie eine niedrigere Auflösung oder andere Seiten.`;
      case 'result-too-large': return `Das Ergebnis wäre zu groß: Erlaubt sind höchstens ${limits.maxPages} Seiten je Auftrag und ${formatBytes(limits.maxOutputBytes)} Ausgabe. Wählen Sie weniger Seiten oder eine niedrigere Auflösung.`;
      case 'service-unavailable': return 'PDF zu Bild ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
      case 'timeout': return 'Die Verarbeitung hat das Zeitlimit überschritten. Wählen Sie weniger Seiten oder eine niedrigere Auflösung.';
      case 'invalid-options': return 'Bitte prüfen Sie Format, Auflösung und Seitenauswahl.';
    }
  }
  return apiMessage(error);
}

/** Meldung zu einer ungültigen Seitenauswahl (Eingabefeld). */
export function selectionMessage(reason: SelectionFailure, pageCount: number | undefined, maxPages = PDF_IMAGE_LIMITS.maxPages): string {
  switch (reason) {
    case 'syntax': return 'Geben Sie Seitenzahlen und Bereiche an, getrennt durch Kommas, zum Beispiel „1-3, 5“.';
    case 'range': return 'Seitennummern beginnen bei 1; bei Bereichen muss die erste Seite vor der letzten liegen.';
    case 'beyond': return `Die PDF hat nur ${pageCount} ${pageCount === 1 ? 'Seite' : 'Seiten'}.`;
    case 'too-many': return `Höchstens ${maxPages} Seiten je Auftrag. Wählen Sie weniger Seiten.`;
  }
}
