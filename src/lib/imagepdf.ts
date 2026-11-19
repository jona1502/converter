/**
 * Bild zu PDF: Einstellungen, Vorprüfung, Bündelbau und Meldungen.
 *
 * Alles hier läuft lokal; hochgeladen wird erst durch den ausdrücklichen Start (siehe
 * useImagePdfBatch). Der Server prüft jedes Bild erneut.
 */
import { ApiError, apiMessage } from './api/client';
import type { ApiSchemas } from './api/generated';
import { probeServerImage } from './api/probe';
import { formatBytes } from './format';
import { ImageProcessingError, LIMITS, type InputFormat } from './image';
import { buildStoredZip } from './zip';

/** Eingabeformate: die statischen Bildformate der Bildwerkzeuge, ohne ICO und AVIF. */
export const IMAGE_PDF_FORMATS: readonly InputFormat[] = ['jpeg', 'png', 'webp', 'gif', 'bmp'];
export const IMAGE_PDF_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,.jpg,.jpeg,.png,.webp,.gif,.bmp';

/** Startwerte bis capabilities.imagePdf eintrifft; entsprechen den Serverstandards. */
export interface ImagePdfLimits {
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalBytes: number;
  readonly maxOutputBytes: number;
  readonly maxPixels: number;
  readonly maxEdge: number;
}
export const IMAGE_PDF_LIMITS: ImagePdfLimits = {
  maxImages: 30,
  maxImageBytes: 52_428_800,
  maxTotalBytes: 104_857_600,
  maxOutputBytes: 104_857_600,
  maxPixels: LIMITS.maxPixels,
  maxEdge: LIMITS.maxEdge,
};

export type ImagePdfPageSize = NonNullable<ApiSchemas['ImagePdfOptions']['pageSize']>;
export type ImagePdfOrientation = NonNullable<ApiSchemas['ImagePdfOptions']['orientation']>;
export type ImagePdfMargin = NonNullable<ApiSchemas['ImagePdfOptions']['margin']>;
export interface ImagePdfSettings {
  readonly pageSize: ImagePdfPageSize;
  readonly orientation: ImagePdfOrientation;
  readonly margin: ImagePdfMargin;
}

export const DEFAULT_IMAGE_PDF_SETTINGS: ImagePdfSettings = { pageSize: 'a4', orientation: 'auto', margin: 'small' };

export const IMAGE_PDF_PAGE_SIZES: ReadonlyArray<{ value: ImagePdfPageSize; label: string }> = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'US Letter' },
  { value: 'fit', label: 'Bildgröße (Seite passt sich dem Bild an)' },
];
export const IMAGE_PDF_ORIENTATIONS: ReadonlyArray<{ value: ImagePdfOrientation; label: string }> = [
  { value: 'auto', label: 'Automatisch je Bild' },
  { value: 'portrait', label: 'Hochformat' },
  { value: 'landscape', label: 'Querformat' },
];
export const IMAGE_PDF_MARGINS: ReadonlyArray<{ value: ImagePdfMargin; label: string }> = [
  { value: 'none', label: 'Kein Rand' },
  { value: 'small', label: 'Klein (10 mm)' },
  { value: 'medium', label: 'Mittel (20 mm)' },
];

/** Bei „Bildgröße“ bestimmt das Bild die Seitenform; die Ausrichtung ist dann immer automatisch. */
export function normalizeImagePdfSettings(settings: ImagePdfSettings): ImagePdfSettings {
  return settings.pageSize === 'fit' ? { ...settings, orientation: 'auto' } : settings;
}

/** Optionen für POST /jobs; immer vollständig, damit der Idempotenzschlüssel zur Auswahl passt. */
export function buildImagePdfOptions(settings: ImagePdfSettings): ApiSchemas['ImagePdfOptions'] {
  const { pageSize, orientation, margin } = normalizeImagePdfSettings(settings);
  return { tool: 'image-pdf', pageSize, orientation, margin };
}

export function imagePdfPageLabel(settings: ImagePdfSettings): string {
  const { pageSize, orientation, margin } = normalizeImagePdfSettings(settings);
  const size = pageSize === 'fit' ? 'Bildgröße' : (IMAGE_PDF_PAGE_SIZES.find((entry) => entry.value === pageSize)?.label ?? pageSize);
  const parts = [size];
  if (pageSize !== 'fit') parts.push(IMAGE_PDF_ORIENTATIONS.find((entry) => entry.value === orientation)?.label ?? orientation);
  parts.push(IMAGE_PDF_MARGINS.find((entry) => entry.value === margin)?.label ?? margin);
  return parts.join(' · ');
}

