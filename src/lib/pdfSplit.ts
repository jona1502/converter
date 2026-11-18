/**
 * PDF teilen: strenge Seitenbereichs-Syntax, Optionen und Meldungen.
 *
 * Die Grammatik ist mit Go (`server/internal/pagerange`) und dem Konverter identisch und wird
 * gegen `api/page-range-vectors.json` getestet: `liste = bereich *("," bereich)`,
 * `bereich = zahl ["-" [zahl]]`, Zahlen 1 bis 99999 ohne führende Nullen, nur ASCII-Ziffern,
 * kein Leerraum. `7-` heißt bis zur letzten Seite. Bereiche dürfen sich überlappen.
 */
import { ApiError, apiMessage } from './api/client';
import type { ApiSchemas } from './api/generated';
import { formatBytes } from './format';

export const MAX_PAGE_NUMBER = 99_999;
export const MAX_RANGES = 500;
export const MAX_RANGES_LENGTH = 1024;
export const SPLIT_LIMITS = { maxFileBytes: 100_000_000, maxOutputBytes: 300_000_000, maxParts: MAX_RANGES };

/** Ein Bereich (1-basiert, einschließlich); `end === null` heißt: bis zur letzten Seite. */
export interface PageRange { readonly start: number; readonly end: number | null }

export type RangeProblem =
  | 'empty' | 'too-long' | 'too-many' | 'whitespace' | 'syntax' | 'zero' | 'descending' | 'too-large';
export type RangeParse =
  | { readonly ok: true; readonly ranges: readonly PageRange[] }
  | { readonly ok: false; readonly problem: RangeProblem; /** Nullbasierter Index des fehlerhaften Bereichs. */ readonly item: number };

const ITEM = /^([1-9][0-9]{0,4})(?:(-)([1-9][0-9]{0,4})?)?$/;

/** Ursache eines fehlerhaften Bereichs für die Meldung (die Prüfung selbst macht ITEM). */
function problemOf(item: string): RangeProblem {
  if (/\s/.test(item)) return 'whitespace';
  const shape = /^([0-9]+)(?:-([0-9]*))?$/.exec(item);
  if (!shape) return 'syntax';
  for (const number of [shape[1], shape[2]]) {
    if (!number) continue;
    if (number.startsWith('0')) return 'zero';
    if (number.length > 5) return 'too-large';
  }
  return 'syntax';
}

/** Prüft die Angabe vollständig und liefert die Bereiche in Eingabereihenfolge. */
export function parsePageRanges(spec: string): RangeParse {
  if (spec === '') return { ok: false, problem: 'empty', item: 0 };
  if (spec.length > MAX_RANGES_LENGTH) return { ok: false, problem: 'too-long', item: 0 };
  const items = spec.split(',');
  if (items.length > MAX_RANGES) return { ok: false, problem: 'too-many', item: MAX_RANGES };
  const ranges: PageRange[] = [];
  for (const [index, item] of items.entries()) {
    const match = ITEM.exec(item);
    if (!match) return { ok: false, problem: problemOf(item), item: index };
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[3] === undefined ? null : Number(match[3]);
    if (end !== null && end < start) return { ok: false, problem: 'descending', item: index };
    ranges.push({ start, end });
  }
  return { ok: true, ranges };
}

export type SplitMode = ApiSchemas['SplitOptions']['mode'];
export interface SplitSettings { readonly mode: SplitMode; readonly ranges: string }
export const DEFAULT_SPLIT_SETTINGS: SplitSettings = { mode: 'ranges', ranges: '' };

export function describePart(range: PageRange): string {
  if (range.end === null) return `Seiten ${range.start} bis zum Ende`;
  return range.end === range.start ? `Seite ${range.start}` : `Seiten ${range.start}–${range.end}`;
}

export type SettingsCheck =
  | { readonly ok: true; readonly parts: number | null; readonly zip: boolean }
  | { readonly ok: false; readonly message: string };

