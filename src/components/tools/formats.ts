/**
 * Format-Hilfen der Werkzeugoberfläche. Alle Listen, Labels und Endungen werden aus dem
 * Kernvertrag (IMAGE_FORMATS / FORMAT_INFO) abgeleitet, damit neue Formate ohne Änderungen
 * an den Komponenten erscheinen.
 */
import { IMAGE_FORMATS, INPUT_FORMATS as CORE_INPUT_FORMATS, INPUT_FORMAT_INFO, type InputFormat, type EncodeSupport, type ImageFormat } from '../../lib/image';

/** Formate, die als Eingabe angenommen werden (Erkennung im Kern anhand des Inhalts). */
export const INPUT_FORMATS: readonly InputFormat[] = CORE_INPUT_FORMATS;

/** Formate, die als Ziel wählbar sind (ob der Browser sie kodiert, sagt EncodeSupport). */
export const OUTPUT_FORMATS: readonly ImageFormat[] = IMAGE_FORMATS;

export function formatLabel(format: InputFormat): string {
  return INPUT_FORMAT_INFO[format].label;
}

/** Deutsche Aufzählung, z. B. „JPEG, PNG und WebP“. */
export function joinGerman(items: readonly string[]): string {
  return new Intl.ListFormat('de', { style: 'long', type: 'conjunction' }).format(items);
}

export function formatList(formats: readonly InputFormat[]): string {
  return joinGerman(formats.map(formatLabel));
}

/** Wert für das accept-Attribut: MIME-Typen und Endungen (jpg zusätzlich als jpeg). */
export function acceptAttribute(formats: readonly InputFormat[]): string {
  const parts = new Set<string>();
  for (const format of formats) {
    const info = INPUT_FORMAT_INFO[format];
    for (const mime of info.mimes) parts.add(mime);
    for (const extension of info.extensions) parts.add(`.${extension}`);
  }
  return [...parts].join(',');
}

/** Erstes kodierbares Format aus der Wunschliste, sonst das erste kodierbare überhaupt. */
export function pickDefaultFormat(support: EncodeSupport, preferred: readonly ImageFormat[]): ImageFormat | null {
  for (const format of [...preferred, ...OUTPUT_FORMATS]) {
    if (support[format]) return format;
  }
  return null;
}

