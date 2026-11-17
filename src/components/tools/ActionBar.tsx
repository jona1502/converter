import { useId, type Ref } from 'react';
import type { BatchCounts, RunProgress } from './useImageBatch';

export interface BatchSummaryProps {
  readonly progress: RunProgress | null;
  readonly isProcessing: boolean;
}

/** Stand des aktuellen bzw. letzten Durchlaufs – nur gezählte Dateien, keine geschätzten Prozente. */
export function BatchSummary({ progress, isProcessing }: BatchSummaryProps) {
  if (!progress) return null;
  const { total, done, failed, finished } = progress;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4" data-testid="batch-summary">
      <p className="text-sm font-medium tabular-nums">
        {isProcessing ? 'Verarbeitung läuft: ' : ''}
        {done} von {total} fertig
        {failed > 0 && <span className="text-danger">, {failed} mit Fehler</span>}
      </p>
      <progress className="progress" max={total} value={finished} aria-label="Fortschritt des Stapels">
        {finished} von {total}
      </progress>
    </div>
  );
}

export interface ActionBarProps {
  /** Beschriftung der Hauptaktion, z. B. „Konvertieren“. */
  readonly processLabel: string;
  readonly onProcess: () => void;
  readonly onReset: () => void;
  readonly counts: BatchCounts;
  readonly isProcessing: boolean;
  readonly progress: RunProgress | null;
  /** Grund, warum die Hauptaktion nicht möglich ist; null = möglich. */
  readonly disabledReason: string | null;
  readonly processButtonRef?: Ref<HTMLButtonElement>;
  /** ZIP-Download aller fertigen Ergebnisse; null = nicht verfügbar. */
  readonly zipHref?: string | null;
}

export function ActionBar({
  processLabel,
  onProcess,
  onReset,
  counts,
  isProcessing,
  progress,
  disabledReason,
  processButtonRef,
  zipHref,
}: ActionBarProps) {
  const reasonId = useId();
  const disabled = disabledReason !== null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="hint tabular-nums">
        {counts.total === 0
          ? 'Keine Dateien in der Liste.'
          : `${counts.total} ${counts.total === 1 ? 'Datei' : 'Dateien'} in der Liste, davon ${counts.processable} verarbeitbar${
              counts.invalid > 0 ? `, ${counts.invalid} nicht verwendbar` : ''
            }${counts.checking > 0 ? `, ${counts.checking} in Prüfung` : ''}.`}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <button
          ref={processButtonRef}
          type="button"
          className="btn btn-primary sm:flex-1"
          disabled={disabled}
          aria-describedby={disabled ? reasonId : undefined}
          onClick={onProcess}
        >
          {processLabel}
        </button>
        <button type="button" className="btn btn-secondary" disabled={counts.total === 0} onClick={onReset}>
          Alle entfernen
        </button>
      </div>
      {disabled && (
        <p id={reasonId} className="hint">
          {disabledReason}
        </p>
      )}
      <BatchSummary progress={progress} isProcessing={isProcessing} />
      {zipHref && (
        <a className="btn btn-secondary" href={zipHref} download="ergebnisse.zip">
          Alle als ZIP speichern
        </a>
      )}
    </div>
  );
}
