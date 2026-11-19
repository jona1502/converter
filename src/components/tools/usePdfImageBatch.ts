/** Eine PDF: lokale Prüfung, ausdrücklicher Upload, Polling, Seitenbilder oder ZIP und frühere Löschung. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, capabilities, createJob, deleteJob, pollJob } from '../../lib/api/client';
import { jobProgress } from '../../lib/api/progress';
import {
  buildPdfImageOptions,
  checkPdfFile,
  PDF_IMAGE_LIMITS,
  pdfImageMessage,
  resolvePages,
  selectionMessage,
  type PdfImageLimits,
  type PdfImageSettings,
} from '../../lib/pdf-image';
import type { FileEntry } from './FileList';
import type { BatchCounts, RunProgress } from './useImageBatch';

export interface PdfImageResult {
  readonly size: number;
  /** Gerenderte Seiten. */
  readonly pageCount: number;
  /** Seiten des Dokuments. */
  readonly sourcePageCount: number;
  /** true: ZIP mit einem Bild je Seite, sonst ein einzelnes Bild. */
  readonly archive: boolean;
  readonly settings: PdfImageSettings;
}

export interface PdfImageEntry extends FileEntry {
  readonly file: File;
  /** Aus der lokalen Prüfung; fehlt, wenn die PDF im Browser nicht lesbar war. */
  readonly pageCount?: number;
  readonly result?: PdfImageResult;
}
type Support = { status: 'checking' | 'ready' } | { status: 'unsupported'; reason: 'apis' | 'encoder' };

const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'];

