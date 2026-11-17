import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { MARKDOWN_ACCEPT } from '../../lib/markdown';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { EntryList, MetadataGroup } from './FileList';
import { BrowserSupportNotice } from './notices';
import { ToolWorkspace } from './ToolWorkspace';
import { useInitialFiles, type ToolProps } from './useInitialFiles';
import { useMarkdownBatch, type MarkdownEntry } from './useMarkdownBatch';

function renderResult(entry: MarkdownEntry) {
  if (!entry.result || !entry.resultUrl) return null;
  return <div className="file-result">
    <MetadataGroup label="Ergebnis">
      <div><dt>Format</dt><dd>PDF · A4-Hochformat</dd></div>
      <div><dt>Seiten</dt><dd>{entry.result.pageCount}</dd></div>
      <div><dt>Größe</dt><dd>{formatBytes(entry.result.size)}</dd></div>
      <div><dt>Dateiname</dt><dd className="break-all">{entry.outputName}</dd></div>
    </MetadataGroup>
    <a className="btn btn-secondary max-w-full whitespace-normal break-all" href={entry.resultUrl} download={entry.outputName}>
      Herunterladen<span className="sr-only">: {entry.outputName}</span>
    </a>
    {entry.expiresAt && <p className="hint">Verfügbar bis <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString('de-DE')}</time>.</p>}
  </div>;
}

export default function MarkdownConverter({ initialFiles }: ToolProps) {
  const batch = useMarkdownBatch();
  const { support, limits, counts, isProcessing } = batch;
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const heading = useId();
  useEffect(() => setHydrated(true), []);
  const handleFiles = useCallback((files: File[]) => {
    const added = batch.addFiles(files);
    setMessage(!added || files.length > 1 ? 'Es kann jeweils eine Markdown-Datei verarbeitet werden. Entfernen Sie die ausgewählte Datei, bevor Sie eine andere hinzufügen.' : null);
    if (added) setAnnouncement('Markdown-Datei hinzugefügt. Die Prüfung läuft lokal; es wurde nichts hochgeladen.');
  }, [batch.addFiles]);
  useInitialFiles(support.status === 'ready', initialFiles, handleFiles);
  const reset = () => { batch.reset(); setMessage(null); setAnnouncement('Datei entfernt.'); button.current?.focus(); };
  const focus = () => button.current?.focus();
  let disabledReason: string | null = null;
  if (!hydrated || support.status === 'checking') disabledReason = 'Die Verfügbarkeit wird geprüft …';
  else if (support.status === 'unsupported') disabledReason = 'Markdown zu PDF ist derzeit nicht verfügbar.';
  else if (isProcessing) disabledReason = 'Die PDF wird erstellt.';
  else if (counts.checking) disabledReason = 'Die Datei wird geprüft.';
  else if (!counts.processable) disabledReason = 'Wählen Sie zuerst eine verwendbare Markdown-Datei aus.';
  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={support} />
    <ToolWorkspace selectionTitle="Markdown-Datei auswählen" selection={<>
      <DropZone accept={MARKDOWN_ACCEPT} multiple={false} disabled={!hydrated || support.status !== 'ready'} onFiles={handleFiles} buttonRef={button} title="Markdown-Datei hierher ziehen">
        <p>Eine .md- oder .markdown-Datei in UTF-8, optional mit BOM. Höchstens {formatBytes(limits.maxFileBytes)}; keine leeren Dateien oder Binärdaten.</p>
      </DropZone>
      {message && <p className="notice notice-error" role="alert">{message}</p>}
    </>} settings={<>
      <p className="hint">PDF mit auswählbarem Text im A4-Hochformat. Höchstens {limits.maxPages} Seiten und {formatBytes(limits.maxOutputBytes)} Ausgabe; Zeitlimit 120 Sekunden.</p>
      <p className="hint">Die eingebettete Schrift unterstützt das lateinische Alphabet und deutsche Umlaute. CJK-Zeichen und Emoji werden nicht vollständig unterstützt.</p>
    </>} actionTitle="PDF erstellen" action={<ActionBar processLabel="PDF erstellen" onProcess={() => { setAnnouncement('PDF-Erstellung gestartet.'); void batch.process().then(() => setAnnouncement('Verarbeitung beendet. Ergebnis oder Fehler steht in der Dateiliste.')); }} onReset={reset} counts={counts} isProcessing={isProcessing} progress={batch.progress} disabledReason={disabledReason} />}
      resultsHeadingId={heading} resultsHint="Nach dem ausdrücklichen Start erscheint hier Ihre PDF zum Herunterladen."
      results={<EntryList entries={batch.entries} onRemove={() => { batch.remove(); setMessage(null); setAnnouncement('Datei entfernt.'); }} onEmptied={focus} labelledBy={heading} originalPrefix={() => 'Markdown · '} renderResult={renderResult} />} />
    <div className="notice notice-info text-sm">
      <p className="notice-title">Unterstützte Markdown-Inhalte</p>
      <p className="mt-1">Überschriften, Absätze, Listen, Zitate, Links, Tabellen und Codeblöcke. Lange Zeilen und Tabellenzellen werden umgebrochen; Tabellenköpfe werden auf Folgeseiten wiederholt. Bilder erscheinen nur als Alternativtext und werden nicht geladen. HTML wird nicht ausgeführt; aktive Links sind auf https, http und mailto begrenzt. Eigenes CSS, JavaScript, Mermaid und LaTeX werden nicht unterstützt.</p>
    </div>
    <div aria-live="polite" className="sr-only" data-testid="live-region">{announcement}</div>
  </div>;
}
