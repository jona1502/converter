import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import {
  DEFAULT_IMAGE_PDF_SETTINGS,
  IMAGE_PDF_ACCEPT,
  IMAGE_PDF_MARGINS,
  IMAGE_PDF_ORIENTATIONS,
  IMAGE_PDF_PAGE_SIZES,
  imagePdfPageLabel,
  type ImagePdfSettings,
} from '../../lib/imagepdf';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { formatDimensions, MetadataGroup } from './FileList';
import { formatLabel } from './formats';
import { BrowserSupportNotice } from './notices';
import { ToolWorkspace } from './ToolWorkspace';
import { useImagePdfBatch, type ImagePdfItem, type ImagePdfJob } from './useImagePdfBatch';
import { useInitialFiles, type ToolProps } from './useInitialFiles';

/** Größere Bilder bekommen keine Vorschau: Das Dekodieren für ein Thumbnail soll den Browser nicht belasten. */
const PREVIEW_MAX_PIXELS = 12_000_000;

const STATUS = {
  checking: { label: 'Wird geprüft', badge: 'badge-neutral' },
  ready: { label: 'Bereit', badge: 'badge-accent' },
  invalid: { label: 'Nicht verwendbar', badge: 'badge-danger' },
} as const;

function Choice<T extends string>({ legend, options, value, onChange, disabled, hint }: {
  legend: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  hint?: string;
}) {
  const name = useId();
  const hintId = useId();
  return <fieldset className="fieldset" disabled={disabled} aria-describedby={hint ? hintId : undefined}>
    <legend className="legend">{legend}</legend>
    <div className="choice-group">
      {options.map((option) => <label key={option.value}>
        <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
        {option.label}
      </label>)}
    </div>
    {hint && <p id={hintId} className="hint">{hint}</p>}
  </fieldset>;
}

function Preview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url ? <img src={url} alt="" width={56} height={56} loading="lazy" decoding="async"
    className="h-14 w-14 shrink-0 rounded-control border border-border bg-surface object-cover" /> : null;
}

type Action = 'up' | 'down' | 'remove';

interface RowProps {
  readonly item: ImagePdfItem;
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly onMove: (id: string, delta: number, action: Action) => void;
  readonly onRemove: (id: string) => void;
  readonly buttonRef: (action: Action, element: HTMLButtonElement | null) => void;
}

