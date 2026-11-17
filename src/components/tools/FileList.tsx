import { useRef, type ReactNode } from 'react';
import { formatBytes, formatSizeChange } from '../../lib/format';
import type { JobProgress } from '../../lib/api/progress';
import type { ImageErrorCode, InputFormat } from '../../lib/image';
import { imageErrorMessage } from './errorMessages';
import { formatLabel } from './formats';
import type { BatchEntry, EntryStatus } from './useImageBatch';

const STATUS: Readonly<Record<EntryStatus, { label: string; badge: string }>> = {
  checking: { label: 'Wird geprüft', badge: 'badge-neutral' },
  ready: { label: 'Bereit', badge: 'badge-accent' },
  invalid: { label: 'Nicht verwendbar', badge: 'badge-danger' },
  uploading: { label: 'Wird hochgeladen', badge: 'badge-accent' },
  queued: { label: 'Wartet auf Verarbeitung', badge: 'badge-neutral' },
  processing: { label: 'Wird verarbeitet', badge: 'badge-accent' },
  done: { label: 'Fertig', badge: 'badge-success' },
  error: { label: 'Fehler', badge: 'badge-danger' },
};

const numberDe = new Intl.NumberFormat('de-DE');

export function formatDimensions(width: number, height: number): string {
  return `${numberDe.format(width)} × ${numberDe.format(height)} px`;
}

/** Gemeinsame Felder eines Listeneintrags der Bild- und Audiowerkzeuge. */
export interface FileEntry {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly status: EntryStatus;
  /** Vorhanden, sobald ein Ergebnis vorliegt (für die Ablaufanzeige). */
  readonly result?: unknown;
  readonly resultUrl?: string;
  readonly outputName?: string;
  readonly error?: ImageErrorCode;
  readonly serverError?: string;
  readonly expiresAt?: string;
  /** Warteposition bzw. Fortschritt laut Server. */
  readonly jobProgress?: JobProgress;
}

/** Werkzeugspezifische Darstellung in einer Dateizeile. */
export interface EntryRenderers<E extends FileEntry> {
  /** Text vor der Größe in der Zeile „Original:“, z. B. „PNG · 32 × 24 px · “. */
  readonly originalPrefix: (entry: E) => string;
  /** Ergebnisbereich bei status 'done'. */
  readonly renderResult: (entry: E) => ReactNode;
}

export interface FileRowProps {
  readonly entry: BatchEntry;
  readonly onRemove: (id: string) => void;
  readonly removeButtonRef?: (element: HTMLButtonElement | null) => void;
  /** Zusätzliche Hinweise je Werkzeug unterhalb des Ergebnisses. */
  readonly extraNotes?: (entry: BatchEntry) => ReactNode;
}

/** Kasten „Original“ bzw. „Ergebnis“ mit Beschreibungsliste; children sind die dt/dd-Paare. */
export function MetadataGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-3 rounded-control border border-border bg-surface p-3">
      <h4 className="text-base font-semibold">{label}</h4>
      <dl className="meta-list">{children}</dl>
    </div>
  );
}

function ImageMetadata({ label, format, width, height, size }: {
  label: string;
  format?: InputFormat;
  width?: number;
  height?: number;
  size: number;
}) {
  return (
    <MetadataGroup label={label}>
      {format && <div><dt>Format</dt><dd>{formatLabel(format)}</dd></div>}
      {width !== undefined && height !== undefined && <div><dt>Maße</dt><dd>{formatDimensions(width, height)}</dd></div>}
      <div><dt>Größe</dt><dd>{formatBytes(size)}</dd></div>
    </MetadataGroup>
  );
}

export interface ResultSummaryProps {
  readonly entry: FileEntry;
  /** Ergebnisgröße in Bytes. */
  readonly resultSize: number;
  readonly original: ReactNode;
  readonly result: ReactNode;
  /** Zusätzliche Hinweise zum Ergebnis. */
  readonly notes?: readonly string[];
}