export function usePdfImageBatch() {
  const [entry, setEntry] = useState<PdfImageEntry | null>(null);
  const entryRef = useRef<PdfImageEntry | null>(null);
  const [support, setSupport] = useState<Support>({ status: 'checking' });
  const [limits, setLimits] = useState<PdfImageLimits>(PDF_IMAGE_LIMITS);
  const [isProcessing, setIsProcessing] = useState(false);
  const mounted = useRef(false);
  const nextId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
  const key = useRef<string | null>(null);
  const keyFor = useRef('');
  const running = useRef(false);
  const generation = useRef(0);
  const update = useCallback((value: PdfImageEntry | null) => {
    entryRef.current = value;
    if (mounted.current) setEntry(value);
  }, []);
  const patch = useCallback((id: string, changes: Partial<PdfImageEntry>) => {
    if (entryRef.current?.id === id) update({ ...entryRef.current, ...changes });
  }, [update]);
  const discardJob = useCallback(() => {
    if (jobId.current) { void deleteJob(jobId.current).catch(() => {}); jobId.current = null; }
  }, []);
  const reset = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    discardJob();
    key.current = null;
    running.current = false;
    update(null);
    if (mounted.current) setIsProcessing(false);
  }, [discardJob, update]);

  useEffect(() => {
    mounted.current = true;
    const check = new AbortController();
    capabilities(check.signal).then(value => {
      if (check.signal.aborted) return;
      const pdfImage = value.pdfImage;
      if (!pdfImage?.available || !value.tools?.includes('pdf-to-image')) {
        setSupport({ status: 'unsupported', reason: 'encoder' });
        return;
      }
      setLimits({ maxFileBytes: pdfImage.maxFileBytes, maxOutputBytes: pdfImage.maxOutputBytes, maxPages: pdfImage.maxPages,
        maxPixels: pdfImage.maxPixels, minDpi: pdfImage.minDpi, maxDpi: pdfImage.maxDpi, defaultDpi: pdfImage.defaultDpi });
      setSupport({ status: 'ready' });
    }).catch(() => { if (!check.signal.aborted) setSupport({ status: 'unsupported', reason: 'apis' }); });
    return () => { check.abort(); mounted.current = false; reset(); };
  }, [reset]);

  useEffect(() => {
    if (entry?.status !== 'done' || !entry.expiresAt) return;
    const expiry = Date.parse(entry.expiresAt);
    const timer = setTimeout(() => patch(entry.id, { status: 'error', resultUrl: undefined,
      serverError: 'Der Auftrag ist abgelaufen. Bitte erstellen Sie die Bilder erneut.' }), Math.max(0, expiry - Date.now()));
    return () => clearTimeout(timer);
  }, [entry, patch]);

  const addFiles = useCallback((files: File[]): boolean => {
    if (entryRef.current || !files.length || support.status !== 'ready') return false;
    const file = files[0]!;
    const id = `pdf-image-${++nextId.current}`;
    update({ id, file, name: file.name, size: file.size, status: 'checking' });
    void checkPdfFile(file, limits.maxFileBytes).then(result => {
      if (!mounted.current || entryRef.current?.id !== id) return;
      patch(id, result.ok ? { status: 'ready', pageCount: result.pageCount } : { status: 'invalid', serverError: pdfImageMessage(new ApiError(result.code), limits) });
    }).catch(() => patch(id, { status: 'invalid', serverError: 'Die Datei konnte nicht gelesen werden.' }));
    return true;
  }, [limits, patch, support.status, update]);

  const process = useCallback(async (settings: PdfImageSettings) => {
    const target = entryRef.current;
    if (!target || !['ready', 'error', 'done'].includes(target.status) || running.current || support.status !== 'ready') return;
    const pages = resolvePages(settings, target.pageCount, limits.maxPages);
    if (!pages.ok) {
      patch(target.id, { status: 'error', serverError: selectionMessage(pages.reason, target.pageCount, limits.maxPages) });
      return;
    }
    const currentGeneration = generation.current;
    const active = () => mounted.current && generation.current === currentGeneration && entryRef.current?.id === target.id;
    const abort = new AbortController();
    controller.current = abort;
    running.current = true;
    setIsProcessing(true);
    discardJob();
    patch(target.id, { status: 'uploading', serverError: undefined, result: undefined, resultUrl: undefined, expiresAt: undefined });
    try {
      const options = buildPdfImageOptions(settings, target.pageCount);
      // Gleiche Auswahl, gleicher Schlüssel: eine Wiederholung nach Netzfehler erzeugt keinen zweiten Auftrag.
      const signature = JSON.stringify(options);
      if (keyFor.current !== signature) key.current = null;
      keyFor.current = signature;
      key.current ??= crypto.randomUUID();
      const job = await createJob(target.file, options, key.current, abort.signal, waiting => {
        if (active()) patch(target.id, { status: waiting ? 'queued' : 'uploading' });
      });
      if (!active() || abort.signal.aborted) { void deleteJob(job.id).catch(() => {}); return; }
      key.current = null;
      jobId.current = job.id;
      const finished = await pollJob(job, abort.signal, status => {
        if (active()) patch(target.id, { status: status.state === 'queued' ? 'queued' : 'processing', expiresAt: status.expiresAt, jobProgress: jobProgress(status) });
      });
      if (!active() || abort.signal.aborted) return;
      const result = finished.results[0];
      if (finished.state !== 'succeeded' || finished.results.length !== 1 || !result?.downloadUrl || result.size === null) {
        throw new ApiError(finished.error?.code ?? result?.error?.code ?? finished.state);
      }
      const { pageCount, sourcePageCount, archive } = (result.details ?? {}) as Record<string, unknown>;
      const valid = typeof pageCount === 'number' && Number.isInteger(pageCount) && pageCount >= 1 && pageCount <= limits.maxPages
        && typeof sourcePageCount === 'number' && Number.isInteger(sourcePageCount) && sourcePageCount >= pageCount
        && typeof archive === 'boolean' && (archive ? result.mime === 'application/zip' : IMAGE_MIME.includes(result.mime) && pageCount === 1)
        && result.size <= limits.maxOutputBytes;
      if (!valid) throw new ApiError('encode-failed');
      patch(target.id, { status: 'done', result: { size: result.size, pageCount, sourcePageCount, archive, settings }, resultUrl: result.downloadUrl,
        outputName: result.downloadName, expiresAt: finished.expiresAt, pageCount: sourcePageCount });
    } catch (error) {
      if (active() && !abort.signal.aborted) patch(target.id, { status: 'error', serverError: pdfImageMessage(error, limits) });
    } finally {
      if (generation.current === currentGeneration) {
        running.current = false;
        controller.current = null;
        if (mounted.current) setIsProcessing(false);
      }
    }
  }, [discardJob, limits, patch, support.status]);

  const processable = entry && ['ready', 'error', 'done'].includes(entry.status) ? 1 : 0;
  const counts: BatchCounts = { total: entry ? 1 : 0, checking: entry?.status === 'checking' ? 1 : 0,
    invalid: entry?.status === 'invalid' ? 1 : 0, processable, done: entry?.status === 'done' ? 1 : 0, failed: entry?.status === 'error' ? 1 : 0 };
  const progress: RunProgress | null = entry && (isProcessing || ['done', 'error'].includes(entry.status))
    ? { total: 1, done: counts.done, failed: counts.failed, finished: counts.done + counts.failed } : null;
  return { entry, entries: entry ? [entry] : [], support, limits, isProcessing, counts, progress, addFiles, process, reset, remove: reset };
}
