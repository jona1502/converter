/**
 * Deutsche Nutzertexte zu den Fehlercodes des Bildkerns. Der switch ist exhaustiv:
 * Kommt im Kern ein neuer ImageErrorCode hinzu, meldet TypeScript hier einen Fehler.
 */
import { ImageProcessingError, LIMITS, type ImageErrorCode } from '../../lib/image';
import { formatBytes } from '../../lib/format';
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
