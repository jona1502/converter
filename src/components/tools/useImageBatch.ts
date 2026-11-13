/**
 * Stapelverwaltung für die Bildwerkzeuge: Dateiliste, Vorabprüfung, Verarbeitung über einen
 * Serverclient, begrenzte Auftragsparallelität, Abbruch und Löschanforderungen.
 *
 * Dateien werden erst mit processAll hochgeladen. Keine Speicherung in Web Storage,
 * IndexedDB oder Cache und keine Konsolenausgaben.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LIMITS, buildOutputFileName, makeUniqueFileNames, type EncodeSupport, type ImageErrorCode, type ProbeResult, type ProcessOptions, type ProcessResult } from '../../lib/image';
import {probeServerImage} from '../../lib/api/probe';
import { errorCodeOf } from './errorMessages';
import { ApiError, apiMessage, capabilities, createJob, deleteJob, pollJob, type Tool } from '../../lib/api/client';

export type EntryStatus = 'checking' | 'ready' | 'invalid' | 'uploading' | 'queued' | 'processing' | 'done' | 'error';

export interface BatchEntry {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly size: number;
  readonly status: EntryStatus;
  readonly probe?: ProbeResult;
  readonly result?: Omit<ProcessResult, 'blob'> & {readonly size: number};
  /** Autorisierter Same-Origin-Download; wird nach Ablauf entfernt. */
  readonly resultUrl?: string;
  readonly outputName?: string;
  /** Fehler der Prüfung (status 'invalid') oder der Verarbeitung (status 'error'). */
  readonly error?: ImageErrorCode;
  readonly serverError?: string;
  readonly jobId?: string;
  readonly expiresAt?: string;
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

export function isProcessable(entry: { readonly status: EntryStatus }): boolean {
  return PROCESSABLE.has(entry.status);
}

