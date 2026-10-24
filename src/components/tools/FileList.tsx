import { useRef, type ReactNode } from 'react';
import { formatBytes, formatSizeChange } from '../../lib/format';
import { imageErrorMessage } from './errorMessages';
import { formatLabel } from './formats';
import type { BatchEntry, EntryStatus } from './useImageBatch';

const STATUS: Readonly<Record<EntryStatus, { label: string; badge: string }>> = {
  checking: { label: 'Wird geprüft', badge: 'badge-neutral' },
  ready: { label: 'Bereit', badge: 'badge-accent' },
  invalid: { label: 'Nicht verwendbar', badge: 'badge-danger' },
  uploading: { label: 'Wird hochgeladen', badge: 'badge-accent' },
  queued: { label: 'Wartet', badge: 'badge-neutral' },
  processing: { label: 'Wird verarbeitet', badge: 'badge-accent' },
  done: { label: 'Fertig', badge: 'badge-success' },
  error: { label: 'Fehler', badge: 'badge-danger' },
};

const numberDe = new Intl.NumberFormat('de-DE');

export function formatDimensions(width: number, height: number): string {
  return `${numberDe.format(width)} × ${numberDe.format(height)} px`;
}

export interface FileRowProps {
  readonly entry: BatchEntry;
  readonly onRemove: (id: string) => void;
  readonly removeButtonRef?: (element: HTMLButtonElement | null) => void;
  /** Zusätzliche Hinweise je Werkzeug unterhalb des Ergebnisses. */
  readonly extraNotes?: (entry: BatchEntry) => ReactNode;
}

function ResultDetails({ entry }: { entry: BatchEntry }) {
  const { result, resultUrl, outputName } = entry;
  if (!result || !resultUrl || !outputName) return null;
  const change = entry.size > 0 ? formatSizeChange(entry.size, result.size) : null;
  const notes: string[] = [];
  if (result.transparencyFlattened) notes.push('Transparente Bereiche wurden mit der Hintergrundfarbe gefüllt.');
  if (result.upscaled) notes.push('Das Bild wurde vergrößert; dabei entstehen keine zusätzlichen Details.');

  return (
    <div className="file-result">
      <dl className="meta-list">
        <div>
          <dt>Ergebnis</dt>
          <dd>
            {formatLabel(result.format)} · {formatDimensions(result.width, result.height)}
          </dd>
        </div>
        <div>
          <dt>Größe</dt>
          <dd>
            {formatBytes(result.size)}
            {change && (
              <>
                {' '}
                <span className={change.kind === 'larger' ? 'font-semibold text-warning' : undefined}>
                  ({change.percent})
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Dateiname</dt>
          <dd className="break-all">{outputName}</dd>
        </div>
      </dl>
      {change?.kind === 'larger' && (
        <p className="notice notice-warn text-sm" data-size-change="larger">
          <span className="notice-title">Größer als das Original.</span> Das Ergebnis ist {change.percent.replace('+', '')}{' '}
          größer als die Ausgangsdatei.
        </p>
      )}
      {change?.kind === 'equal' && (
        <p className="text-sm text-muted" data-size-change="equal">
          <span className="badge badge-neutral">Keine Einsparung</span> Das Ergebnis ist genau so groß wie das Original.
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="hint">
          {note}
        </p>
      ))}
      <a className="btn btn-secondary btn-sm self-start" href={resultUrl} download={outputName}>
        Herunterladen<span className="sr-only">: {outputName}</span>
      </a>
    </div>
  );
}

export function FileRow({ entry, onRemove, removeButtonRef, extraNotes }: FileRowProps) {
  const status = STATUS[entry.status];
  const { probe } = entry;
  return (
    <li className="file-row" data-status={entry.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="file-name" title={entry.name}>
            {entry.name}
          </p>
          <p className="hint">
            {probe ? `${formatLabel(probe.format)} · ${formatDimensions(probe.width, probe.height)} · ` : ''}
            {formatBytes(entry.size)}
          </p>
        </div>
        <span className={`badge shrink-0 ${status.badge}`}>
          <span className="sr-only">Status: </span>
          {status.label}
        </span>
        <button
          ref={removeButtonRef}
          type="button"
          className="btn btn-ghost btn-sm shrink-0"
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
      {entry.expiresAt && <p className="hint">Verfügbar bis {new Date(entry.expiresAt).toLocaleString('de-DE')}.</p>}
      {entry.status === 'processing' && <progress className="progress" aria-label={`${entry.name} wird verarbeitet`} />}
      {entry.status === 'done' && <ResultDetails entry={entry} />}
      {extraNotes?.(entry)}
    </li>
  );
}

export interface FileListProps {
  readonly entries: readonly BatchEntry[];
  readonly onRemove: (id: string) => void;
  /** Wird aufgerufen, wenn nach dem Entfernen keine Datei mehr übrig ist (z. B. Fokus auf Dateiauswahl). */
  readonly onEmptied?: () => void;
  /** Überschrift der Liste (für aria-labelledby). */
  readonly labelledBy?: string;
  readonly emptyText?: string;
  readonly extraNotes?: (entry: BatchEntry) => ReactNode;
}

/**
 * Dateiliste mit Fokusführung: Nach dem Entfernen erhält der Entfernen-Button der nachfolgenden
 * (sonst der vorherigen) Datei den Fokus; ist die Liste leer, wird onEmptied aufgerufen.
 */
export function FileList({
  entries,
  onRemove,
  onEmptied,
  labelledBy,
  emptyText = 'Noch keine Dateien ausgewählt.',
  extraNotes,
}: FileListProps) {
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
        <FileRow
          key={entry.id}
          entry={entry}
          onRemove={handleRemove}
          extraNotes={extraNotes}
          removeButtonRef={(element) => {
            if (element) buttons.current.set(entry.id, element);
            else buttons.current.delete(entry.id);
          }}
        />
      ))}
    </ul>
  );
}
