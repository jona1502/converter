import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import {
  DEFAULT_PDF_IMAGE_SETTINGS,
  PDF_IMAGE_ACCEPT,
  PDF_IMAGE_DPI,
  PDF_IMAGE_FORMATS,
  resolvePages,
  resultKind,
  selectionMessage,
  type PdfImageSettings,
} from '../../lib/pdf-image';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { EntryList, MetadataGroup } from './FileList';
import { BrowserSupportNotice } from './notices';
import { ToolWorkspace } from './ToolWorkspace';
import { useInitialFiles, type ToolProps } from './useInitialFiles';
import { usePdfImageBatch, type PdfImageEntry } from './usePdfImageBatch';

function Choice<T extends string | number>({ legend, options, value, onChange, disabled }: {
  legend: string; options: ReadonlyArray<{ value: T; label: string }>; value: T; onChange: (value: T) => void; disabled: boolean;
}) {
  const name = useId();
  return <fieldset className="fieldset">
    <legend className="legend">{legend}</legend>
    <div className="choice-group">
      {options.map(option => <label key={option.value}>
        <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />
        {option.label}
      </label>)}
    </div>
  </fieldset>;
}

const pagesLabel = (count: number) => `${count} ${count === 1 ? 'Seite' : 'Seiten'}`;

function renderResult(entry: PdfImageEntry) {
  const { result } = entry;
  if (!result || !entry.resultUrl) return null;
  const format = PDF_IMAGE_FORMATS.find(option => option.value === result.settings.format)?.label ?? result.settings.format;
  return <div className="file-result">
    <MetadataGroup label="Ergebnis">
      <div><dt>Format</dt><dd>{result.archive ? `ZIP mit ${result.pageCount} ${format}-${result.pageCount === 1 ? 'Bild' : 'Bildern'}` : `${format}-Bild`}</dd></div>
      <div><dt>Seiten</dt><dd>{result.pageCount} von {result.sourcePageCount}</dd></div>
      <div><dt>Auflösung</dt><dd>{result.settings.dpi} dpi</dd></div>
      <div><dt>Größe</dt><dd>{formatBytes(result.size)}</dd></div>
      <div><dt>Dateiname</dt><dd className="break-all">{entry.outputName}</dd></div>
    </MetadataGroup>
    <a className="btn btn-secondary max-w-full whitespace-normal break-all" href={entry.resultUrl} download={entry.outputName}>
      Herunterladen<span className="sr-only">: {entry.outputName}</span>
    </a>
    {entry.expiresAt && <p className="hint">Verfügbar bis <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString('de-DE')}</time>.</p>}
  </div>;
}

