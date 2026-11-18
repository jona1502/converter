/**
 * Bild zu PDF: geordnete Bildliste mit lokaler Vorprüfung, genau ein Auftrag je PDF.
 *
 * Bilder bleiben im Browser, bis process() ausdrücklich aufgerufen wird. Dann wird ein ZIP-Bündel
 * in der gewählten Reihenfolge gebaut und als ein Auftrag hochgeladen; Ergebnis ist eine PDF mit
 * einer Seite je Bild. Änderungen an Liste oder Reihenfolge verwerfen ein vorhandenes Ergebnis.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, capabilities, createJob, deleteJob, pollJob } from '../../lib/api/client';
import { jobProgress, type JobProgress } from '../../lib/api/progress';
import {
  buildImageBundle,
  buildImagePdfOptions,
  checkImageForPdf,
  IMAGE_PDF_LIMITS,
  imagePdfCodeMessage,
  imagePdfMessage,
  imagePdfSelectionProblem,
  moveItem,
  type ImagePdfLimits,
  type ImagePdfSettings,
} from '../../lib/imagepdf';
import type { InputFormat } from '../../lib/image';
import type { BatchCounts, RunProgress } from './useImageBatch';

export interface ImagePdfItem {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly size: number;
  readonly status: 'checking' | 'ready' | 'invalid';
  readonly format?: InputFormat;
  readonly width?: number;
  readonly height?: number;
  /** Deutscher Text, warum das Bild nicht verwendbar ist. */
  readonly error?: string;
}

export interface ImagePdfJob {
  readonly status: 'idle' | 'uploading' | 'queued' | 'processing' | 'done' | 'error';
  readonly result?: { size: number; pageCount: number; settings: ImagePdfSettings };
  readonly resultUrl?: string;
  readonly outputName?: string;
  readonly expiresAt?: string;
  readonly jobProgress?: JobProgress;
  readonly error?: string;
}

type Support = { status: 'checking' | 'ready' } | { status: 'unsupported'; reason: 'apis' | 'encoder' };

const IDLE: ImagePdfJob = { status: 'idle' };
const ACTIVE: ReadonlySet<ImagePdfJob['status']> = new Set(['uploading', 'queued', 'processing']);

