/**
 * Stapelverwaltung für die Bildwerkzeuge: Dateiliste, Vorabprüfung, Verarbeitung über einen
 * gemeinsamen Prozessor, Abbruch und Freigabe aller Objekt-URLs.
 *
 * Datenschutz: Dateien liegen nur im Arbeitsspeicher (React-State). Keine Speicherung in
 * Web Storage, IndexedDB oder Cache, keine Konsolenausgaben.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LIMITS,
  ImageProcessingError,
  buildOutputFileName,
  createImageProcessor,
  makeUniqueFileNames,
  probeImage,
  type EncodeSupport,
  type ImageErrorCode,
  type ImageProcessor,
  type ProbeResult,
  type ProcessOptions,
  type ProcessResult,
} from '../../lib/image';
import { errorCodeOf } from './errorMessages';

export type EntryStatus = 'checking' | 'ready' | 'invalid' | 'queued' | 'processing' | 'done' | 'error';

export interface BatchEntry {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly size: number;
  readonly status: EntryStatus;
  readonly probe?: ProbeResult;
  readonly result?: ProcessResult;
  /** Objekt-URL des Ergebnisses; wird beim Entfernen, Zurücksetzen und Neuverarbeiten widerrufen. */
  readonly resultUrl?: string;
  readonly outputName?: string;
  /** Fehler der Prüfung (status 'invalid') oder der Verarbeitung (status 'error'). */
  readonly error?: ImageErrorCode;
}

export type SupportState =
  | { readonly status: 'checking' }
  | { readonly status: 'ready'; readonly encode: EncodeSupport }
  /** apis: createImageBitmap/Canvas fehlen; encoder: kein Format kodierbar oder Prüfung fehlgeschlagen. */
  | { readonly status: 'unsupported'; readonly reason: 'apis' | 'encoder' };

export interface AddFilesOutcome {
  /** Anzahl übernommener Dateien. */
  readonly added: number;
  /** Wegen LIMITS.maxFiles abgelehnte Dateien (nicht still gekürzt). */
  readonly rejected: readonly File[];
  /** Erfüllt sich, wenn alle übernommenen Dateien geprüft sind. */
  readonly checked: Promise<{ readonly ready: number; readonly invalid: number }>;
}

export interface RunSummary {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
}

/** Suffix für den Ausgabenamen – fest oder je Eintrag (z. B. nur bei gleichem Format). */
export type SuffixInput = string | ((entry: BatchEntry, options: ProcessOptions) => string);

export interface BatchCounts {
  readonly total: number;
  readonly checking: number;
  readonly invalid: number;
  /** Gültige, verarbeitbare Einträge (bereit, fertig oder mit Verarbeitungsfehler). */
  readonly processable: number;
  readonly done: number;
  readonly failed: number;
}

export interface RunProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly finished: number;
}

const PROCESSABLE: ReadonlySet<EntryStatus> = new Set(['ready', 'done', 'error']);

export function isProcessable(entry: BatchEntry): boolean {
  return PROCESSABLE.has(entry.status);
}

