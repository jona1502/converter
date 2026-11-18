import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { PDF_MERGE_ACCEPT } from '../../lib/pdfmerge';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { MetadataGroup } from './FileList';
import { BrowserSupportNotice } from './notices';
import { ToolWorkspace } from './ToolWorkspace';
import { useInitialFiles, type ToolProps } from './useInitialFiles';
import { usePdfMergeBatch, type MergeSource } from './usePdfMergeBatch';

const SOURCE_STATUS = {
  checking: { label: 'Wird geprüft', badge: 'badge-neutral' },
  ready: { label: 'Bereit', badge: 'badge-accent' },
  invalid: { label: 'Nicht verwendbar', badge: 'badge-danger' },
} as const;

function SourceRow({ source, index, count, disabled, onMove, onRemove, buttonRef }: {
  source: MergeSource; index: number; count: number; disabled: boolean;
  onMove: (id: string, delta: number) => void; onRemove: (id: string) => void;
  buttonRef: (key: string, element: HTMLButtonElement | null) => void;
}) {
  const status = SOURCE_STATUS[source.status];
  return <li className="file-row" data-status={source.status}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
        <h3 className="file-name whitespace-normal break-all" title={source.name}>
          <span className="tabular-nums">{index + 1}. </span>{source.name}
        </h3>
        <p className="hint tabular-nums"><span className="font-medium">Größe: </span>{formatBytes(source.size)}</p>
      </div>
      <span className={`badge max-w-full whitespace-normal ${status.badge}`}><span className="sr-only">Status: </span>{status.label}</span>
    </div>
    {source.error && <p className="field-error">{source.error}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className="btn btn-ghost" ref={element => buttonRef(`${source.id}:up`, element)} disabled={disabled || index === 0}
        aria-label={`${source.name} nach oben verschieben, derzeit Position ${index + 1} von ${count}`} onClick={() => onMove(source.id, -1)}>Nach oben</button>
      <button type="button" className="btn btn-ghost" ref={element => buttonRef(`${source.id}:down`, element)} disabled={disabled || index === count - 1}
        aria-label={`${source.name} nach unten verschieben, derzeit Position ${index + 1} von ${count}`} onClick={() => onMove(source.id, 1)}>Nach unten</button>
      <button type="button" className="btn btn-ghost" ref={element => buttonRef(`${source.id}:remove`, element)} disabled={disabled}
        aria-label={`Datei ${source.name} entfernen`} onClick={() => onRemove(source.id)}>Entfernen</button>
    </div>
  </li>;
}

export default function PdfMerger({ initialFiles }: ToolProps) {
  const batch = usePdfMergeBatch();
  const { sources, support, limits, phase, result, error, progress, issue, isProcessing } = batch;
  const [hydrated, setHydrated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pending = useRef<string | null>(null);
  const pickButton = useRef<HTMLButtonElement>(null);
  const heading = useId();
  useEffect(() => setHydrated(true), []);

  // Nach dem Verschieben bleibt der Fokus auf der bewegten Zeile, damit wiederholtes Verschieben per Tastatur möglich ist.
  useEffect(() => {
    if (!pending.current) return;
    buttons.current.get(pending.current)?.focus();
    pending.current = null;
  }, [sources]);

  const handleFiles = useCallback((files: File[]) => {
    const rejected = batch.addFiles(files);
    setMessage(rejected > 0 ? `Es sind höchstens ${limits.maxFiles} PDF-Dateien möglich; ${rejected} ${rejected === 1 ? 'Datei wurde' : 'Dateien wurden'} nicht hinzugefügt.` : null);
    if (files.length > rejected) setAnnouncement('PDF-Dateien hinzugefügt. Die Prüfung läuft lokal; es wurde nichts hochgeladen.');
  }, [batch.addFiles, limits.maxFiles]);
  useInitialFiles(support.status === 'ready', initialFiles, handleFiles);

  const move = (id: string, delta: number) => {
    const index = sources.findIndex(item => item.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= sources.length) return;
    const direction = delta < 0 ? 'up' : 'down';
    // Am Rand wechselt der Fokus auf die jeweils andere Richtung, weil die gedrückte dann deaktiviert ist.
    pending.current = `${id}:${target === 0 && direction === 'up' ? 'down' : target === sources.length - 1 && direction === 'down' ? 'up' : direction}`;
    setAnnouncement(`${sources[index]!.name} steht jetzt an Position ${target + 1} von ${sources.length}.`);
    batch.move(id, delta);
  };
  const remove = (id: string) => {
    const index = sources.findIndex(item => item.id === id);
    const next = sources[index + 1] ?? sources[index - 1];
    batch.remove(id);
    setMessage(null);
    setAnnouncement('Datei entfernt.');
    requestAnimationFrame(() => {
      if (next) buttons.current.get(`${next.id}:remove`)?.focus();
      else pickButton.current?.focus();
    });
  };
  const reset = () => { batch.reset(); setMessage(null); setAnnouncement('Alle Dateien entfernt.'); pickButton.current?.focus(); };

  let disabledReason: string | null = null;
  if (!hydrated || support.status === 'checking') disabledReason = 'Die Verfügbarkeit wird geprüft …';
  else if (support.status === 'unsupported') disabledReason = 'PDF zusammenführen ist derzeit nicht verfügbar.';
  else if (isProcessing) disabledReason = 'Die PDFs werden zusammengeführt.';
  else if (batch.checking) disabledReason = 'Die Dateien werden geprüft.';
  else if (batch.invalid > 0) disabledReason = 'Entfernen Sie die nicht verwendbaren Dateien.';
  else if (issue) disabledReason = issue;
  const counts = { total: sources.length, checking: sources.filter(item => item.status === 'checking').length, invalid: batch.invalid,
    processable: sources.filter(item => item.status === 'ready').length, done: result ? 1 : 0, failed: error ? 1 : 0 };
  const statusText = phase === 'uploading' ? 'Die PDFs werden hochgeladen.' : phase === 'queued' ? `Wartet auf Verarbeitung${progress?.position ? ` (Platz ${progress.position})` : ''}.`
    : phase === 'processing' ? 'Die PDFs werden zusammengeführt.' : null;

  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={support} />
    <ToolWorkspace selectionTitle="PDF-Dateien auswählen" selection={<>
      <DropZone accept={PDF_MERGE_ACCEPT} disabled={!hydrated || support.status !== 'ready' || isProcessing} onFiles={handleFiles} buttonRef={pickButton}
        title="PDF-Dateien hierher ziehen" buttonLabel="PDF-Dateien auswählen">
        <p>{limits.minFiles} bis {limits.maxFiles} PDF-Dateien, zusammen höchstens {formatBytes(limits.maxTotalBytes)}. Sie können Dateien nacheinander hinzufügen. Verschlüsselte PDFs werden nicht unterstützt.</p>
      </DropZone>
      {message && <p className="notice notice-error" role="alert">{message}</p>}
    </>} settings={<>
      <p className="hint">Die Seiten werden unverändert in der Reihenfolge der Liste aneinandergehängt. Verschieben Sie Dateien mit „Nach oben“ und „Nach unten“.</p>
      <p className="hint">Höchstens {limits.maxPages} Seiten und {formatBytes(limits.maxOutputBytes)} Ergebnis. Lesezeichen, Formularfelder und Dokumenteigenschaften der Quelldateien werden nicht übernommen; Signaturen werden ungültig.</p>
    </>} actionTitle="PDFs zusammenführen" action={<ActionBar processLabel="PDFs zusammenführen" onProcess={() => { setAnnouncement('Zusammenführen gestartet.'); void batch.process().then(() => setAnnouncement('Verarbeitung beendet. Ergebnis oder Fehler steht in der Ergebnisliste.')); }}
      onReset={reset} counts={counts} isProcessing={isProcessing} progress={null} disabledReason={disabledReason} />}
      resultsHeadingId={heading} resultsHint="Prüfen Sie die Reihenfolge. Hochgeladen wird erst nach dem ausdrücklichen Start."
      results={<>
        {sources.length === 0 ? <p className="hint">Noch keine Dateien ausgewählt.</p>
          : <ol className="file-list" aria-labelledby={heading}>
            {sources.map((source, index) => <SourceRow key={source.id} source={source} index={index} count={sources.length} disabled={isProcessing}
              onMove={move} onRemove={remove} buttonRef={(key, element) => { if (element) buttons.current.set(key, element); else buttons.current.delete(key); }} />)}
          </ol>}
        {statusText && <p role="status" className="hint">{statusText}</p>}
        {phase === 'processing' && <progress className="progress" aria-label="PDFs werden zusammengeführt"
          {...(progress?.fraction === undefined ? {} : { value: Math.round(progress.fraction * 100), max: 100 })} />}
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        {result && <div className="file-result" data-testid="merge-result">
          <MetadataGroup label="Ergebnis">
            <div><dt>Quelldateien</dt><dd>{result.sourceCount}</dd></div>
            <div><dt>Seiten</dt><dd>{result.pageCount}</dd></div>
            <div><dt>Größe</dt><dd>{formatBytes(result.size)}</dd></div>
            <div><dt>Dateiname</dt><dd className="break-all">{result.name}</dd></div>
          </MetadataGroup>
          <a className="btn btn-secondary max-w-full whitespace-normal break-all" href={result.url} download={result.name}>
            Herunterladen<span className="sr-only">: {result.name}</span>
          </a>
          <p className="hint">Verfügbar bis <time dateTime={result.expiresAt}>{new Date(result.expiresAt).toLocaleString('de-DE')}</time>.</p>
        </div>}
      </>} />
    <div aria-live="polite" className="sr-only" data-testid="live-region">{announcement}</div>
  </div>;
}
