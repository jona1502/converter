import { detectEncodeSupport } from './capabilities';
import { abortedError, deserializeError, toImageError } from './errors';
import { getConcurrency } from './limits';
import { runPipeline, validateProcessOptions } from './pipeline';
import {
  ImageProcessingError,
  type EncodeSupport,
  type ImageProcessor,
  type ProcessCallOptions,
  type ProcessOptions,
  type ProcessResult,
} from './types';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

export type ExecutionMode = 'worker' | 'main';

export interface ImageProcessorOptions {
  /** false: immer im Hauptthread verarbeiten. Standard: true (Worker, falls nutzbar). */
  readonly preferWorker?: boolean;
  /** Erzeugt einen Worker. Austauschbar für Tests; Standard ist der Modul-Worker worker.ts. */
  readonly createWorker?: () => Worker;
  /** Anzahl gleichzeitiger Verarbeitungen. Standard: getConcurrency(). */
  readonly concurrency?: number;
  /** Wartezeit auf die Fähigkeitsprüfung im Worker, danach Rückfall auf den Hauptthread. */
  readonly capabilityTimeoutMs?: number;
}

export interface CoreImageProcessor extends ImageProcessor {
  /** Wo verarbeitet wird ('worker' oder Rückfall 'main'). Diagnose und Tests. */
  getExecutionMode(): Promise<ExecutionMode>;
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

interface WorkerSlot {
  readonly worker: Worker;
  pending: { readonly id: number; readonly settle: (response: WorkerResponse | ImageProcessingError) => void } | null;
}

interface Job {
  readonly file: Blob;
  readonly options: ProcessOptions;
  readonly call: ProcessCallOptions | undefined;
  readonly controller: AbortController;
  readonly resolve: (result: ProcessResult) => void;
  readonly reject: (error: ImageProcessingError) => void;
  settled: boolean;
  slot: WorkerSlot | null;
  onAbort: (() => void) | null;
}

interface ModeInfo {
  readonly mode: ExecutionMode;
  readonly support: EncodeSupport;
}

/**
 * Erzeugt einen Bildprozessor mit Warteschlange, Worker-Pool (lazy) und Rückfall auf den Hauptthread.
 */
export function createImageProcessor(config: ImageProcessorOptions = {}): CoreImageProcessor {
  const preferWorker = config.preferWorker ?? true;
  const createWorker = config.createWorker ?? defaultCreateWorker;
  const concurrency = Math.max(1, Math.floor(config.concurrency ?? getConcurrency()));
  const capabilityTimeoutMs = config.capabilityTimeoutMs ?? 15_000;

  let disposed = false;
  let nextId = 1;
  let modePromise: Promise<ModeInfo> | null = null;
  const queue: Job[] = [];
  const running = new Set<Job>();
  const idle: WorkerSlot[] = [];
  const slots = new Set<WorkerSlot>();

  function createSlot(): WorkerSlot {
    const worker = createWorker();
    const slot: WorkerSlot = { worker, pending: null };
    const fail = (message: string): void => {
      const pending = slot.pending;
      destroySlot(slot);
      pending?.settle(new ImageProcessingError('decode-failed', message));
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = slot.pending;
      const data = event.data;
      if (!pending || !data || data.id !== pending.id) return;
      slot.pending = null;
      pending.settle(data);
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      fail('Worker-Fehler.');
    };
    worker.onmessageerror = () => fail('Worker-Nachricht nicht lesbar.');
    slots.add(slot);
    return slot;
  }

  /** Beendet einen Worker; ein offener Auftrag in ihm wird mit reason abgeschlossen. */
  function destroySlot(slot: WorkerSlot, reason?: ImageProcessingError): void {
    const pending = slot.pending;
    slot.pending = null;
    const known = slots.delete(slot);
    const index = idle.indexOf(slot);
    if (index >= 0) idle.splice(index, 1);
    if (known) slot.worker.terminate();
    if (pending && reason) pending.settle(reason);
  }

  function send(slot: WorkerSlot, request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      slot.pending = {
        id: request.id,
        settle: (response) => (response instanceof ImageProcessingError ? reject(response) : resolve(response)),
      };
      try {
        slot.worker.postMessage(request);
      } catch (error) {
        slot.pending = null;
        reject(toImageError(error, 'invalid-options'));
      }
    });
  }

  function releaseSlot(slot: WorkerSlot): void {
    if (!disposed && slots.has(slot) && !idle.includes(slot)) idle.push(slot);
  }

  async function determineMode(): Promise<ModeInfo> {
    if (preferWorker && typeof Worker !== 'undefined') {
      let slot: WorkerSlot | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const current = createSlot();
        slot = current;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), capabilityTimeoutMs);
        });
        const response = await Promise.race([send(current, { type: 'capabilities', id: nextId++ }), timeout]);
        if (response.type === 'capabilities' && response.usable && slots.has(current)) {
          releaseSlot(current);
          if (disposed) destroySlot(current);
          return { mode: 'worker', support: response.support };
        }
      } catch {
        // Worker nicht erzeugbar, nicht ladbar oder ohne nötige APIs: Rückfall auf Hauptthread.
      } finally {
        clearTimeout(timer);
      }
      if (slot) destroySlot(slot);
    }
    return { mode: 'main', support: await detectEncodeSupport() };
  }

  function ensureMode(): Promise<ModeInfo> {
    modePromise ??= determineMode();
    return modePromise;
  }

  function settle(job: Job, result: ProcessResult | null, error?: ImageProcessingError): void {
    if (job.settled) return;
    job.settled = true;
    if (job.onAbort) job.call?.signal?.removeEventListener('abort', job.onAbort);
    job.onAbort = null;
    if (error) job.reject(error);
    else job.resolve(result as ProcessResult);
  }

  function abortJob(job: Job, error: ImageProcessingError): void {
    if (job.settled) return;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.controller.abort();
    if (job.slot) {
      const slot = job.slot;
      job.slot = null;
      // Laufender Worker wird beendet; bei Bedarf entsteht später ein neuer.
      destroySlot(slot, error);
    }
    settle(job, null, error);
  }

  async function runInWorker(job: Job): Promise<ProcessResult> {
    let slot: WorkerSlot;
    try {
      slot = idle.pop() ?? createSlot();
    } catch {
      // Neuer Worker nicht erzeugbar: diesen Auftrag im Hauptthread erledigen.
      return runPipeline(job.file, job.options, job.controller.signal);
    }
    job.slot = slot;
    let response: WorkerResponse;
    try {
      response = await send(slot, { type: 'process', id: nextId++, file: job.file, options: job.options });
    } catch (error) {
      // Nachricht nicht zustellbar, Worker abgestürzt oder abgebrochen: Worker nicht wiederverwenden.
      job.slot = null;
      destroySlot(slot);
      throw error;
    }
    job.slot = null;
    releaseSlot(slot);
    if (response.type === 'process') return response.result;
    if (response.type === 'error') throw deserializeError(response.error);
    throw new ImageProcessingError('encode-failed', 'Unerwartete Antwort des Workers.');
  }

  async function runJob(job: Job): Promise<void> {
    try {
      const { mode } = await ensureMode();
      if (job.settled) return;
      const result =
        mode === 'worker' ? await runInWorker(job) : await runPipeline(job.file, job.options, job.controller.signal);
      settle(job, result);
    } catch (error) {
      settle(job, null, toImageError(error));
    } finally {
      running.delete(job);
      // Nächsten Auftrag erst nach den Reaktionen auf das Ergebnis starten.
      setTimeout(pump, 0);
    }
  }

  function pump(): void {
    while (!disposed && running.size < concurrency) {
      const job = queue.shift();
      if (!job) break;
      running.add(job);
      try {
        job.call?.onStart?.();
      } catch {
        // Fehler im Callback dürfen die Warteschlange nicht blockieren.
      }
      void runJob(job);
    }
  }

  return {
    async getEncodeSupport(): Promise<EncodeSupport> {
      if (disposed) throw abortedError('Prozessor wurde beendet.');
      return (await ensureMode()).support;
    },

    async getExecutionMode(): Promise<ExecutionMode> {
      if (disposed) throw abortedError('Prozessor wurde beendet.');
      return (await ensureMode()).mode;
    },

    process(file: Blob, options: ProcessOptions, call?: ProcessCallOptions): Promise<ProcessResult> {
      return new Promise<ProcessResult>((resolve, reject) => {
        if (disposed) {
          reject(abortedError('Prozessor wurde beendet.'));
          return;
        }
        if (call?.signal?.aborted) {
          reject(abortedError());
          return;
        }
        try {
          validateProcessOptions(options);
        } catch (error) {
          reject(toImageError(error, 'invalid-options'));
          return;
        }
        const job: Job = {
          file,
          options,
          call,
          controller: new AbortController(),
          resolve,
          reject,
          settled: false,
          slot: null,
          onAbort: null,
        };
        if (call?.signal) {
          job.onAbort = () => abortJob(job, abortedError());
          call.signal.addEventListener('abort', job.onAbort, { once: true });
        }
        queue.push(job);
        pump();
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      const error = abortedError('Prozessor wurde beendet.');
      for (const job of [...queue, ...running]) abortJob(job, error);
      queue.length = 0;
      for (const slot of [...slots]) destroySlot(slot, error);
      idle.length = 0;
    },
  };
}
