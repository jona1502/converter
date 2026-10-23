import type { SupportState } from './useImageBatch';

/** Allgemeiner Hinweis zu Metadaten und animierten Bildern. */
export function ImageProcessingNotice() {
  return (
    <div className="notice notice-info text-sm">
      <p className="notice-title">Hinweis zu Metadaten</p>
      <p className="mt-1">
        Jedes Bild wird neu kodiert. Dabei werden Metadaten wie EXIF-Daten (einschließlich einer GPS-Position) und
        eingebettete Farbprofile entfernt oder verändert. Animierte Bilder werden nicht unterstützt und abgelehnt.{' '}
        <a href="/lokale-verarbeitung" className="link">
          Mehr zur lokalen Verarbeitung
        </a>
      </p>
    </div>
  );
}

/** Hinweis, wenn der Browser die nötigen Funktionen nicht bietet. Gibt null zurück, wenn alles verfügbar ist. */
export function BrowserSupportNotice({ support }: { support: SupportState }) {
  if (support.status !== 'unsupported') return null;
  return (
    <div className="notice notice-error" role="alert">
      <p className="notice-title">Dieses Werkzeug funktioniert in Ihrem Browser nicht.</p>
      <p className="mt-1">
        {support.reason === 'apis'
          ? 'Ihrem Browser fehlen Funktionen zur Bildverarbeitung (createImageBitmap bzw. Canvas).'
          : 'Ihr Browser kann keines der Ausgabeformate erzeugen.'}{' '}
        Bitte verwenden Sie eine aktuelle Version von Firefox, Chrome, Edge oder Safari.
      </p>
    </div>
  );
}