/** Vergleich Original/Ergebnis mit Größenänderung, Dateiname, Hinweisen und Download. */
export function ResultSummary({ entry, resultSize, original, result, notes = [] }: ResultSummaryProps) {
  const { resultUrl, outputName } = entry;
  if (!resultUrl || !outputName) return null;
  const change = entry.size > 0 ? formatSizeChange(entry.size, resultSize) : null;

  return (
    <div className="file-result">
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {original}
        {result}
      </div>
      <dl className="meta-list">
        {change && <div>
          <dt>Änderung</dt>
          <dd data-size-change={change.kind} className={change.kind === 'larger' ? 'text-warning' : undefined}>
            {change.percent} · {change.kind === 'smaller' ? 'kleiner' : change.kind === 'larger' ? 'größer' : 'Keine Einsparung'}
          </dd>
        </div>}
        <div>
          <dt>Dateiname</dt>
          <dd className="break-all">{outputName}</dd>
        </div>
      </dl>
      {change?.kind === 'larger' && (
        <p className="notice notice-warn text-sm">
          <span className="notice-title">Größer als das Original.</span> Das Ergebnis ist {change.percent.replace('+', '')}{' '}
          größer als die Ausgangsdatei.
        </p>
      )}
      {change?.kind === 'equal' && (
        <p className="hint">
          Das Ergebnis ist genau so groß wie das Original.
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="hint">
          {note}
        </p>
      ))}
      <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-border pt-3">
        <a className="btn btn-secondary max-w-full whitespace-normal break-all" href={resultUrl} download={outputName}>
          Herunterladen<span className="sr-only">: {outputName}</span>
        </a>
        {entry.expiresAt && <p className="hint">Verfügbar bis <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString('de-DE')}</time>.</p>}
      </div>
    </div>
  );
}

function ResultDetails({ entry }: { entry: BatchEntry }) {
  const { result } = entry;
  if (!result) return null;
  const notes: string[] = [];
  if (result.transparencyFlattened) notes.push('Transparente Bereiche wurden mit der Hintergrundfarbe gefüllt.');
  if (result.upscaled) notes.push('Das Bild wurde vergrößert; dabei entstehen keine zusätzlichen Details.');
  return (
    <ResultSummary
      entry={entry}
      resultSize={result.size}
      original={<ImageMetadata label="Original" format={entry.probe?.format} width={entry.probe?.width} height={entry.probe?.height} size={entry.size} />}
      result={<ImageMetadata label="Ergebnis" format={result.format} width={result.width} height={result.height} size={result.size} />}
      notes={notes}
    />
  );
}

function imageOriginalPrefix(entry: BatchEntry): string {
  const { probe } = entry;
  return probe ? `${formatLabel(probe.format)} · ${formatDimensions(probe.width, probe.height)} · ` : '';
}

function imageResult(entry: BatchEntry): ReactNode {
  return <ResultDetails entry={entry} />;
}

export interface EntryRowProps<E extends FileEntry> extends EntryRenderers<E> {
  readonly entry: E;
  readonly onRemove: (id: string) => void;
  readonly removeButtonRef?: (element: HTMLButtonElement | null) => void;
  readonly extraNotes?: (entry: E) => ReactNode;
}