export default function PdfImageConverter({ initialFiles }: ToolProps) {
  const batch = usePdfImageBatch();
  const { entry, support, limits, counts, isProcessing } = batch;
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<PdfImageSettings>(DEFAULT_PDF_IMAGE_SETTINGS);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const pagesId = useId();
  const pagesHint = useId();
  useEffect(() => setHydrated(true), []);
  const handleFiles = useCallback((files: File[]) => {
    const added = batch.addFiles(files);
    setMessage(!added || files.length > 1 ? 'Es kann jeweils eine PDF verarbeitet werden. Entfernen Sie die ausgewählte Datei, bevor Sie eine andere hinzufügen.' : null);
    if (added) setAnnouncement('PDF hinzugefügt. Die Prüfung läuft lokal; es wurde nichts hochgeladen.');
  }, [batch.addFiles]);
  useInitialFiles(support.status === 'ready', initialFiles, handleFiles);
  const reset = () => { batch.reset(); setMessage(null); setAnnouncement('Datei entfernt.'); button.current?.focus(); };
  const focus = () => button.current?.focus();
  const pageCount = entry?.pageCount;
  const selection = resolvePages(settings, pageCount, limits.maxPages);
  const typed = settings.mode === 'selection' && settings.selection.trim() !== '';
  const selectionError = !selection.ok && (typed || settings.mode === 'all') && entry && entry.status !== 'checking' && entry.status !== 'invalid'
    ? (settings.mode === 'all'
      ? `Die PDF hat ${pageCount} Seiten; höchstens ${limits.maxPages} je Auftrag sind möglich. Wählen Sie „Bestimmte Seiten“.`
      : selectionMessage(selection.reason, pageCount, limits.maxPages))
    : null;
  const kind = resultKind(settings, pageCount);
  let disabledReason: string | null = null;
  if (!hydrated || support.status === 'checking') disabledReason = 'Die Verfügbarkeit wird geprüft …';
  else if (support.status === 'unsupported') disabledReason = 'PDF zu Bild ist derzeit nicht verfügbar.';
  else if (isProcessing) disabledReason = 'Die Bilder werden erstellt.';
  else if (counts.checking) disabledReason = 'Die Datei wird geprüft.';
  else if (!counts.processable) disabledReason = 'Wählen Sie zuerst eine verwendbare PDF aus.';
  else if (settings.mode === 'selection' && !typed) disabledReason = 'Geben Sie die gewünschten Seiten ein oder wählen Sie „Alle Seiten“.';
  else if (!selection.ok) disabledReason = 'Bitte prüfen Sie die Seitenauswahl.';
  const change = (changes: Partial<PdfImageSettings>) => setSettings(current => ({ ...current, ...changes }));
  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={support} />
    <ToolWorkspace selectionTitle="PDF auswählen" selection={<>
      <DropZone accept={PDF_IMAGE_ACCEPT} multiple={false} disabled={!hydrated || support.status !== 'ready'} onFiles={handleFiles} buttonRef={button} title="PDF hierher ziehen">
        <p>Eine PDF-Datei, höchstens {formatBytes(limits.maxFileBytes)}. Verschlüsselte PDFs werden nicht unterstützt. Die Datei wird erst nach Ihrem ausdrücklichen Start hochgeladen.</p>
      </DropZone>
      {message && <p className="notice notice-error" role="alert">{message}</p>}
    </>} settings={<>
      <Choice legend="Bildformat" options={PDF_IMAGE_FORMATS} value={settings.format} disabled={isProcessing} onChange={format => change({ format })} />
      <Choice legend="Auflösung" options={PDF_IMAGE_DPI} value={settings.dpi} disabled={isProcessing} onChange={dpi => change({ dpi })} />
      <Choice legend="Seiten" options={[{ value: 'all', label: 'Alle Seiten' }, { value: 'selection', label: 'Bestimmte Seiten' }] as const} value={settings.mode} disabled={isProcessing} onChange={mode => change({ mode })} />
      {settings.mode === 'selection' && <div className="field">
        <label className="label" htmlFor={pagesId}>Seitenzahlen und Bereiche</label>
        <input id={pagesId} className="input" type="text" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="z. B. 1-3, 5" value={settings.selection} disabled={isProcessing}
          aria-describedby={pagesHint} aria-invalid={typed && !selection.ok} onChange={event => change({ selection: event.currentTarget.value })} />
        <p id={pagesHint} className="hint">Seiten zählen ab 1{pageCount ? `; die PDF hat ${pagesLabel(pageCount)}` : ''}. Genau eine Seite ergibt ein Bild, mehrere Seiten ergeben ein ZIP-Archiv.</p>
      </div>}
      {selectionError && <p className="field-error" role="alert">{selectionError}</p>}
      <p className="hint">{kind === 'image' ? 'Ergebnis: ein Bild.' : 'Ergebnis: ein ZIP-Archiv mit einem Bild je Seite.'} Höchstens {limits.maxPages} Seiten und {formatBytes(limits.maxOutputBytes)} je Auftrag; jede Seite höchstens {limits.maxPixels / 1_000_000} Megapixel. Höhere Auflösungen brauchen länger und ergeben größere Dateien.</p>
      <p className="hint">Die Seiten werden auf weißem Grund gerendert; Transparenz bleibt nicht erhalten. Formularfelder und Skripte in der PDF werden nicht ausgeführt.</p>
    </>} actionTitle="Bilder erstellen" action={<ActionBar processLabel="Bilder erstellen" onProcess={() => { setAnnouncement('Bilderstellung gestartet.'); void batch.process(settings).then(() => setAnnouncement('Verarbeitung beendet. Ergebnis oder Fehler steht in der Dateiliste.')); }} onReset={reset} counts={counts} isProcessing={isProcessing} progress={batch.progress} disabledReason={disabledReason} />}
      resultsHeadingId={heading} resultsHint="Nach dem ausdrücklichen Start erscheint hier Ihr Bild oder ZIP-Archiv zum Herunterladen."
      results={<EntryList entries={batch.entries} onRemove={() => { batch.remove(); setMessage(null); setAnnouncement('Datei entfernt.'); }} onEmptied={focus} labelledBy={heading}
        originalPrefix={item => `PDF · ${item.pageCount ? `${pagesLabel(item.pageCount)} · ` : ''}`} renderResult={renderResult} />} />
    <div aria-live="polite" className="sr-only" data-testid="live-region">{announcement}</div>
  </div>;
}
