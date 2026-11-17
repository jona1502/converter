import type { Job } from './client';

/** Aus dem Auftrag abgeleitete Anzeige: Warteposition (1-basiert) oder Fortschritt 0–1. */
export interface JobProgress {
  readonly position?: number;
  readonly fraction?: number;
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/**
 * Liest das freie progress-Objekt des Servers: wartende Aufträge melden
 * {step:'queue',position}, laufende ggf. Zähler {current,total}.
 */
export function jobProgress(job: Pick<Job, 'state' | 'progress'>): JobProgress | undefined {
  const progress = job.progress;
  if (!progress) return undefined;
  if (job.state === 'queued') {
    const position = count(progress.position);
    return progress.step === 'queue' && position !== undefined && Number.isInteger(position) && position >= 1 ? { position } : undefined;
  }
  if (job.state !== 'running') return undefined;
  const current = count(progress.current);
  const total = count(progress.total);
  return current !== undefined && total !== undefined && total > 0 ? { fraction: Math.min(1, current / total) } : undefined;
}