/** Verschiebt den Eintrag an `index` um `delta` Plätze; unverändert (gleiche Referenz), wenn nicht möglich. */
export function moveItem<T>(items: readonly T[], index: number, delta: number): readonly T[] {
  const target = index + delta;
  if (!Number.isInteger(index) || index < 0 || index >= items.length || target < 0 || target >= items.length || target === index) return items;
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

export type ImageCheck =
  | { readonly ok: true; readonly format: InputFormat; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly code: string };

/** Header-Prüfung eines Bildes mit Serverlimits; ICO und AVIF gelten hier als nicht unterstützt. */
export async function checkImageForPdf(file: File, limits: ImagePdfLimits = IMAGE_PDF_LIMITS): Promise<ImageCheck> {
  if (file.size > limits.maxImageBytes) return { ok: false, code: 'file-too-large' };
  if (file.size === 0) return { ok: false, code: 'unsupported-type' };
  try {
    const probe = await probeServerImage(file, { maxFileBytes: limits.maxImageBytes, maxPixels: limits.maxPixels, maxEdge: limits.maxEdge });
    if (!IMAGE_PDF_FORMATS.includes(probe.format)) return { ok: false, code: 'unsupported-type' };
    return { ok: true, format: probe.format, width: probe.width, height: probe.height };
  } catch (error) {
    return { ok: false, code: error instanceof ImageProcessingError ? error.code : 'decode-failed' };
  }
}

const EXTENSION: Partial<Record<InputFormat, string>> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' };

/** Dateiname des Bündels; der Server leitet daraus den Namen der PDF ab. */
export const IMAGE_PDF_BUNDLE_NAME = 'bilder.zip';

/**
 * Baut das ZIP-Bündel: Einträge 001.ext, 002.ext, … in der gewählten Seitenreihenfolge.
 * Die Endung folgt dem erkannten Format; Originalnamen verlassen den Browser nicht.
 */
export async function buildImageBundle(items: ReadonlyArray<{ file: Blob; format: InputFormat }>): Promise<File> {
  const entries = items.map((item, index) => {
    const extension = EXTENSION[item.format];
    if (!extension) throw new Error('Nicht unterstütztes Bildformat.');
    return { name: `${String(index + 1).padStart(3, '0')}.${extension}`, data: item.file };
  });
  return new File([await buildStoredZip(entries)], IMAGE_PDF_BUNDLE_NAME, { type: 'application/zip' });
}

/** Grund, warum die gewählten Bilder (noch) nicht zusammen verarbeitet werden können; sonst null. */
export function imagePdfSelectionProblem(sizes: readonly number[], limits: ImagePdfLimits = IMAGE_PDF_LIMITS): string | null {
  if (sizes.length > limits.maxImages) return `Es sind höchstens ${limits.maxImages} Bilder pro PDF möglich.`;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > limits.maxTotalBytes) {
    return `Die Bilder sind zusammen ${formatBytes(total)} groß. Erlaubt sind höchstens ${formatBytes(limits.maxTotalBytes)}; entfernen Sie einzelne Bilder.`;
  }
  return null;
}

const numberDe = new Intl.NumberFormat('de-DE');

/** Meldung zu einem Vorprüfungs- oder Serverfehlercode für ein Bild bzw. das Bündel. */
export function imagePdfCodeMessage(code: string, limits: ImagePdfLimits = IMAGE_PDF_LIMITS): string | null {
  switch (code) {
    case 'unsupported-type':
      return 'Diese Datei ist kein unterstütztes Bild. Möglich sind JPEG, PNG, WebP, GIF und BMP; erkannt wird das Format am Dateiinhalt, nicht an der Endung.';
    case 'decode-failed':
      return 'Ein Bild konnte nicht gelesen werden. Es ist möglicherweise beschädigt oder unvollständig.';
    case 'file-too-large':
      return `Die Auswahl ist zu groß. Erlaubt sind höchstens ${formatBytes(limits.maxImageBytes)} je Bild, ${formatBytes(limits.maxTotalBytes)} zusammen und ${limits.maxImages} Bilder.`;
    case 'dimensions-too-large':
      return `Ein Bild ist zu groß. Erlaubt sind höchstens ${numberDe.format(limits.maxEdge)} Pixel je Kante und ${numberDe.format(limits.maxPixels / 1_000_000)} Megapixel.`;
    case 'animated-unsupported':
      return 'Animierte Bilder werden nicht unterstützt. Bitte verwenden Sie unbewegte Bilder.';
    case 'result-too-large':
      return `Die erzeugte PDF überschreitet die erlaubten ${formatBytes(limits.maxOutputBytes)}. Verwenden Sie weniger oder kleinere Bilder.`;
    case 'service-unavailable':
      return 'Bild zu PDF ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.';
    case 'encode-failed':
      return 'Aus diesen Bildern konnte keine PDF erstellt werden.';
    default:
      return null;
  }
}

export function imagePdfMessage(error: unknown, limits: ImagePdfLimits = IMAGE_PDF_LIMITS): string {
  return (error instanceof ApiError ? imagePdfCodeMessage(error.code, limits) : null) ?? apiMessage(error);
}
