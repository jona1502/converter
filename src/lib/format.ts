/**
 * Einheitliche Größen- und Änderungsangaben für alle Werkzeuge.
 *
 * Regeln für formatBytes:
 * - dezimale Einheiten: 1 KB = 1.000 Bytes, 1 MB = 1.000.000 Bytes; deutsche Zahlenformatierung,
 *   geschütztes Leerzeichen vor der Einheit;
 * - unter 1.000.000 Bytes in KB, ab 1.000.000 Bytes in MB;
 * - KB: unter 10 KB höchstens eine Nachkommastelle („0,4 KB“, „9,9 KB“), sonst ganze Zahlen;
 * - MB: unter 10 MB höchstens zwei Nachkommastellen („1,23 MB“), sonst höchstens eine;
 * - 0 Bytes → „0 KB“; 1 bis 49 Bytes → „< 0,1 KB“ (würde sonst als 0 KB erscheinen);
 * - 999.500 bis 999.999 Bytes ergäben gerundet „1.000 KB“, obwohl sie unter der MB-Grenze liegen;
 *   sie werden abgerundet als „999 KB“ angezeigt;
 * - negative oder nicht endliche Werte → RangeError.
 */

const NBSP = ' ';
const MINUS = '−';

const formatters = new Map<number, Intl.NumberFormat>();

function formatNumber(value: number, maxFractionDigits: number): string {
  let formatter = formatters.get(maxFractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: maxFractionDigits });
    formatters.set(maxFractionDigits, formatter);
  }
  return formatter.format(value);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`Ungültige Bytezahl: ${bytes}`);
  if (bytes === 0) return `0${NBSP}KB`;
  if (bytes < 1_000_000) {
    if (bytes < 50) return `<${NBSP}${formatNumber(0.1, 1)}${NBSP}KB`;
    const kb = bytes / 1000;
    const digits = kb < 10 ? 1 : 0;
    let rounded = roundTo(kb, digits);
    if (rounded >= 1000) rounded = 999;
    return `${formatNumber(rounded, digits)}${NBSP}KB`;
  }
  const mb = bytes / 1_000_000;
  const digits = mb < 10 ? 2 : 1;
  return `${formatNumber(roundTo(mb, digits), digits)}${NBSP}MB`;
}

export type SizeChangeKind = 'smaller' | 'equal' | 'larger';

export interface SizeChange {
  /**
   * Prozentuale Änderung mit Vorzeichen (Minuszeichen U+2212), z. B. „−42 %“, „+3,5 %“, „0 %“.
   * Ab 10 % ganzzahlig, von 1 bis unter 10 % mit höchstens einer, darunter mit höchstens zwei
   * Nachkommastellen. Von null verschiedene Änderungen unter 0,01 % als „< 0,01 %“ (die Richtung
   * steht in kind), damit nie fälschlich „0 %“ erscheint.
   */
  readonly percent: string;
  /** Ungerundete Änderung in Prozent (negativ = kleiner). */
  readonly value: number;
  /** Byte-genauer Vergleich. */
  readonly kind: SizeChangeKind;
}

export function formatSizeChange(original: number, result: number): SizeChange {
  if (!Number.isFinite(original) || original <= 0) throw new RangeError(`Ungültige Originalgröße: ${original}`);
  if (!Number.isFinite(result) || result < 0) throw new RangeError(`Ungültige Ergebnisgröße: ${result}`);
  const value = ((result - original) / original) * 100;
  const kind: SizeChangeKind = result < original ? 'smaller' : result > original ? 'larger' : 'equal';
  if (kind === 'equal') return { percent: `0${NBSP}%`, value: 0, kind };
  const magnitude = Math.abs(value);
  const digits = magnitude >= 10 ? 0 : magnitude >= 1 ? 1 : 2;
  const rounded = roundTo(magnitude, digits);
  if (rounded === 0) return { percent: `<${NBSP}${formatNumber(0.01, 2)}${NBSP}%`, value, kind };
  const sign = kind === 'smaller' ? MINUS : '+';
  return { percent: `${sign}${formatNumber(rounded, digits)}${NBSP}%`, value, kind };
}

/** Aufbewahrungsdauer als deutsche Angabe („1 Stunde“, „30 Minuten“); ungültig oder < 1 s → ''. */
export function formatRetention(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return '';
  const unit = (n: number, one: string, many: string) => `${formatNumber(n, 0)}${NBSP}${n === 1 ? one : many}`;
  if (seconds >= 86_400 && seconds % 86_400 === 0) return unit(seconds / 86_400, 'Tag', 'Tage');
  if (seconds >= 3_600 && seconds % 3_600 === 0) return unit(seconds / 3_600, 'Stunde', 'Stunden');
  if (seconds >= 60) return unit(Math.round(seconds / 60), 'Minute', 'Minuten');
  return unit(Math.round(seconds), 'Sekunde', 'Sekunden');
}
