/**
 * Serveroptionen für audio-convert. Wirkungslose Angaben werden nicht gesendet: Die Qualität nur bei
 * Formaten, für die der Server sie anwendet (capabilities.audio.qualityFormats, Standard MP3/OGG).
 * So bleibt auch der Idempotenzschlüssel gleich, wenn sich nur eine wirkungslose Einstellung ändert.
 */
import type { ApiSchemas } from '../api/generated';
import type { AudioFormat } from './formats';

export type AudioChannels = 'original' | 'mono';
export type AudioServerOptions = ApiSchemas['AudioOptions'];

export interface AudioSettings {
  readonly format: AudioFormat;
  /** Qualität in Prozent (0–100). */
  readonly quality: number;
  readonly channels: AudioChannels;
}

/** Formate mit Qualitätseinstellung, solange der Server nichts anderes meldet. */
export const DEFAULT_QUALITY_FORMATS: readonly AudioFormat[] = ['mp3', 'ogg'];
/** Standardqualität (0–1), solange der Server nichts anderes meldet. */
export const DEFAULT_AUDIO_QUALITY = 0.8;

export function qualityApplies(format: AudioFormat, qualityFormats: readonly AudioFormat[] = DEFAULT_QUALITY_FORMATS): boolean {
  return qualityFormats.includes(format);
}

/** Baut die Optionen für POST /jobs; quality nur, wo sie wirkt, auf 0–1 begrenzt. */
export function buildAudioOptions(
  settings: AudioSettings,
  qualityFormats: readonly AudioFormat[] = DEFAULT_QUALITY_FORMATS,
): AudioServerOptions {
  const options: AudioServerOptions = { tool: 'audio-convert', format: settings.format, channels: settings.channels };
  if (qualityApplies(settings.format, qualityFormats)) {
    const percent = Number.isFinite(settings.quality) ? Math.min(100, Math.max(0, Math.round(settings.quality))) : DEFAULT_AUDIO_QUALITY * 100;
    options.quality = percent / 100;
  }
  return options;
}
