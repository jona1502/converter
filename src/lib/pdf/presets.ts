import { PdfProcessingError, type PdfQualityLevel, type PdfQualityPreset } from './types';

/**
 * Stufenwerte.
 *
 * - targetDpi orientiert sich an den etablierten Ghostscript-Profilen (/printer 300 dpi,
 *   /ebook 150 dpi, /screen 72 dpi). „Kleine Datei“ nutzt 100 statt 72 dpi, weil 72 dpi auf
 *   heutigen Bildschirmen mit Skalierung sichtbar unscharf wirken.
 * - maxImageEdge greift immer, vor allem aber dann, wenn die Darstellungsgröße eines Bildes nicht
 *   ermittelbar ist: 3600 px entsprechen einer A4-Seite (11,7 in) bei gut 300 dpi, 2000 px rund
 *   170 dpi, 1300 px rund 110 dpi – passend zur jeweiligen DPI-Stufe für ganzseitige Bilder.
 * - jpegQuality: 0,85 gilt allgemein als visuell weitgehend verlustfrei, 0,72 als guter
 *   Kompromiss, 0,55 zeigt bei genauem Hinsehen Artefakte, spart aber deutlich.
 * - minDownscaleFactor 0,9: Verkleinerungen um weniger als 10 % werden nicht durchgeführt;
 *   die Neuabtastung kostet Schärfe, spart dann aber kaum.
 */
export const PDF_PRESETS: Readonly<Record<PdfQualityLevel, PdfQualityPreset>> = {
  high: { level: 'high', targetDpi: 300, maxImageEdge: 3600, jpegQuality: 0.85, minDownscaleFactor: 0.9 },
  balanced: { level: 'balanced', targetDpi: 150, maxImageEdge: 2000, jpegQuality: 0.72, minDownscaleFactor: 0.9 },
  small: { level: 'small', targetDpi: 100, maxImageEdge: 1300, jpegQuality: 0.55, minDownscaleFactor: 0.9 },
};

/**
 * Ein neu kodiertes Bild ersetzt das Original nur, wenn es höchstens diesen Anteil der alten
 * Bytes belegt (3 % Mindestersparnis). Ohne Verkleinerung der Pixel würde sonst für winzige
 * Ersparnisse ein weiterer JPEG-Generationsverlust in Kauf genommen.
 */
export const MAX_REPLACEMENT_RATIO = 0.97;

export function getPreset(level: unknown): PdfQualityPreset {
  if (level === 'high' || level === 'balanced' || level === 'small') return PDF_PRESETS[level];
  throw new PdfProcessingError('invalid-options', `Unbekannte Qualitätsstufe: ${String(level)}`);
}
