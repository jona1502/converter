import { useEffect, useState } from 'react';
import { capabilities } from '../../lib/api/client';
import { formatBytes, formatRetention } from '../../lib/format';
import { formatDurationLimit } from '../../lib/audio/display';
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
/** Aufbewahrungsdauer laut Server; '' bis bekannt oder bei Fehler (Hinweis bleibt dann allgemein). */
function useRetention(): string {
  const [text, setText] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    capabilities(controller.signal).then((c) => setText(formatRetention(c.jobs.ttlSeconds)), () => {});
    return () => controller.abort();
  }, []);
  return text;
}

export function BrowserSupportNotice({ support }: { support: Pick<SupportState, 'status'> & { readonly reason?: 'apis' | 'encoder' } }) {
  const retention = useRetention();
  if (support.status !== 'unsupported') return (
    <div className="notice notice-info">
      <p className="notice-title">Upload und Speicherung</p>
      <p className="mt-1">Erst nach ausdrücklichem Start werden Ihre Dateien auf den Server hochgeladen. Dateien und Ergebnisse werden temporär gespeichert und {retention ? `nach ${retention}` : 'nach Ablauf'} automatisch gelöscht. Entfernen oder Zurücksetzen fordert die frühere Löschung an.</p>
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

/** Hinweis zu Tags, Cover, nicht unterstützten Formaten und Grenzen des Audiowerkzeugs. */
export function AudioProcessingNotice({ maxFileBytes, maxDurationSeconds }: { maxFileBytes: number; maxDurationSeconds: number }) {
  return (
    <div className="notice notice-info text-sm">
      <p className="notice-title">Tags, Cover und Grenzen</p>
      <p className="mt-1">
        Jede Datei wird neu kodiert. Tags und Metadaten wie Titel, Interpret und Album sowie eingebettete Cover gehen
        dabei verloren. Die Abtastrate bleibt erhalten. M4A und AAC werden nicht unterstützt. Je Datei sind höchstens{' '}
        {formatDurationLimit(maxDurationSeconds)} Spieldauer und {formatBytes(maxFileBytes)} erlaubt.{' '}
        <a href="/lokale-verarbeitung" className="link">
          Mehr zur Dateiverarbeitung
        </a>
      </p>
    </div>
  );
}
