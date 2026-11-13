/**
 * Vorprüfung vor dem Upload: Größe, Signatur und Endung. Es wird nichts dekodiert; Dauer, Kanäle
 * und Abtastrate prüft der Server.
 */
import { hasAacExtension, type AudioFormat } from './formats';
import { AUDIO_SNIFF_BYTES, sniffAudio } from './sniff';

/** Fehlercodes der Vorprüfung (Texte: audioErrorMessage). */
export type AudioCheckError = 'file-too-large' | 'unsupported-type' | 'aac-unsupported';

export type AudioCheckResult =
  | { readonly ok: true; readonly format: AudioFormat }
  | { readonly ok: false; readonly code: AudioCheckError };

/** Reine Prüfung auf bereits gelesenen Kopfbytes. */
export function checkAudioHeader(name: string, size: number, head: Uint8Array, maxFileBytes: number): AudioCheckResult {
  if (size > maxFileBytes) return { ok: false, code: 'file-too-large' };
  const format = sniffAudio(head);
  if (format) return { ok: true, format };
  return { ok: false, code: hasAacExtension(name) ? 'aac-unsupported' : 'unsupported-type' };
}

/** Liest höchstens AUDIO_SNIFF_BYTES und prüft die Datei. */
export async function checkAudioFile(file: File, maxFileBytes: number): Promise<AudioCheckResult> {
  if (file.size > maxFileBytes) return { ok: false, code: 'file-too-large' };
  const head = new Uint8Array(await file.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
  return checkAudioHeader(file.name, file.size, head, maxFileBytes);
}
