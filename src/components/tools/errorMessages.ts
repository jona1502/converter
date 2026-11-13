/**
 * Deutsche Nutzertexte zu den Fehlercodes des Bildkerns. Der switch ist exhaustiv:
 * Kommt im Kern ein neuer ImageErrorCode hinzu, meldet TypeScript hier einen Fehler.
 */
import { ImageProcessingError, LIMITS, type ImageErrorCode } from '../../lib/image';
import { formatBytes } from '../../lib/format';
import { ApiError, apiMessage } from '../../lib/api/client';
import { formatDurationLimit, formatSampleRate } from '../../lib/audio/display';
import { INPUT_FORMATS, formatList } from './formats';

const numberDe = new Intl.NumberFormat('de-DE');

export function imageErrorMessage(code: ImageErrorCode): string {
  switch (code) {
    case 'unsupported-type':
      return `Diese Datei ist kein unterstütztes Bild. Unterstützt werden ${formatList(INPUT_FORMATS)}; erkannt wird das Format am Dateiinhalt, nicht an der Endung.`;
    case 'file-too-large':
      return `Die Datei ist zu groß. Erlaubt sind höchstens ${formatBytes(LIMITS.maxFileBytes)} pro Datei.`;
    case 'dimensions-too-large':
      return `Das Bild ist zu groß. Erlaubt sind höchstens ${numberDe.format(LIMITS.maxEdge)} Pixel je Kante und ${numberDe.format(LIMITS.maxPixels / 1_000_000)} Megapixel.`;
    case 'animated-unsupported':
      return 'Animierte Bilder werden nicht unterstützt. Bitte verwenden Sie ein unbewegtes Bild.';
    case 'decode-failed':
      return 'Die Datei konnte nicht gelesen werden. Sie ist möglicherweise beschädigt oder wird von diesem Browser nicht unterstützt.';
    case 'decode-unsupported':
      return 'Das Bildformat wurde erkannt, kann aber von diesem Browser nicht gelesen werden. Bitte verwenden Sie einen anderen Browser oder ein anderes Eingabeformat.';
    case 'invalid-options':
      return 'Die Einstellungen sind ungültig. Bitte prüfen Sie die Optionen.';
    case 'encode-unsupported':
      return 'Ihr Browser kann das gewählte Zielformat nicht erzeugen. Bitte wählen Sie ein anderes Format.';
    case 'encode-failed':
      return 'Das Ergebnis konnte nicht erzeugt werden. Möglicherweise reicht der Arbeitsspeicher nicht aus – versuchen Sie es mit weniger oder kleineren Bildern.';
    case 'aborted':
      return 'Die Verarbeitung wurde abgebrochen.';
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

/** Fehlercode aus einem beliebigen Fehler; Unbekanntes gilt als fehlgeschlagene Kodierung. */
export function errorCodeOf(error: unknown): ImageErrorCode {
  return error instanceof ImageProcessingError ? error.code : 'encode-failed';
}

/** Grenzwerte aus capabilities.audio, die in Audiofehlermeldungen genannt werden. */
export interface AudioMessageLimits {
  readonly maxFileBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxChannels: number;
  readonly maxSampleRate: number;
  readonly maxOutputBytes: number;
}

/**
 * Deutsche Texte für Fehlercodes des Audiowerkzeugs (Server- und Vorprüfungscodes).
 * null: kein audiospezifischer Text, die allgemeine Meldung aus client.ts gilt.
 */
export function audioErrorMessage(code: string, limits: AudioMessageLimits): string | null {
  switch (code) {
    case 'duration-too-long':
      return `Die Audiodatei ist zu lang. Erlaubt sind höchstens ${formatDurationLimit(limits.maxDurationSeconds)} Spieldauer.`;
    case 'unsupported-audio':
      return `Die Audiodatei kann so nicht verarbeitet werden. Möglich sind höchstens ${limits.maxChannels} Kanäle und ${formatSampleRate(limits.maxSampleRate)} Abtastrate; OGG-Dateien müssen Vorbis oder Opus enthalten. MP3 kann nur Abtastraten von 8 bis 48 kHz und höchstens zwei Kanäle speichern – wählen Sie dann „Mono“ oder ein anderes Zielformat.`;
    case 'decode-failed':
      return 'Die Audiodatei konnte nicht gelesen werden. Sie ist möglicherweise beschädigt oder unvollständig.';
    case 'result-too-large':
      return `Das Ergebnis wäre größer als erlaubt (höchstens ${formatBytes(limits.maxOutputBytes)}). Wählen Sie MP3 oder OGG oder verwenden Sie eine kürzere Datei.`;
    case 'timeout':
      return 'Die Verarbeitung hat das Zeitlimit überschritten. Versuchen Sie es mit einer kürzeren Datei oder einem anderen Zielformat.';
    case 'unsupported-type':
      return 'Diese Datei ist keine unterstützte Audiodatei. Unterstützt werden MP3, WAV, FLAC und OGG; erkannt wird das Format am Dateiinhalt, nicht an der Endung.';
    case 'aac-unsupported':
      return 'M4A- und AAC-Dateien werden nicht unterstützt. Unterstützt werden MP3, WAV, FLAC und OGG.';
    case 'file-too-large':
      return `Die Audiodatei ist zu groß. Erlaubt sind höchstens ${formatBytes(limits.maxFileBytes)} pro Datei.`;
    default:
      return null;
  }
}

/** Meldung zu einem Fehler beim Hochladen oder Verarbeiten einer Audiodatei. */
export function audioServerMessage(error: unknown, limits: AudioMessageLimits): string {
  return (error instanceof ApiError ? audioErrorMessage(error.code, limits) : null) ?? apiMessage(error);
}
