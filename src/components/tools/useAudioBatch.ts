/**
 * Stapelverwaltung für „Audio konvertieren“: Dateiliste, Vorprüfung ohne Dekodierung, Verarbeitung
 * über den Server mit begrenzter Parallelität, Abbruch und Löschanforderungen.
 *
 * Bewusst getrennt von useImageBatch (Bildprobe, Bildmetadaten); Ablauf, Zustände und
 * Idempotenzregeln sind dieselben. Dateien werden erst mit processAll hochgeladen. Keine
 * Speicherung in Web Storage, IndexedDB oder Cache und keine Konsolenausgaben.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, capabilities, createJob, deleteJob, pollJob } from '../../lib/api/client';
import { checkAudioFile } from '../../lib/audio/check';
import { AUDIO_FORMATS, AUDIO_FORMAT_INFO, isAudioFormat, type AudioFormat } from '../../lib/audio/formats';
import { DEFAULT_AUDIO_QUALITY, DEFAULT_QUALITY_FORMATS, buildAudioOptions, type AudioSettings } from '../../lib/audio/options';
import { buildFileName, makeUniqueFileNames } from '../../lib/image/filename';
import { LIMITS } from '../../lib/image/limits';
import { audioErrorMessage, audioServerMessage } from './errorMessages';
import type { FileEntry } from './FileList';
import { isProcessable, type AddFilesOutcome, type BatchCounts, type RunProgress, type RunSummary } from './useImageBatch';

export interface AudioResult {
  readonly format: AudioFormat;
  readonly size: number;
  readonly mime: string;
  readonly durationSeconds?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly qualityApplied: boolean;
}

export interface AudioEntry extends FileEntry {
  readonly file: File;
  /** Laut Signatur (Vorprüfung) bzw. laut Server erkanntes Eingabeformat. */
  readonly inputFormat?: AudioFormat;
  readonly result?: AudioResult;
  readonly jobId?: string;
}

export interface AudioLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxDurationSeconds: number;
  readonly maxChannels: number;
  readonly maxSampleRate: number;
  readonly maxOutputBytes: number;
  readonly outputFormats: readonly AudioFormat[];
  readonly qualityFormats: readonly AudioFormat[];
  /** Standardqualität 0–1. */
  readonly defaultQuality: number;
}

/** Startwerte laut Vertrag, bis der Server seine Fähigkeiten meldet. */
export const DEFAULT_AUDIO_LIMITS: AudioLimits = {
  maxFiles: LIMITS.maxFiles,
  maxFileBytes: 104_857_600,
  maxDurationSeconds: 1800,
  maxChannels: 8,
  maxSampleRate: 192_000,
  maxOutputBytes: 419_430_400,
  outputFormats: AUDIO_FORMATS,
  qualityFormats: DEFAULT_QUALITY_FORMATS,
  defaultQuality: DEFAULT_AUDIO_QUALITY,
};

export type AudioSupportState =
  | { readonly status: 'checking' }
  | { readonly status: 'ready' }
  /** apis: Server nicht erreichbar; encoder: Server bietet audio-convert nicht an. */
  | { readonly status: 'unsupported'; readonly reason: 'apis' | 'encoder' };