export function useImagePdfBatch() {
  const [items, setItems] = useState<readonly ImagePdfItem[]>([]);
  const [job, setJob] = useState<ImagePdfJob>(IDLE);
  const [support, setSupport] = useState<Support>({ status: 'checking' });
  const [limits, setLimits] = useState<ImagePdfLimits>(IMAGE_PDF_LIMITS);
  const itemsRef = useRef<readonly ImagePdfItem[]>([]);
  const jobRef = useRef<ImagePdfJob>(IDLE);
  const limitsRef = useRef<ImagePdfLimits>(IMAGE_PDF_LIMITS);
  const mounted = useRef(false);
  const nextId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const running = useRef(false);
  const generation = useRef(0);
  const checkChain = useRef<Promise<unknown>>(Promise.resolve());

  const updateItems = useCallback((value: readonly ImagePdfItem[]) => {
    itemsRef.current = value;
    if (mounted.current) setItems(value);
  }, []);
  const updateJob = useCallback((value: ImagePdfJob) => {
    jobRef.current = value;
    if (mounted.current) setJob(value);
  }, []);
  const patchItem = useCallback((id: string, changes: Partial<ImagePdfItem>) => {
    if (itemsRef.current.some((item) => item.id === id)) {
      updateItems(itemsRef.current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    }
  }, [updateItems]);
  const discardJob = useCallback(() => {
    if (jobId.current) { void deleteJob(jobId.current).catch(() => {}); jobId.current = null; }
  }, []);
  /** Bricht einen laufenden Auftrag ab und verwirft Ergebnis und Wiederholungsschlüssel. */
  const dropJob = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    discardJob();
    attempt.current = null;
    running.current = false;
    if (jobRef.current.status !== 'idle') updateJob(IDLE);
  }, [discardJob, updateJob]);

  useEffect(() => {
    mounted.current = true;
    const check = new AbortController();
    capabilities(check.signal).then((value) => {
      if (check.signal.aborted) return;
      const imagePdf = value.imagePdf;
      if (!imagePdf?.available || !value.tools?.includes('image-pdf')) {
        setSupport({ status: 'unsupported', reason: 'encoder' });
        return;
      }
      const next: ImagePdfLimits = {
        maxImages: imagePdf.maxImages,
        maxImageBytes: imagePdf.maxImageBytes,
        maxTotalBytes: imagePdf.maxTotalBytes,
        maxOutputBytes: imagePdf.maxOutputBytes,
        maxPixels: value.image.maxPixels,
        maxEdge: value.image.maxEdge,
      };
      limitsRef.current = next;
      setLimits(next);
      setSupport({ status: 'ready' });
    }).catch(() => { if (!check.signal.aborted) setSupport({ status: 'unsupported', reason: 'apis' }); });
    return () => { check.abort(); mounted.current = false; dropJob(); };
  }, [dropJob]);

  // Abgelaufene Ergebnisse nicht mehr zum Download anbieten.
  useEffect(() => {
    if (job.status !== 'done' || !job.expiresAt) return;
    const timer = setTimeout(() => updateJob({ status: 'error', error: 'Der Auftrag ist abgelaufen. Bitte erstellen Sie die PDF erneut.' }),
      Math.max(0, Date.parse(job.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [job, updateJob]);

  /** Fügt Bilder am Ende an; was die Obergrenze übersteigt, wird nicht übernommen (nicht still gekürzt). */
  const addFiles = useCallback((files: readonly File[]): { added: number; rejected: number } => {
    if (support.status !== 'ready' || !files.length) return { added: 0, rejected: files.length };
    const capacity = Math.max(0, limitsRef.current.maxImages - itemsRef.current.length);
    const accepted = files.slice(0, capacity);
    if (!accepted.length) return { added: 0, rejected: files.length };
    dropJob();
    const created: ImagePdfItem[] = accepted.map((file) => ({
      id: `bild-${++nextId.current}`, file, name: file.name, size: file.size, status: 'checking',
    }));
    updateItems([...itemsRef.current, ...created]);
    // Nacheinander prüfen: begrenzt den Speicherbedarf bei Headern, die die ganze Datei brauchen.
    checkChain.current = checkChain.current.then(async () => {
      for (const item of created) {
        if (!mounted.current || !itemsRef.current.some((entry) => entry.id === item.id)) continue;
        const result = await checkImageForPdf(item.file, limitsRef.current);
        patchItem(item.id, result.ok
          ? { status: 'ready', format: result.format, width: result.width, height: result.height }
          : { status: 'invalid', error: imagePdfCodeMessage(result.code, limitsRef.current) ?? 'Das Bild ist nicht verwendbar.' });
      }
    });
    return { added: accepted.length, rejected: files.length - accepted.length };
  }, [dropJob, patchItem, support.status, updateItems]);

  const remove = useCallback((id: string) => {
    if (!itemsRef.current.some((item) => item.id === id)) return;
    dropJob();
    updateItems(itemsRef.current.filter((item) => item.id !== id));
  }, [dropJob, updateItems]);

  const move = useCallback((id: string, delta: number) => {
    const index = itemsRef.current.findIndex((item) => item.id === id);
    const next = moveItem(itemsRef.current, index, delta);
    if (next === itemsRef.current) return;
    dropJob();
    updateItems(next);
  }, [dropJob, updateItems]);

  const reset = useCallback(() => {
    dropJob();
    updateItems([]);
  }, [dropJob, updateItems]);

  const process = useCallback(async (settings: ImagePdfSettings) => {
    const current = itemsRef.current;
    const status = jobRef.current.status;
    if (running.current || support.status !== 'ready' || ACTIVE.has(status) || !current.length
      || current.some((item) => item.status !== 'ready')
      || imagePdfSelectionProblem(current.map((item) => item.size), limitsRef.current)) return;
    const currentGeneration = ++generation.current;
    const active = () => mounted.current && generation.current === currentGeneration;
    const abort = new AbortController();
    controller.current = abort;
    running.current = true;
    discardJob();
    updateJob({ status: 'uploading' });
    try {
      const options = buildImagePdfOptions(settings);
      const signature = JSON.stringify([options, current.map((item) => [item.id, item.size])]);
      if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
      const key = attempt.current.key;
      const bundle = await buildImageBundle(current.map((item) => ({ file: item.file, format: item.format! })));
      if (!active()) return;
      const created = await createJob(bundle, options, key, abort.signal, (waiting) => {
        if (active()) updateJob({ status: waiting ? 'queued' : 'uploading' });
      });
      if (!active() || abort.signal.aborted) { void deleteJob(created.id).catch(() => {}); return; }
      attempt.current = null;
      jobId.current = created.id;
      const finished = await pollJob(created, abort.signal, (state) => {
        if (active()) updateJob({ status: state.state === 'queued' ? 'queued' : 'processing', expiresAt: state.expiresAt, jobProgress: jobProgress(state) });
      });
      if (!active() || abort.signal.aborted) return;
      const result = finished.results[0];
      if (finished.state !== 'succeeded' || finished.results.length !== 1 || !result?.downloadUrl || result.size === null) {
        throw new ApiError(finished.error?.code ?? result?.error?.code ?? finished.state);
      }
      const pageCount = result.details?.pageCount;
      if (result.mime !== 'application/pdf' || typeof pageCount !== 'number' || pageCount !== current.length
        || result.size > limitsRef.current.maxOutputBytes) {
        throw new ApiError('encode-failed');
      }
      updateJob({ status: 'done', result: { size: result.size, pageCount, settings }, resultUrl: result.downloadUrl,
        outputName: result.downloadName, expiresAt: finished.expiresAt });
    } catch (error) {
      if (active() && !abort.signal.aborted) updateJob({ status: 'error', error: imagePdfMessage(error, limitsRef.current) });
    } finally {
      if (generation.current === currentGeneration) {
        running.current = false;
        controller.current = null;
      }
    }
  }, [discardJob, support.status, updateJob]);

  const ready = items.filter((item) => item.status === 'ready').length;
  const counts: BatchCounts = {
    total: items.length,
    checking: items.filter((item) => item.status === 'checking').length,
    invalid: items.filter((item) => item.status === 'invalid').length,
    processable: ready,
    done: job.status === 'done' ? 1 : 0,
    failed: job.status === 'error' ? 1 : 0,
  };
  const isProcessing = ACTIVE.has(job.status);
  const progress: RunProgress | null = isProcessing || job.status === 'done' || job.status === 'error'
    ? { total: 1, done: counts.done, failed: counts.failed, finished: counts.done + counts.failed } : null;
  return { items, job, support, limits, counts, progress, isProcessing, selectionProblem: imagePdfSelectionProblem(items.map((item) => item.size), limits),
    addFiles, remove, move, reset, process };
}