/** Prüft, ob der Browser die für die Verarbeitung nötigen APIs bereitstellt. */
function hasRequiredApis(): boolean {
  if (typeof createImageBitmap !== 'function') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  if (typeof OffscreenCanvas !== 'undefined') return true;
  try {
    return !!document.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
}

export function useImageBatch() {
  const [entries, setEntries] = useState<readonly BatchEntry[]>([]);
  const [support, setSupport] = useState<SupportState>({ status: 'checking' });
  const [isProcessing, setIsProcessing] = useState(false);
  const [runIds, setRunIds] = useState<readonly string[] | null>(null);

  // Synchroner Spiegel des States, damit Grenzprüfung und Statuswechsel nie veraltete Werte sehen.
  const entriesRef = useRef<readonly BatchEntry[]>(entries);
  const processorRef = useRef<ImageProcessor | null>(null);
  const controllersRef = useRef(new Map<string, AbortController>());
  const urlsRef = useRef(new Map<string, string>());
  const probeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const processingRef = useRef(false);
  const mountedRef = useRef(false);
  const nextIdRef = useRef(1);

  const update = useCallback((fn: (prev: readonly BatchEntry[]) => readonly BatchEntry[]) => {
    entriesRef.current = fn(entriesRef.current);
    if (mountedRef.current) setEntries(entriesRef.current);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<BatchEntry>) => {
      update((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
    },
    [update],
  );

  const exists = useCallback((id: string) => entriesRef.current.some((entry) => entry.id === id), []);

  const revokeUrl = useCallback((id: string) => {
    const url = urlsRef.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urlsRef.current.delete(id);
    }
  }, []);

  const abortEntry = useCallback((id: string) => {
    const controller = controllersRef.current.get(id);
    if (controller) {
      controllersRef.current.delete(id);
      controller.abort();
    }
  }, []);

  const releaseAll = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    let processor: ImageProcessor | null = null;
    if (!hasRequiredApis()) {
      setSupport({ status: 'unsupported', reason: 'apis' });
    } else {
      processor = createImageProcessor();
      processorRef.current = processor;
      processor
        .getEncodeSupport()
        .then((encode) => {
          if (!active) return;
          const any = Object.values(encode).some(Boolean);
          setSupport(any ? { status: 'ready', encode } : { status: 'unsupported', reason: 'encoder' });
        })
        .catch(() => {
          if (active) setSupport({ status: 'unsupported', reason: 'encoder' });
        });
    }
    return () => {
      active = false;
      mountedRef.current = false;
      releaseAll();
      processor?.dispose();
      processorRef.current = null;
    };
  }, [releaseAll]);

  const addFiles = useCallback(
    (input: FileList | readonly File[]): AddFilesOutcome => {
      const files = Array.from(input);
      const capacity = Math.max(0, LIMITS.maxFiles - entriesRef.current.length);
      const accepted = files.slice(0, capacity);
      const rejected = files.slice(capacity);
      const created: BatchEntry[] = accepted.map((file) => ({
        id: `datei-${nextIdRef.current++}`,
        file,
        name: file.name,
        size: file.size,
        status: 'checking',
      }));
      if (created.length > 0) update((prev) => [...prev, ...created]);

      // Nacheinander prüfen: begrenzt den Speicherbedarf, falls ein Header das Lesen der ganzen Datei erfordert.
      const checked = new Promise<{ ready: number; invalid: number }>((resolve) => {
        probeChainRef.current = probeChainRef.current.then(async () => {
          let ready = 0;
          let invalid = 0;
          for (const entry of created) {
            if (!mountedRef.current) break;
            if (!exists(entry.id)) continue;
            try {
              const probe = await probeImage(entry.file);
              const decode = await processorRef.current?.getDecodeSupport();
              if (decode && !decode[probe.format]) throw new ImageProcessingError('decode-unsupported', 'Input decoding unavailable');
              if (!exists(entry.id)) continue;
              patch(entry.id, { status: 'ready', probe });
              ready++;
            } catch (error) {
              if (!exists(entry.id)) continue;
              patch(entry.id, { status: 'invalid', error: errorCodeOf(error) });
              invalid++;
            }
          }
          resolve({ ready, invalid });
        });
      });

      return { added: created.length, rejected, checked };
    },
    [exists, patch, update],
  );

  const remove = useCallback(
    (id: string) => {
      abortEntry(id);
      revokeUrl(id);
      update((prev) => prev.filter((entry) => entry.id !== id));
    },
    [abortEntry, revokeUrl, update],
  );

  const reset = useCallback(() => {
    releaseAll();
    update(() => []);
    setRunIds(null);
  }, [releaseAll, update]);

  const processAll = useCallback(
    async (options: ProcessOptions, suffix: SuffixInput = ''): Promise<RunSummary> => {
      const processor = processorRef.current;
      const targets = entriesRef.current.filter(isProcessable);
      if (!processor || processingRef.current || targets.length === 0) return { total: 0, done: 0, failed: 0 };

      processingRef.current = true;
      setIsProcessing(true);
      setRunIds(targets.map((entry) => entry.id));

      // Vorherige Ergebnisse freigeben, bevor neue entstehen.
      for (const entry of targets) revokeUrl(entry.id);
      const names = makeUniqueFileNames(
        targets.map((entry) =>
          buildOutputFileName(entry.name, options.format, typeof suffix === 'function' ? suffix(entry, options) : suffix),
        ),
      );
      const targetIds = new Set(targets.map((entry) => entry.id));
      update((prev) =>
        prev.map((entry) =>
          targetIds.has(entry.id)
            ? { ...entry, status: 'queued', result: undefined, resultUrl: undefined, outputName: undefined, error: undefined }
            : entry,
        ),
      );

      let done = 0;
      let failed = 0;
      await Promise.all(
        targets.map(async (entry, index) => {
          const controller = new AbortController();
          controllersRef.current.set(entry.id, controller);
          try {
            const result = await processor.process(entry.file, options, {
              signal: controller.signal,
              onStart: () => {
                if (!controller.signal.aborted && exists(entry.id)) patch(entry.id, { status: 'processing' });
              },
            });
            if (controller.signal.aborted || !exists(entry.id) || !mountedRef.current) return;
            const url = URL.createObjectURL(result.blob);
            urlsRef.current.set(entry.id, url);
            patch(entry.id, { status: 'done', result, resultUrl: url, outputName: names[index] });
            done++;
          } catch (error) {
            if (controller.signal.aborted || !exists(entry.id)) return;
            patch(entry.id, { status: 'error', error: errorCodeOf(error) });
            failed++;
          } finally {
            if (controllersRef.current.get(entry.id) === controller) controllersRef.current.delete(entry.id);
          }
        }),
      );

      processingRef.current = false;
      if (mountedRef.current) setIsProcessing(false);
      return { total: targets.length, done, failed };
    },
    [exists, patch, revokeUrl, update],
  );

  const counts = useMemo<BatchCounts>(() => {
    let checking = 0;
    let invalid = 0;
    let processable = 0;
    let done = 0;
    let failed = 0;
    for (const entry of entries) {
      if (entry.status === 'checking') checking++;
      if (entry.status === 'invalid') invalid++;
      if (isProcessable(entry)) processable++;
      if (entry.status === 'done') done++;
      if (entry.status === 'error') failed++;
    }
    return { total: entries.length, checking, invalid, processable, done, failed };
  }, [entries]);

  /** Fortschritt des aktuellen bzw. letzten Durchlaufs (entfernte Einträge zählen nicht mehr). */
  const progress = useMemo<RunProgress | null>(() => {
    if (!runIds) return null;
    const ids = new Set(runIds);
    let total = 0;
    let done = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!ids.has(entry.id)) continue;
      total++;
      if (entry.status === 'done') done++;
      if (entry.status === 'error') failed++;
    }
    return total === 0 ? null : { total, done, failed, finished: done + failed };
  }, [entries, runIds]);

  return { entries, support, isProcessing, counts, progress, addFiles, remove, reset, processAll };
}

export type ImageBatch = ReturnType<typeof useImageBatch>;