const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function useAudioBatch() {
  const [entries, setEntries] = useState<readonly AudioEntry[]>([]);
  const [support, setSupport] = useState<AudioSupportState>({ status: 'checking' });
  const [limits, setLimits] = useState<AudioLimits>(DEFAULT_AUDIO_LIMITS);
  const [isProcessing, setIsProcessing] = useState(false);
  const [runIds, setRunIds] = useState<readonly string[] | null>(null);
  const entriesRef = useRef<readonly AudioEntry[]>([]);
  const limitsRef = useRef<AudioLimits>(DEFAULT_AUDIO_LIMITS);
  const controllersRef = useRef(new Map<string, AbortController>());
  const jobsRef = useRef(new Map<string, string>());
  const keysRef = useRef(new Map<string, { options: string; key: string }>());
  const checkChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const processingRef = useRef(false);
  const mountedRef = useRef(false);
  const nextIdRef = useRef(1);
  const concurrencyRef = useRef(2);

  const update = useCallback((fn: (prev: readonly AudioEntry[]) => readonly AudioEntry[]) => {
    entriesRef.current = fn(entriesRef.current);
    if (mountedRef.current) setEntries(entriesRef.current);
  }, []);
  const patch = useCallback((id: string, changes: Partial<AudioEntry>) => {
    update((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry)));
  }, [update]);
  const exists = useCallback((id: string) => entriesRef.current.some((entry) => entry.id === id), []);
  const discardJob = useCallback((id: string) => {
    const job = jobsRef.current.get(id);
    if (job) { jobsRef.current.delete(id); void deleteJob(job).catch(() => {}); }
  }, []);
  const abortEntry = useCallback((id: string) => {
    keysRef.current.delete(id);
    controllersRef.current.get(id)?.abort();
    controllersRef.current.delete(id);
    discardJob(id);
  }, [discardJob]);
  const releaseAll = useCallback(() => {
    keysRef.current.clear();
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    for (const id of [...jobsRef.current.keys()]) discardJob(id);
  }, [discardJob]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    capabilities(controller.signal).then((value) => {
      if (!mountedRef.current) return;
      const audio = value.audio;
      const outputFormats = (audio?.outputFormats ?? []).filter(isAudioFormat);
      if (!audio || (value.tools && !value.tools.includes('audio-convert')) || outputFormats.length === 0) {
        setSupport({ status: 'unsupported', reason: 'encoder' });
        return;
      }
      concurrencyRef.current = Math.max(1, Math.min(2, value.jobs.maxActivePerSession));
      const next: AudioLimits = {
        maxFiles: value.jobs.maxBatchFiles,
        maxFileBytes: audio.maxFileBytes,
        maxDurationSeconds: audio.maxDurationSeconds,
        maxChannels: audio.maxChannels,
        maxSampleRate: audio.maxSampleRate,
        maxOutputBytes: audio.maxOutputBytes,
        outputFormats: AUDIO_FORMATS.filter((format) => outputFormats.includes(format)),
        qualityFormats: audio.qualityFormats.filter(isAudioFormat),
        defaultQuality: audio.defaultQuality,
      };
      limitsRef.current = next;
      setLimits(next);
      setSupport({ status: 'ready' });
    }).catch(() => { if (!controller.signal.aborted) setSupport({ status: 'unsupported', reason: 'apis' }); });
    return () => { controller.abort(); mountedRef.current = false; releaseAll(); };
  }, [releaseAll]);

  // Abgelaufene Ergebnisse verlieren ihren Download.
  useEffect(() => {
    const expiry = entries.filter((entry) => entry.status === 'done' && entry.expiresAt).map((entry) => Date.parse(entry.expiresAt!));
    if (!expiry.length) return;
    const timer = setTimeout(() => update((previous) => previous.map((entry) =>
      entry.status === 'done' && entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()
        ? { ...entry, status: 'error', resultUrl: undefined, serverError: 'Der Auftrag ist abgelaufen. Bitte verarbeiten Sie die Datei erneut.' }
        : entry)), Math.max(0, Math.min(...expiry) - Date.now()));
    return () => clearTimeout(timer);
  }, [entries, update]);

  const addFiles = useCallback((input: FileList | readonly File[]): AddFilesOutcome => {
    const files = Array.from(input);
    const current = limitsRef.current;
    const capacity = Math.max(0, current.maxFiles - entriesRef.current.length);
    const accepted = files.slice(0, capacity);
    const rejected = files.slice(capacity);
    const created: AudioEntry[] = accepted.map((file) => ({
      id: `audio-${nextIdRef.current++}`, file, name: file.name, size: file.size, status: 'checking',
    }));
    if (created.length > 0) update((prev) => [...prev, ...created]);

    // Nacheinander prüfen; gelesen werden nur die ersten Bytes jeder Datei.
    const checked = new Promise<{ ready: number; invalid: number }>((resolve) => {
      checkChainRef.current = checkChainRef.current.then(async () => {
        let ready = 0;
        let invalid = 0;
        for (const entry of created) {
          if (!mountedRef.current) break;
          if (!exists(entry.id)) continue;
          try {
            const outcome = await checkAudioFile(entry.file, current.maxFileBytes);
            if (!exists(entry.id)) continue;
            if (outcome.ok) { patch(entry.id, { status: 'ready', inputFormat: outcome.format }); ready++; }
            else { patch(entry.id, { status: 'invalid', serverError: audioErrorMessage(outcome.code, current) ?? undefined }); invalid++; }
          } catch {
            if (!exists(entry.id)) continue;
            patch(entry.id, { status: 'invalid', serverError: 'Die Datei konnte nicht gelesen werden.' });
            invalid++;
          }
        }
        resolve({ ready, invalid });
      });
    });
    return { added: created.length, rejected, checked };
  }, [exists, patch, update]);

  const remove = useCallback((id: string) => {
    abortEntry(id);
    update((prev) => prev.filter((entry) => entry.id !== id));
  }, [abortEntry, update]);

  const reset = useCallback(() => {
    releaseAll();
    update(() => []);
    setRunIds(null);
  }, [releaseAll, update]);

  /** Verarbeitet alle verarbeitbaren Einträge; „-konvertiert“ nur, wenn das Format gleich bleibt. */
  const processAll = useCallback(async (settings: AudioSettings | ((entry: AudioEntry) => AudioSettings), include: (entry: AudioEntry) => boolean = () => true): Promise<RunSummary> => {
    const targets = entriesRef.current.filter(entry => isProcessable(entry) && include(entry));
    if (support.status !== 'ready' || processingRef.current || !targets.length) return { total: 0, done: 0, failed: 0 };
    const current = limitsRef.current;
    const resolved = targets.map(entry => typeof settings === 'function' ? settings(entry) : settings);
    const names = makeUniqueFileNames(targets.map((entry, index) => {
      const selected = resolved[index]!;
      return buildFileName(entry.name, AUDIO_FORMAT_INFO[selected.format].extension, entry.inputFormat === selected.format ? 'konvertiert' : '', 'audio');
    }));
    processingRef.current = true;
    setIsProcessing(true);
    setRunIds(targets.map((entry) => entry.id));
    for (const entry of targets) discardJob(entry.id);
    const ids = new Set(targets.map((entry) => entry.id));
    update((prev) => prev.map((entry) => ids.has(entry.id)
      ? { ...entry, status: 'queued', result: undefined, resultUrl: undefined, serverError: undefined, error: undefined }
      : entry));
    const queue = targets.map((entry, index) => ({ entry, index }));
    let done = 0;
    let failed = 0;
    const run = async () => {
      while (queue.length && mountedRef.current) {
        const { entry, index } = queue.shift()!;
        if (!exists(entry.id)) continue;
        const controller = new AbortController();
        controllersRef.current.set(entry.id, controller);
        try {
          const selected = resolved[index]!;
          const serverOptions = buildAudioOptions(selected, current.qualityFormats);
          const serialized = JSON.stringify(serverOptions);
          patch(entry.id, { status: 'uploading' });
          const previous = keysRef.current.get(entry.id);
          const key = previous?.options === serialized ? previous.key : crypto.randomUUID();
          keysRef.current.set(entry.id, { options: serialized, key });
          const job = await createJob(entry.file, serverOptions, key, controller.signal, (waiting) => {
            if (!controller.signal.aborted && exists(entry.id)) patch(entry.id, { status: waiting ? 'queued' : 'uploading' });
          });
          keysRef.current.delete(entry.id);
          if (controller.signal.aborted || !exists(entry.id)) { void deleteJob(job.id).catch(() => {}); continue; }
          jobsRef.current.set(entry.id, job.id);
          const finished = await pollJob(job, controller.signal, (status) => {
            if (exists(entry.id) && !controller.signal.aborted) {
              patch(entry.id, { status: status.state === 'queued' ? 'queued' : 'processing', jobId: job.id, expiresAt: status.expiresAt });
            }
          });
          if (controller.signal.aborted || !exists(entry.id)) continue;
          const result = finished.results[0];
          if (finished.state !== 'succeeded' || !result?.downloadUrl || result.size === null) {
            throw new ApiError(finished.error?.code ?? result?.error?.code ?? finished.state);
          }
          const details = result.details ?? {};
          const serverInput = finished.input?.format;
          patch(entry.id, {
            status: 'done',
            inputFormat: isAudioFormat(serverInput) ? serverInput : entry.inputFormat,
            result: {
              format: isAudioFormat(details.format) ? details.format : selected.format,
              size: result.size,
              mime: result.mime,
              durationSeconds: number(details.durationSeconds),
              sampleRate: number(details.sampleRate),
              channels: number(details.channels),
              qualityApplied: details.qualityApplied === true,
            },
            resultUrl: result.downloadUrl,
            outputName: names[index],
          });
          done++;
        } catch (error) {
          if (controller.signal.aborted || !exists(entry.id)) continue;
          patch(entry.id, { status: 'error', serverError: audioServerMessage(error, current) });
          failed++;
        } finally {
          controllersRef.current.delete(entry.id);
        }
      }
    };
    try { await Promise.all(Array.from({ length: concurrencyRef.current }, run)); }
    finally { processingRef.current = false; if (mountedRef.current) setIsProcessing(false); }
    return { total: targets.length, done, failed };
  }, [discardJob, exists, patch, support, update]);

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

  return { entries, support, limits, isProcessing, counts, progress, addFiles, remove, reset, processAll };
}

export type AudioBatch = ReturnType<typeof useAudioBatch>;