/** Prüft, ob der Browser die für die Verarbeitung nötigen APIs bereitstellt. */
export function useImageBatch(tool: Tool = 'image-convert') {
  const [entries, setEntries] = useState<readonly BatchEntry[]>([]);
  const [support, setSupport] = useState<SupportState>({ status: 'checking' });
  const [limits,setLimits] = useState<{maxFiles:number;maxFileBytes:number;maxPixels:number;maxEdge:number}>({...LIMITS});
  const [isProcessing, setIsProcessing] = useState(false);
  const [runIds, setRunIds] = useState<readonly string[] | null>(null);
  const entriesRef = useRef<readonly BatchEntry[]>([]);
  const controllersRef = useRef(new Map<string, AbortController>());
  const jobsRef = useRef(new Map<string, string>());
  const keysRef=useRef(new Map<string,{options:string;key:string}>());
  const probeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const processingRef = useRef(false);
  const mountedRef = useRef(false);
  const nextIdRef = useRef(1);
  const concurrencyRef = useRef(2);
  const update = useCallback((fn: (prev: readonly BatchEntry[]) => readonly BatchEntry[]) => {
    entriesRef.current = fn(entriesRef.current);
    if (mountedRef.current) setEntries(entriesRef.current);
  }, []);
  const patch = useCallback((id: string, changes: Partial<BatchEntry>) => {
    update(prev => prev.map(entry => entry.id === id ? {...entry, ...changes} : entry));
  }, [update]);
  const exists = useCallback((id: string) => entriesRef.current.some(entry => entry.id === id), []);
  const discardJob = useCallback((id: string) => {
    const job = jobsRef.current.get(id);
    if (job) { jobsRef.current.delete(id); void deleteJob(job).catch(() => {}); }
  }, []);
  const abortEntry = useCallback((id: string) => {
    keysRef.current.delete(id);
    controllersRef.current.get(id)?.abort(); controllersRef.current.delete(id); discardJob(id);
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
    capabilities(controller.signal).then(value => {
      if (!mountedRef.current) return;
      const encode = Object.fromEntries(['jpeg','png','webp','bmp','ico'].map(format => [format,value.image.outputFormats.includes(format)])) as unknown as EncodeSupport;
      concurrencyRef.current = Math.max(1, Math.min(2, value.jobs.maxActivePerSession));
      setLimits({maxFiles:value.jobs.maxBatchFiles,maxFileBytes:value.image.maxFileBytes,maxPixels:value.image.maxPixels,maxEdge:value.image.maxEdge});
      setSupport({status: 'ready', encode});
    }).catch(() => { if (!controller.signal.aborted) setSupport({status: 'unsupported', reason: 'encoder'}); });
    return () => { controller.abort(); mountedRef.current = false; releaseAll(); };
  }, [releaseAll]);
  useEffect(() => {
    const expiry=entries.filter(entry=>entry.status==='done'&&entry.expiresAt).map(entry=>Date.parse(entry.expiresAt!));
    if(!expiry.length)return;
    const timer=setTimeout(()=>update(previous=>previous.map(entry=>entry.status==='done'&&entry.expiresAt&&Date.parse(entry.expiresAt)<=Date.now()
      ? {...entry,status:'error',resultUrl:undefined,serverError:'Der Auftrag ist abgelaufen. Bitte verarbeiten Sie die Datei erneut.'}:entry)),Math.max(0,Math.min(...expiry)-Date.now()));
    return ()=>clearTimeout(timer);
  },[entries,update]);

  const addFiles = useCallback(
    (input: FileList | readonly File[]): AddFilesOutcome => {
      const files = Array.from(input);
      const capacity = Math.max(0, limits.maxFiles - entriesRef.current.length);
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
              const probe = await probeServerImage(entry.file,limits);
              if(entry.file.size>limits.maxFileBytes || probe.width>limits.maxEdge || probe.height>limits.maxEdge || probe.width*probe.height>limits.maxPixels) {
                patch(entry.id,{status:'invalid',serverError:'Die Datei überschreitet die vom Server erlaubte Größe oder Bildabmessung.'});invalid++;continue;
              }
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
    [exists, patch, update, limits],
  );

  const remove = useCallback(
    (id: string) => {
      abortEntry(id);
      update((prev) => prev.filter((entry) => entry.id !== id));
    },
    [abortEntry, update],
  );

  const reset = useCallback(() => {
    releaseAll();
    update(() => []);
    setRunIds(null);
  }, [releaseAll, update]);

  const processAll = useCallback(
    async (options: ProcessOptions | ((entry: BatchEntry) => ProcessOptions), suffix: SuffixInput = '', include: (entry: BatchEntry) => boolean = () => true): Promise<RunSummary> => {
      const targets = entriesRef.current.filter(entry => isProcessable(entry) && include(entry));
      if (support.status !== 'ready' || processingRef.current || !targets.length) return {total: 0, done: 0, failed: 0};
      const resolved = targets.map(entry => typeof options === 'function' ? options(entry) : options);
      const names=makeUniqueFileNames(targets.map((entry,index)=>buildOutputFileName(entry.name,resolved[index]!.format,typeof suffix==='function'?suffix(entry,resolved[index]!):suffix)));
      processingRef.current = true; setIsProcessing(true); setRunIds(targets.map(entry => entry.id));
      for (const entry of targets) discardJob(entry.id);
      const ids = new Set(targets.map(entry => entry.id));
      update(prev => prev.map(entry => ids.has(entry.id) ? {...entry,status: 'queued',result: undefined,resultUrl: undefined,serverError: undefined,error: undefined} : entry));
      const queue = targets.map((entry,index) => ({entry,index}));
      let done = 0, failed = 0;
      const run = async () => {
        while (queue.length && mountedRef.current) {
          const {entry,index} = queue.shift()!;
          if (!exists(entry.id)) continue;
          const controller = new AbortController(); controllersRef.current.set(entry.id,controller);
          try {
            patch(entry.id,{status: 'uploading'});
            const value = resolved[index]!;
            const {icoSizes, ...base} = value;
            const serverOptions={...base,tool,...(value.format === 'ico' ? {icoSizes} : {})};
            const serialized=JSON.stringify(serverOptions);
            const previous=keysRef.current.get(entry.id);
            const key=previous?.options===serialized?previous.key:crypto.randomUUID();
            keysRef.current.set(entry.id,{options:serialized,key});
            const job = await createJob(entry.file,serverOptions,key,controller.signal,waiting=>{
              if(!controller.signal.aborted&&exists(entry.id))patch(entry.id,{status:waiting?'queued':'uploading'});
            });
            keysRef.current.delete(entry.id);
            if (controller.signal.aborted || !exists(entry.id)) { void deleteJob(job.id).catch(() => {}); continue; }
            jobsRef.current.set(entry.id,job.id);
            const finished = await pollJob(job,controller.signal,status => {
              if (exists(entry.id) && !controller.signal.aborted) patch(entry.id,{status: status.state === 'queued' ? 'queued' : 'processing',jobId: job.id,expiresAt:status.expiresAt});
            });
            if (controller.signal.aborted || !exists(entry.id)) continue;
            const result = finished.results[0];
            if (finished.state !== 'succeeded' || !result?.downloadUrl || result.size === null) throw new ApiError(finished.error?.code ?? result?.error?.code ?? finished.state);
            const details = result.details ?? {};
            const number = (key: string, fallback = 0) => typeof details[key] === 'number' ? details[key] as number : fallback;
            const metadata = {
              format: value.format, mime: result.mime, size: result.size,
              sourceWidth: number('sourceWidth',entry.probe?.width), sourceHeight: number('sourceHeight',entry.probe?.height),
              width: number('width'), height: number('height'),
              upscaled: details.upscaled === true, transparencyFlattened: details.transparencyFlattened === true,
            };
            patch(entry.id,{status: 'done',result: metadata,resultUrl: result.downloadUrl,outputName: names[index]}); done++;
          } catch (error) {
            if (controller.signal.aborted || !exists(entry.id)) continue;
            patch(entry.id,{status: 'error',serverError: apiMessage(error)}); failed++;
          } finally { controllersRef.current.delete(entry.id); }
        }
      };
      try { await Promise.all(Array.from({length: concurrencyRef.current},run)); }
      finally { processingRef.current = false; if (mountedRef.current) setIsProcessing(false); }
      return {total: targets.length,done,failed};
    }, [discardJob, exists, patch, support, tool, update],
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

  return { entries, support, limits, isProcessing, counts, progress, addFiles, remove, reset, processAll };
}

export type ImageBatch = ReturnType<typeof useImageBatch>;