/** Dateizeile mit Status, Entfernen, Fehlern und werkzeugspezifischem Ergebnis. */
export function EntryRow<E extends FileEntry>({ entry, onRemove, removeButtonRef, extraNotes, originalPrefix, renderResult }: EntryRowProps<E>) {
  const expired = Boolean(entry.result && entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now());
  const base = expired ? { label: 'Abgelaufen', badge: 'badge-warn' } : STATUS[entry.status];
  const position = entry.status === 'queued' ? entry.jobProgress?.position : undefined;
  const fraction = entry.status === 'processing' ? entry.jobProgress?.fraction : undefined;
  const status = position ? { ...base, label: `Wartet auf Verarbeitung (Platz ${position})` } : base;
  return (
    <li className="file-row" data-status={entry.status}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 basis-full sm:basis-auto sm:flex-1">
          <h3 className="file-name whitespace-normal break-all" title={entry.name}>
            {entry.name}
          </h3>
          {entry.status !== 'done' && <p className="hint tabular-nums">
            <span className="font-medium">Original: </span>
            {originalPrefix(entry)}
            {formatBytes(entry.size)}
          </p>}
        </div>
        <span className={`badge max-w-full whitespace-normal ${status.badge}`}>
          <span className="sr-only">Status: </span>
          {status.label}
        </span>
        <button
          ref={removeButtonRef}
          type="button"
          className="btn btn-ghost shrink-0"
          aria-label={`Datei ${entry.name} entfernen`}
          onClick={() => onRemove(entry.id)}
        >
          Entfernen
        </button>
      </div>
      {entry.error && (entry.status === 'invalid' || entry.status === 'error') && (
        <p className="field-error">{imageErrorMessage(entry.error)}</p>
      )}
      {entry.serverError && <p className="field-error">{entry.serverError}</p>}
      {expired && entry.expiresAt && <p className="hint">Abgelaufen am <time dateTime={entry.expiresAt}>{new Date(entry.expiresAt).toLocaleString('de-DE')}</time>.</p>}
      {entry.status === 'processing' && <progress className="progress" aria-label={`${entry.name} wird verarbeitet`} {...(fraction === undefined ? {} : { value: Math.round(fraction * 100), max: 100 })} />}
      {entry.status === 'done' && !expired && renderResult(entry)}
      {extraNotes?.(entry)}
    </li>
  );
}

export function FileRow(props: FileRowProps) {
  return <EntryRow {...props} originalPrefix={imageOriginalPrefix} renderResult={imageResult} />;
}

export interface EntryListProps<E extends FileEntry> extends EntryRenderers<E> {
  readonly entries: readonly E[];
  readonly onRemove: (id: string) => void;
  /** Wird aufgerufen, wenn nach dem Entfernen keine Datei mehr übrig ist (z. B. Fokus auf Dateiauswahl). */
  readonly onEmptied?: () => void;
  /** Überschrift der Liste (für aria-labelledby). */
  readonly labelledBy?: string;
  readonly emptyText?: string;
  readonly extraNotes?: (entry: E) => ReactNode;
}

/**
 * Dateiliste mit Fokusführung: Nach dem Entfernen erhält der Entfernen-Button der nachfolgenden
 * (sonst der vorherigen) Datei den Fokus; ist die Liste leer, wird onEmptied aufgerufen.
 */
export function EntryList<E extends FileEntry>({
  entries,
  onRemove,
  onEmptied,
  labelledBy,
  emptyText = 'Noch keine Dateien ausgewählt.',
  extraNotes,
  originalPrefix,
  renderResult,
}: EntryListProps<E>) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  if (entries.length === 0) {
    return <p className="hint">{emptyText}</p>;
  }

  const handleRemove = (id: string) => {
    const index = entries.findIndex((entry) => entry.id === id);
    const target = entries[index + 1] ?? entries[index - 1];
    onRemove(id);
    // Ziel vor der Änderung bestimmen: laufende Vorabprüfungen können gleichzeitig rendern.
    requestAnimationFrame(() => {
      if (target) buttons.current.get(target.id)?.focus();
      else onEmptied?.();
    });
  };

  return (
    <ul className="file-list" aria-labelledby={labelledBy}>
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          onRemove={handleRemove}
          extraNotes={extraNotes}
          originalPrefix={originalPrefix}
          renderResult={renderResult}
          removeButtonRef={(element) => {
            if (element) buttons.current.set(entry.id, element);
            else buttons.current.delete(entry.id);
          }}
        />
      ))}
    </ul>
  );
}

export type FileListProps = Omit<EntryListProps<BatchEntry>, keyof EntryRenderers<BatchEntry>>;

/** Dateiliste der Bildwerkzeuge (Format, Maße, Größe). */
export function FileList(props: FileListProps) {
  return <EntryList {...props} originalPrefix={imageOriginalPrefix} renderResult={imageResult} />;
}
