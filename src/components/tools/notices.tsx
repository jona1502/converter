import type { SupportState } from './useImageBatch';

/** Allgemeiner Hinweis zu Metadaten und animierten Bildern. */
export function ImageProcessingNotice() {
  return (
    <div className="notice notice-info text-sm">
      <p className="notice-title">Metadaten und Animation</p>
      <p className="mt-1">
        Jedes Bild wird neu kodiert. Dabei werden Metadaten wie EXIF-Daten (einschließlich einer GPS-Position) und
        eingebettete Farbprofile entfernt oder verändert. Eine vollständige Entfernung von Metadaten ist nicht gewährleistet. Animierte Bilder werden nicht unterstützt und abgelehnt.{' '}
        <a href="/lokale-verarbeitung" className="link">
          Mehr zur Dateiverarbeitung
        </a>
      </p>
    </div>
  );
}

/** Hinweis, wenn der Browser die nötigen Funktionen nicht bietet. Gibt null zurück, wenn alles verfügbar ist. */
export function BrowserSupportNotice({ support }: { support: SupportState }) {
  if (support.status !== 'unsupported') return (
    <div className="notice notice-info">
      <p className="notice-title">Upload und Speicherung</p>
      <p className="mt-1">Erst nach ausdrücklichem Start werden Ihre Dateien auf den Server hochgeladen. Dateien und Ergebnisse werden temporär gespeichert und nach Ablauf gelöscht. Entfernen oder Zurücksetzen fordert die frühere Löschung an.</p>
    </div>
  );
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">Der Verarbeitungsserver ist nicht verfügbar.</p>
      <p className="mt-1">
        {support.reason === 'apis'
          ? 'Der Verarbeitungsserver ist derzeit nicht erreichbar.'
          : 'Der Server kann keines der Ausgabeformate erzeugen.'}{' '}
        Bitte prüfen Sie Ihre Verbindung und laden Sie die Seite erneut.
      </p>
    </div>
  );
}
