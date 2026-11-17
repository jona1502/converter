/**
 * Dateityp-Erkennung mit Format und Endungsabgleich für die Startseite. Maßgeblich ist der Inhalt
 * (erste Bytes), nicht Endung oder Browser-MIME-Typ; die Endung dient nur dem Hinweis bei
 * Abweichung. Alles bleibt lokal. Der Server prüft beim Upload erneut und ist maßgeblich.
 */
import { detectFormat } from './image/sniff';
import { INPUT_FORMAT_INFO } from './image/types';
import { AUDIO_FORMAT_INFO } from './audio/formats';
import { AUDIO_SNIFF_BYTES, sniffAudio } from './audio/sniff';
import { findPdfSignature } from './pdf/signature';
import { detectFileKind, type FileKind } from './quickstart';

export interface FileDetection {
  readonly kind: FileKind | null;
  /** Anzeigename des erkannten Formats („PNG“, „MP3“, „PDF“, „Markdown“), sonst null. */
  readonly formatLabel: string | null;
  /** Endungen, die zum erkannten Format passen. */
  readonly extensions: readonly string[];
}

const NONE: FileDetection = { kind: null, formatLabel: null, extensions: [] };

/** Reine Erkennung auf Kopfbytes (ohne Markdown, das den ganzen Text braucht). */
export function detectFromHead(head: Uint8Array): FileDetection {
  const image = detectFormat(head);
  if (image) return { kind: 'image', formatLabel: INPUT_FORMAT_INFO[image].label.replace(/ \(.*\)$/, ''), extensions: INPUT_FORMAT_INFO[image].extensions };
  if (findPdfSignature(head) >= 0) return { kind: 'pdf', formatLabel: 'PDF', extensions: ['pdf'] };
  const audio = sniffAudio(head);
  if (audio) return { kind: 'audio', formatLabel: AUDIO_FORMAT_INFO[audio].label, extensions: AUDIO_FORMAT_INFO[audio].inputExtensions };
  return NONE;
}

/** Erkennt Typ und Format einer Datei; unlesbare oder unbekannte Dateien ergeben `kind: null`. */
export async function detectFile(file: File): Promise<FileDetection> {
  try {
    const head = new Uint8Array(await file.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
    const signed = detectFromHead(head);
    if (signed.kind) return signed;
  } catch {
    return NONE;
  }
  return (await detectFileKind(file)) === 'markdown'
    ? { kind: 'markdown', formatLabel: 'Markdown', extensions: ['md', 'markdown'] }
    : NONE;
}

/**
 * Hinweis, wenn die Endung nicht zum Inhalt passt („Endung .jpg, Inhalt ist PNG“); sonst null.
 * Fehlende Endungen sind unkritisch und erzeugen keinen Hinweis.
 */
export function extensionNote(name: string, detection: FileDetection): string | null {
  if (!detection.formatLabel) return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  if (detection.extensions.includes(extension)) return null;
  return `Die Endung .${extension} passt nicht zum Inhalt. Erkannt wurde ${detection.formatLabel}; die Datei wird entsprechend ihrem Inhalt verarbeitet.`;
}