const PROBLEMS: Record<RangeProblem, (item: number) => string> = {
  empty: () => 'Bitte geben Sie die Seitenbereiche an, zum Beispiel 1-3,5,7-.',
  'too-long': () => `Die Angabe ist zu lang (höchstens ${MAX_RANGES_LENGTH} Zeichen).`,
  'too-many': () => `Es sind höchstens ${MAX_RANGES} Bereiche erlaubt.`,
  whitespace: (item) => `Bereich ${item + 1}: Leerzeichen sind nicht erlaubt. Schreiben Sie zum Beispiel 1-3,5,7-.`,
  syntax: (item) => `Bereich ${item + 1} ist ungültig. Erlaubt sind einzelne Seiten (5), Bereiche (1-3) und offene Bereiche (7-), getrennt durch Kommas.`,
  zero: (item) => `Bereich ${item + 1}: Seitenzahlen beginnen bei 1 und haben keine führenden Nullen.`,
  descending: (item) => `Bereich ${item + 1}: Das Ende liegt vor dem Anfang.`,
  'too-large': (item) => `Bereich ${item + 1}: Seitenzahlen sind bis ${MAX_PAGE_NUMBER} erlaubt.`,
};

/**
 * Prüft die Einstellungen. Mit bekannter Seitenzahl wird auch geprüft, ob alle Bereiche im
 * Dokument liegen. Genau ein Bereich ergibt eine PDF, alles andere ein ZIP (wie auf dem Server).
 */
export function checkSplitSettings(settings: SplitSettings, pageCount: number | null, maxParts = MAX_RANGES): SettingsCheck {
  if (settings.mode === 'each') {
    if (pageCount !== null && pageCount > maxParts) {
      return { ok: false, message: `Das Dokument hat ${pageCount} Seiten; je Seite einzeln sind höchstens ${maxParts} Teile möglich. Wählen Sie Bereiche.` };
    }
    return { ok: true, parts: pageCount, zip: true };
  }
  const parsed = parsePageRanges(settings.ranges);
  if (!parsed.ok) return { ok: false, message: PROBLEMS[parsed.problem](parsed.item) };
  if (parsed.ranges.length > maxParts) return { ok: false, message: PROBLEMS['too-many'](0) };
  if (pageCount !== null) {
    for (const [index, range] of parsed.ranges.entries()) {
      const last = range.end ?? range.start;
      if (range.start > pageCount || last > pageCount) {
        return { ok: false, message: `Bereich ${index + 1} liegt außerhalb des Dokuments; es hat ${pageCount} ${pageCount === 1 ? 'Seite' : 'Seiten'}.` };
      }
    }
  }
  return { ok: true, parts: parsed.ranges.length, zip: parsed.ranges.length !== 1 };
}

/** Optionen für POST /jobs; setzt voraus, dass `checkSplitSettings` erfolgreich war. */
export function buildSplitOptions(settings: SplitSettings): ApiSchemas['SplitOptions'] {
  return settings.mode === 'each'
    ? { tool: 'pdf-split', mode: 'each' }
    : { tool: 'pdf-split', mode: 'ranges', ranges: settings.ranges };
}

export function splitMessage(error: unknown, limits = SPLIT_LIMITS): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'page-range-invalid': return 'Die Seitenbereiche passen nicht zu dieser PDF. Prüfen Sie die Seitenzahl und versuchen Sie es erneut.';
      case 'file-too-large': return `Die PDF ist zu groß. Erlaubt sind höchstens ${formatBytes(limits.maxFileBytes)}.`;
      case 'result-too-large': return `Das Ergebnis überschreitet die erlaubten ${formatBytes(limits.maxOutputBytes)}.`;
      case 'service-unavailable': return 'PDF teilen ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
      case 'invalid-options': return 'Die Seitenbereiche wurden vom Server abgelehnt. Bitte prüfen Sie die Angabe.';
    }
  }
  return apiMessage(error);
}
