import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import {
  DEFAULT_PDF_ROTATE_SETTINGS,
  describePdfRotateSettings,
  parsePdfPages,
  PDF_ROTATE_ACCEPT,
  PDF_ROTATE_ANGLES,
  type PdfRotateAngle,
  type PdfRotateScope,
  type PdfRotateSettings,
} from '../../lib/pdf-rotate';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { EntryList, MetadataGroup } from './FileList';
import { BrowserSupportNotice } from './notices';
import { ToolWorkspace } from './ToolWorkspace';
import { useInitialFiles, type ToolProps } from './useInitialFiles';
import { usePdfRotateBatch, type PdfRotateEntry } from './usePdfRotateBatch';

const SCOPES: ReadonlyArray<{ value: PdfRotateScope; label: string }> = [
  { value: 'all', label: 'Alle Seiten' },
  { value: 'range', label: 'Bestimmte Seiten' },
];

function renderResult(entry: PdfRotateEntry) {
  if (!entry.result || !entry.resultUrl) return null;
  return <div className="file-result">
    <MetadataGroup label="Ergebnis">
      <div><dt>Drehung</dt><dd>{describePdfRotateSettings(entry.result.settings)}</dd></div>
      <div><dt>Gedrehte Seiten</dt><dd>{entry.result.rotatedPages} von {entry.result.pageCount}</dd></div>
      <div><dt>Größe</dt><dd>{formatBytes(entry.result.size)}</dd></div>
      <div><dt>Dateiname</dt><dd className="break-all">{entry.outputName}</dd></div>
    </MetadataGroup>
    <a className="btn btn-secondary max-w-full whitespace-normal break-all" href={entry.resultUrl} download={entry.outputName}>
      Herunterladen<span className="sr-only">: {entry.outputName}</span>
    </a>
    {entry.expiresAt && <p className="hint">Verfügbar bis <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString('de-DE')}</time>.</p>}
  </div>;
}