function ImageRow({ item, index, count, disabled, onMove, onRemove, buttonRef }: RowProps) {
  const status = STATUS[item.status];
  const showPreview = item.status === 'ready' && (item.width ?? 0) * (item.height ?? 0) <= PREVIEW_MAX_PIXELS;
  return <li className="file-row" data-status={item.status} data-testid="image-row">
    <div className="flex min-w-0 flex-wrap items-start gap-3">
      {showPreview && <Preview file={item.file} />}
      <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
        <h3 className="file-name whitespace-normal break-all" title={item.name}>
          <span className="tabular-nums">Seite {index + 1}</span>: {item.name}
        </h3>
        <p className="hint tabular-nums">
          {item.format && item.width && item.height ? `${formatLabel(item.format)} · ${formatDimensions(item.width, item.height)} · ` : ''}
          {formatBytes(item.size)}
        </p>
      </div>
      <span className={`badge max-w-full whitespace-normal ${status.badge}`}>
        <span className="sr-only">Status: </span>{status.label}
      </span>
    </div>
    {item.error && <p className="field-error">{item.error}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-ghost" ref={(element) => buttonRef('up', element)}
        disabled={disabled || index === 0} aria-label={`${item.name} eine Seite nach vorn`} onClick={() => onMove(item.id, -1, 'up')}>
        Nach oben
      </button>
      <button type="button" className="btn btn-ghost" ref={(element) => buttonRef('down', element)}
        disabled={disabled || index === count - 1} aria-label={`${item.name} eine Seite nach hinten`} onClick={() => onMove(item.id, 1, 'down')}>
        Nach unten
      </button>
      <button type="button" className="btn btn-ghost" ref={(element) => buttonRef('remove', element)}
        disabled={disabled} aria-label={`Bild ${item.name} entfernen`} onClick={() => onRemove(item.id)}>
        Entfernen
      </button>
    </div>
  </li>;
}

function JobResult({ job, name }: { job: ImagePdfJob; name: string }) {
  if (job.status === 'idle') return null;
  const waiting = job.status === 'queued' ? (job.jobProgress?.position ? `Wartet auf Verarbeitung (Platz ${job.jobProgress.position})` : 'Wartet auf Verarbeitung')
    : job.status === 'uploading' ? 'Wird hochgeladen'
    : job.status === 'processing' ? 'Wird verarbeitet' : null;
  const fraction = job.status === 'processing' ? job.jobProgress?.fraction : undefined;
  const expired = Boolean(job.status === 'done' && job.expiresAt && Date.parse(job.expiresAt) <= Date.now());
  return <div className="file-row" data-status={job.status} data-testid="pdf-job">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <h3 className="file-name whitespace-normal break-all">{job.outputName ?? name}</h3>
      <span className={`badge max-w-full whitespace-normal ${job.status === 'done' && !expired ? 'badge-success' : job.status === 'error' || expired ? 'badge-danger' : 'badge-accent'}`}>
        <span className="sr-only">Status: </span>{expired ? 'Abgelaufen' : job.status === 'done' ? 'Fertig' : job.status === 'error' ? 'Fehler' : waiting}
      </span>
    </div>
    {waiting && <progress className="progress" aria-label="PDF wird erstellt" {...(fraction === undefined ? {} : { value: Math.round(fraction * 100), max: 100 })} />}
    {job.error && <p className="field-error" role="alert">{job.error}</p>}
    {job.status === 'done' && job.result && job.resultUrl && !expired && <div className="file-result">
      <MetadataGroup label="Ergebnis">
        <div><dt>Format</dt><dd>PDF · {imagePdfPageLabel(job.result.settings)}</dd></div>
        <div><dt>Seiten</dt><dd>{job.result.pageCount}</dd></div>
        <div><dt>Größe</dt><dd>{formatBytes(job.result.size)}</dd></div>
        <div><dt>Dateiname</dt><dd className="break-all">{job.outputName}</dd></div>
      </MetadataGroup>
      <a className="btn btn-secondary max-w-full whitespace-normal break-all" href={job.resultUrl} download={job.outputName}>
        Herunterladen<span className="sr-only">: {job.outputName}</span>
      </a>
      {job.expiresAt && <p className="hint">Verfügbar bis <time dateTime={job.expiresAt}>{new Date(job.expiresAt).toLocaleString('de-DE')}</time>.</p>}
    </div>}
  </div>;
}

export default function ImagePdfConverter({ initialFiles }: ToolProps) {
  const batch = useImagePdfBatch();
  const { items, job, support, limits, counts, isProcessing } = batch;
  const [hydrated, setHydrated] = useState(false);
  const [settings, setSettings] = useState<ImagePdfSettings>(DEFAULT_IMAGE_PDF_SETTINGS);
  const [message, setMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const listHeading = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<{ id: string; action: Action } | null>(null);
  useEffect(() => setHydrated(true), []);

  const handleFiles = useCallback((files: File[]) => {
    const { added, rejected } = batch.addFiles(files);
    setMessage(rejected > 0 ? `Es sind höchstens ${limits.maxImages} Bilder pro PDF möglich; ${rejected} ${rejected === 1 ? 'Bild wurde' : 'Bilder wurden'} nicht übernommen.` : null);
    if (added) setAnnouncement(`${added} ${added === 1 ? 'Bild' : 'Bilder'} hinzugefügt. Die Prüfung läuft lokal; es wurde nichts hochgeladen.`);
  }, [batch.addFiles, limits.maxImages]);
  useInitialFiles(support.status === 'ready', initialFiles, handleFiles);

  const buttonRef = useCallback((id: string, action: Action, element: HTMLButtonElement | null) => {
    if (element) buttons.current.set(`${id}:${action}`, element); else buttons.current.delete(`${id}:${action}`);
  }, []);

  // Nach dem Verschieben behält dieselbe Schaltfläche den Fokus, auch wenn der Browser die Zeile neu einhängt.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const element = buttons.current.get(`${target.id}:${target.action}`);
    if (element && !element.disabled) element.focus();
    else buttons.current.get(`${target.id}:${target.action === 'up' ? 'down' : 'up'}`)?.focus();
  }, [items]);

  const handleMove = (id: string, delta: number, action: Action) => {
    const item = items.find((entry) => entry.id === id);
    const index = items.findIndex((entry) => entry.id === id);
    pendingFocus.current = { id, action };
    batch.move(id, delta);
    if (item) setAnnouncement(`${item.name} steht jetzt auf Seite ${index + delta + 1} von ${items.length}.`);
  };
  const handleRemove = (id: string) => {
    const index = items.findIndex((entry) => entry.id === id);
    const target = items[index + 1] ?? items[index - 1];
    batch.remove(id);
    setMessage(null);
    setAnnouncement('Bild entfernt.');
    requestAnimationFrame(() => {
      if (target) buttons.current.get(`${target.id}:remove`)?.focus(); else button.current?.focus();
    });
  };
  const reset = () => { batch.reset(); setMessage(null); setAnnouncement('Alle Bilder entfernt.'); button.current?.focus(); };

  let disabledReason: string | null = null;
  if (!hydrated || support.status === 'checking') disabledReason = 'Die Verfügbarkeit wird geprüft …';
  else if (support.status === 'unsupported') disabledReason = 'Bild zu PDF ist derzeit nicht verfügbar.';
  else if (isProcessing) disabledReason = 'Die PDF wird erstellt.';
  else if (!counts.total) disabledReason = 'Wählen Sie zuerst mindestens ein Bild aus.';
  else if (counts.checking) disabledReason = 'Die Bilder werden geprüft.';
  else if (counts.invalid) disabledReason = 'Entfernen Sie die nicht verwendbaren Bilder, damit die Seitenreihenfolge stimmt.';
  else if (batch.selectionProblem) disabledReason = batch.selectionProblem;

  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={support} />
    <ToolWorkspace selectionTitle="Bilder auswählen und ordnen" selection={<>
      <DropZone accept={IMAGE_PDF_ACCEPT} multiple disabled={!hydrated || support.status !== 'ready'} onFiles={handleFiles} buttonRef={button} title="Bilder hierher ziehen" buttonLabel="Bilder auswählen">
        <p>JPEG, PNG, WebP, GIF (unbewegt) und BMP. Höchstens {limits.maxImages} Bilder, {formatBytes(limits.maxImageBytes)} je Bild und {formatBytes(limits.maxTotalBytes)} zusammen. Jedes Bild wird eine Seite.</p>
      </DropZone>
      {message && <p className="notice notice-error" role="alert">{message}</p>}
      <h3 id={listHeading} className="text-base font-semibold">Seitenreihenfolge</h3>
      {items.length === 0
        ? <p className="hint">Noch keine Bilder ausgewählt.</p>
        : <>
          <p className="hint">Die Bilder erscheinen in dieser Reihenfolge als Seiten der PDF. Mit den Schaltflächen ändern Sie die Reihenfolge.</p>
          <ol className="file-list" aria-labelledby={listHeading}>
            {items.map((item, index) => <ImageRow key={item.id} item={item} index={index} count={items.length} disabled={isProcessing}
              onMove={handleMove} onRemove={handleRemove} buttonRef={(action, element) => buttonRef(item.id, action, element)} />)}
          </ol>
        </>}
    </>} settings={<>
      <Choice legend="Seitenformat" options={IMAGE_PDF_PAGE_SIZES} value={settings.pageSize} disabled={isProcessing}
        onChange={(pageSize) => setSettings((current) => ({ ...current, pageSize }))} />
      <Choice legend="Ausrichtung" options={IMAGE_PDF_ORIENTATIONS} value={settings.pageSize === 'fit' ? 'auto' : settings.orientation}
        disabled={isProcessing || settings.pageSize === 'fit'} onChange={(orientation) => setSettings((current) => ({ ...current, orientation }))}
        hint={settings.pageSize === 'fit' ? 'Bei „Bildgröße“ richtet sich jede Seite nach ihrem Bild.' : 'Automatisch: Querformat für breite, Hochformat für hohe Bilder.'} />
      <Choice legend="Rand" options={IMAGE_PDF_MARGINS} value={settings.margin} disabled={isProcessing}
        onChange={(margin) => setSettings((current) => ({ ...current, margin }))} />
      <p className="hint">Bilder werden eingepasst und zentriert, nie beschnitten. Transparente Bereiche werden weiß. JPEG-Bilder werden unverändert übernommen, andere verlustfrei; Metadaten wie EXIF werden nicht übernommen.</p>
      <p className="hint">Höchstens {formatBytes(limits.maxOutputBytes)} Ausgabe; Zeitlimit 300 Sekunden.</p>
    </>} actionTitle="PDF erstellen" action={<ActionBar processLabel="PDF erstellen"
      onProcess={() => { setAnnouncement('PDF-Erstellung gestartet.'); void batch.process(settings).then(() => setAnnouncement('Verarbeitung beendet. Ergebnis oder Fehler steht unter „Dateien und Ergebnisse“.')); }}
      onReset={reset} counts={counts} isProcessing={isProcessing} progress={batch.progress} disabledReason={disabledReason} />}
      resultsHeadingId={heading} resultsHint="Nach dem ausdrücklichen Start erscheint hier Ihre PDF zum Herunterladen. Bis dahin verlassen Ihre Bilder den Browser nicht."
      results={job.status === 'idle' ? <p className="hint">Noch keine PDF erstellt.</p> : <JobResult job={job} name="bilder.pdf" />} />
    <div aria-live="polite" className="sr-only" data-testid="live-region">{announcement}</div>
  </div>;
}
