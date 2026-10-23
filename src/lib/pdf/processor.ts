/**
 * Client im Hauptthread: steuert genau einen Modul-Worker, berechnet Varianten strikt nacheinander
 * und überwacht das Speicherbudget der gelieferten Ergebnisse.
 */
import { abortedError, deserializePdfError } from './errors';
import { PDF_LIMITS } from './limits';
import {
  GLOBAL_PDF_ERROR_CODES,
  PDF_QUALITY_LEVELS,
  PdfProcessingError,
  type PdfAnalysis,
  type PdfCompressOptions,
  type PdfCompressor,
  type PdfQualityLevel,
  type PdfVariantOutcome,
  type PdfVariantResult,
  type PdfVariantStatus,
} from './types';
import type { PdfWorkerRequest, PdfWorkerResponse } from './worker-protocol';

export interface PdfCompressorOptions {
  /** Erzeugt den Worker. Austauschbar für Tests; Standard ist der Modul-Worker worker.ts. */
  readonly createWorker?: () => Worker;
  /** Budget für die Summe der gelieferten Ergebnisse je compressAll. Standard: PDF_LIMITS. */
  readonly maxResultBytesTotal?: number;
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

type Progress = Extract<PdfWorkerResponse, { type: 'progress' }>;
type Settled = Exclude<PdfWorkerResponse, Progress>;
type Request = PdfWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

interface Pending {
  readonly id: number;
  readonly onProgress: ((progress: Progress) => void) | undefined;
  readonly settle: (response: Settled | PdfProcessingError) => void;
}

export function createPdfCompressor(config: PdfCompressorOptions = {}): PdfCompressor {
  const createWorker = config.createWorker ?? defaultCreateWorker;
  const budget = config.maxResultBytesTotal ?? PDF_LIMITS.maxResultBytesTotal;
  let worker: Worker | null = null;
  let pending: Pending | null = null;
  let nextId = 1;
  let disposed = false;
  let tail: Promise<unknown> = Promise.resolve();

  function terminate(reason: PdfProcessingError): void {
    const p = pending;
    pending = null;
    if (worker) {
      worker.terminate();
      worker = null;
    }
    p?.settle(reason);
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    let w: Worker;
    try {
      w = createWorker();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PdfProcessingError('worker-failed', `Worker konnte nicht gestartet werden: ${message}`);
    }
    w.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      const data = event.data;
      const p = pending;
      if (!p || !data || data.id !== p.id) return;
      if (data.type === 'progress') {
        p.onProgress?.(data);
        return;
      }
      pending = null;
      p.settle(data);
    };
    w.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      terminate(new PdfProcessingError('worker-failed', 'Worker-Fehler (möglicherweise Speichermangel).'));
    };
    w.onmessageerror = () => terminate(new PdfProcessingError('worker-failed', 'Worker-Nachricht nicht lesbar.'));
    worker = w;
    return w;
  }

  function send(message: Request, signal: AbortSignal | undefined, onProgress?: (p: Progress) => void): Promise<Settled> {
    return new Promise<Settled>((resolve, reject) => {
      if (disposed) return reject(abortedError('Kompressor wurde beendet.'));
      if (signal?.aborted) return reject(abortedError());
      let w: Worker;
      try {
        w = ensureWorker();
      } catch (error) {
        return reject(error);
      }
      const id = nextId++;
      const onAbort = (): void => terminate(abortedError());
      signal?.addEventListener('abort', onAbort, { once: true });
      pending = {
        id,
        onProgress,
        settle: (response) => {
          signal?.removeEventListener('abort', onAbort);
          if (response instanceof PdfProcessingError) reject(response);
          else if (response.type === 'error') reject(deserializePdfError(response.error));
          else resolve(response);
        },
      };
      try {
        w.postMessage({ ...message, id } as PdfWorkerRequest);
      } catch {
        // Auch synchrone Clone-/Transportfehler müssen Pending und Abort-Listener freigeben.
        terminate(new PdfProcessingError('worker-failed', 'Auftrag konnte nicht an den Worker übertragen werden.'));
      }
    });
  }

  /** Höchstens ein Auftrag gleichzeitig; weitere warten. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  async function analyze(file: Blob, signal?: AbortSignal): Promise<PdfAnalysis> {
    return serial(async () => {
      const response = await send({ type: 'analyze', file }, signal);
      if (response.type !== 'analysis') throw new PdfProcessingError('worker-failed', 'Unerwartete Antwort.');
      return response.analysis;
    });
  }

  function validateLevels(levels: readonly PdfQualityLevel[]): void {
    const valid = levels.length > 0 && levels.every((l) => PDF_QUALITY_LEVELS.includes(l));
    if (!valid || new Set(levels).size !== levels.length) {
      throw new PdfProcessingError('invalid-options', `Ungültige Stufen: ${levels.join(', ')}`);
    }
  }

  async function compressAll(
    file: Blob,
    levels: readonly PdfQualityLevel[],
    options: PdfCompressOptions = {},
  ): Promise<PdfVariantOutcome[]> {
    validateLevels(levels);
    const { onStatus, onResult, signal } = options;
    const emit = (status: PdfVariantStatus): void => onStatus?.(status);
    return serial(async () => {
      if (signal?.aborted) throw abortedError();
      for (const level of levels) emit({ level, phase: 'queued' });
      const outcomes: PdfVariantOutcome[] = [];
      let delivered = 0;
      for (const level of levels) {
        if (signal?.aborted) throw abortedError();
        let response: Settled;
        try {
          response = await send({ type: 'compress', file, level }, signal, (p) => {
            if (p.phase === 'images') emit({ level, phase: 'images', current: p.current ?? 0, total: p.total ?? 0 });
            else emit({ level, phase: p.phase });
          });
        } catch (error) {
          const e = error instanceof PdfProcessingError ? error : new PdfProcessingError('worker-failed', String(error));
          if (e.code !== 'aborted') emit({ level, phase: 'error', errorCode: e.code });
          if (GLOBAL_PDF_ERROR_CODES.includes(e.code)) throw e;
          outcomes.push({ level, ok: false, error: e });
          continue;
        }
        if (response.type !== 'result') throw new PdfProcessingError('worker-failed', 'Unerwartete Antwort.');
        const size = response.buffer.byteLength;
        if (delivered + size > budget) {
          const e = new PdfProcessingError(
            'memory-limit',
            `Ergebnis (${size} Bytes) würde das Budget von ${budget} Bytes überschreiten (bereits ${delivered}).`,
          );
          emit({ level, phase: 'error', errorCode: e.code });
          outcomes.push({ level, ok: false, error: e });
          continue;
        }
        const blob = new Blob([response.buffer], { type: 'application/pdf' });
        delivered += blob.size;
        const result: PdfVariantResult = {
          level,
          blob,
          size: blob.size,
          originalSize: file.size,
          ...response.stats,
        };
        emit({ level, phase: 'done' });
        onResult?.(result);
        outcomes.push({ level, ok: true, result });
      }
      return outcomes;
    });
  }

  function dispose(): void {
    disposed = true;
    terminate(abortedError('Kompressor wurde beendet.'));
  }

  return { analyze, compressAll, dispose };
}