export default function PdfRotator({ initialFiles }: ToolProps) {
  const batch = usePdfRotateBatch();
  const { support, limits, counts, isProcessing } = batch;
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<PdfRotateSettings>(DEFAULT_PDF_ROTATE_SETTINGS);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const angleName = useId();
  const scopeName = useId();
  const pagesId = useId();
  const pagesErrorId = useId();
  useEffect(() => setHydrated(true), []);
  const handleFiles = useCallback((files: File[]) => {
    const added = batch.addFiles(files);
    setMessage(!added || files.length > 1 ? 'Es kann jeweils eine PDF verarbeitet werden. Entfernen Sie die ausgewählte Datei, bevor Sie eine andere hinzufügen.' : null);
    if (added) setAnnouncement('PDF hinzugefügt. Die Prüfung läuft lokal; es wurde nichts hochgeladen.');
  }, [batch.addFiles]);
  useInitialFiles(support.status === 'ready', initialFiles, handleFiles);
  const reset = () => { batch.reset(); setMessage(null); setAnnouncement('Datei entfernt.'); button.current?.focus(); };
  const focus = () => button.current?.focus();
  const pages = settings.scope === 'range' ? parsePdfPages(settings.pages) : null;
  const pagesError = pages && !pages.ok && settings.pages.trim() !== '' ? pages.message : null;
  let disabledReason: string | null = null;
  if (!hydrated || support.status === 'checking') disabledReason = 'Die Verfügbarkeit wird geprüft …';
  else if (support.status === 'unsupported') disabledReason = 'PDF drehen ist derzeit nicht verfügbar.';
  else if (isProcessing) disabledReason = 'Die PDF wird gedreht.';
  else if (counts.checking) disabledReason = 'Die Datei wird geprüft.';
  else if (!counts.processable) disabledReason = 'Wählen Sie zuerst eine verwendbare PDF aus.';
  else if (pages && !pages.ok) disabledReason = 'Geben Sie gültige Seiten an, z. B. 1-3,5.';
  const start = () => {
    setAnnouncement('Drehen gestartet.');
    void batch.process(settings).then(() => setAnnouncement('Verarbeitung beendet. Ergebnis oder Fehler steht in der Dateiliste.'));
  };
  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={support} />
    <ToolWorkspace selectionTitle="PDF auswählen" selection={<>
      <DropZone accept={PDF_ROTATE_ACCEPT} multiple={false} disabled={!hydrated || support.status !== 'ready'} onFiles={handleFiles} buttonRef={button} title="PDF hierher ziehen">
        <p>Eine PDF-Datei, höchstens {formatBytes(limits.maxFileBytes)}. Verschlüsselte PDFs werden nicht unterstützt.</p>
      </DropZone>
      {message && <p className="notice notice-error" role="alert">{message}</p>}
    </>} settings={<>
      <fieldset className="fieldset">
        <legend className="legend">Drehung (im Uhrzeigersinn)</legend>
        <div className="choice-group">
          {PDF_ROTATE_ANGLES.map(option => <label key={option.value}>
            <input type="radio" name={angleName} value={option.value} checked={settings.angle === option.value} disabled={isProcessing}
              onChange={() => setSettings(current => ({ ...current, angle: option.value as PdfRotateAngle }))} />
            {option.label}
          </label>)}
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend className="legend">Seiten</legend>
        <div className="choice-group">
          {SCOPES.map(option => <label key={option.value}>
            <input type="radio" name={scopeName} value={option.value} checked={settings.scope === option.value} disabled={isProcessing}
              onChange={() => setSettings(current => ({ ...current, scope: option.value }))} />
            {option.label}
          </label>)}
        </div>
        {settings.scope === 'range' && <div className="field">
          <label htmlFor={pagesId} className="label">Seitenangabe</label>
          <input id={pagesId} className="input" type="text" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="z. B. 1-3,5"
            value={settings.pages} disabled={isProcessing} aria-invalid={pagesError ? true : undefined} aria-describedby={pagesError ? pagesErrorId : undefined}
            onChange={event => { const pages = event.currentTarget.value; setSettings(current => ({ ...current, pages })); }} />
          {pagesError && <p id={pagesErrorId} className="field-error" role="alert">{pagesError}</p>}
          <p className="hint">Einzelne Seiten und Bereiche, durch Kommas getrennt; die erste Seite ist 1. Seiten außerhalb des Dokuments meldet der Server.</p>
        </div>}
      </fieldset>
      <p className="hint">Die Seiten erhalten nur einen Drehwinkel, Inhalt und Qualität bleiben unverändert. Eine bereits gedrehte Seite wird zusätzlich gedreht. Ergebnis höchstens {formatBytes(limits.maxOutputBytes)}.</p>
    </>} actionTitle="PDF drehen" action={<ActionBar processLabel="PDF drehen" onProcess={start} onReset={reset} counts={counts} isProcessing={isProcessing} progress={batch.progress} disabledReason={disabledReason} />}
      resultsHeadingId={heading} resultsHint="Nach dem ausdrücklichen Start erscheint hier Ihre gedrehte PDF zum Herunterladen."
      results={<EntryList entries={batch.entries} onRemove={() => { batch.remove(); setMessage(null); setAnnouncement('Datei entfernt.'); }} onEmptied={focus} labelledBy={heading} originalPrefix={() => 'PDF · '} renderResult={renderResult} />} />
    <div className="notice notice-info text-sm">
      <p className="notice-title">Was passiert mit der PDF?</p>
      <p className="mt-1">Der Server setzt für die gewählten Seiten den Drehwinkel und gibt die PDF mit unverändertem Inhalt zurück; es wird nichts neu gerendert oder neu komprimiert. Verschlüsselte oder beschädigte PDFs werden abgelehnt. Das Ergebnis heißt wie die Originaldatei mit dem Zusatz „-gedreht“.</p>
    </div>
    <div aria-live="polite" className="sr-only" data-testid="live-region">{announcement}</div>
  </div>;
}
