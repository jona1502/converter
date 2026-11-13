/**
 * Audioformate des Werkzeugs „Audio konvertieren“ (Vertrag: docs/backend/api-contract.md, Audio).
 * Eingabe und Ausgabe: MP3, WAV, FLAC, OGG. Kein M4A/AAC.
 */

export const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'ogg'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export interface AudioFormatInfo {
  /** Anzeigename. */
  readonly label: string;
  /** Endung des Ergebnisses. */
  readonly extension: string;
  /** Endungen, die als Eingabe angeboten werden (Erkennung trotzdem am Inhalt). */
  readonly inputExtensions: readonly string[];
  /** MIME-Typen für das accept-Attribut. */
  readonly mimes: readonly string[];
  /** Verlustbehaftet: Nur hier wirkt eine Qualitätseinstellung. */
  readonly lossy: boolean;
}

export const AUDIO_FORMAT_INFO: Readonly<Record<AudioFormat, AudioFormatInfo>> = {
  mp3: { label: 'MP3', extension: 'mp3', inputExtensions: ['mp3'], mimes: ['audio/mpeg', 'audio/mp3'], lossy: true },
  wav: { label: 'WAV', extension: 'wav', inputExtensions: ['wav'], mimes: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'], lossy: false },
  flac: { label: 'FLAC', extension: 'flac', inputExtensions: ['flac'], mimes: ['audio/flac', 'audio/x-flac'], lossy: false },
  ogg: { label: 'OGG', extension: 'ogg', inputExtensions: ['ogg', 'oga', 'opus'], mimes: ['audio/ogg', 'audio/opus'], lossy: true },
};

/** Endungen von Formaten, die ausdrücklich nicht unterstützt werden (eigene Fehlermeldung). */
const AAC_EXTENSIONS: ReadonlySet<string> = new Set(['m4a', 'm4b', 'm4p', 'aac', 'mp4', 'adts']);

export function isAudioFormat(value: unknown): value is AudioFormat {
  return typeof value === 'string' && (AUDIO_FORMATS as readonly string[]).includes(value);
}

export function audioFormatLabel(format: AudioFormat): string {
  return AUDIO_FORMAT_INFO[format].label;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** true bei Dateinamen mit M4A-/AAC-Endung, die der Server nicht verarbeiten kann. */
export function hasAacExtension(name: string): boolean {
  return AAC_EXTENSIONS.has(extensionOf(name));
}

/** Wert für das accept-Attribut: MIME-Typen und Endungen aller Eingabeformate. */
export function audioAcceptAttribute(formats: readonly AudioFormat[] = AUDIO_FORMATS): string {
  const parts = new Set<string>();
  for (const format of formats) {
    const info = AUDIO_FORMAT_INFO[format];
    for (const extension of info.inputExtensions) parts.add(`.${extension}`);
    for (const mime of info.mimes) parts.add(mime);
  }
  return [...parts].join(',');
}
