/**
 * PDF zusammenführen: mehrere lokal geprüfte PDFs in wählbarer Reihenfolge, ein ausdrücklicher Upload,
 * Polling und frühere Löschung. Jede Änderung der Liste verwirft ein vorhandenes Ergebnis.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, capabilities, createJob, deleteJob, pollJob } from '../../lib/api/client';
import { jobProgress, type JobProgress } from '../../lib/api/progress';
import { buildPdfMergeOptions, checkPdfFile, moveItem, PDF_MERGE_LIMITS, pdfMergeLimits, pdfMergeMessage, selectionIssue, type PdfMergeLimits } from '../../lib/pdfmerge';

export interface MergeSource {
  readonly id: string;
  readonly file: File;
  readonly name: string;
  readonly size: number;
  readonly status: 'checking' | 'ready' | 'invalid';
  readonly error?: string;
}
export interface MergeResult {
  readonly size: number;
  readonly pageCount: number;
  readonly sourceCount: number;
  readonly url: string;
  readonly name: string;
  readonly expiresAt: string;
}
export type MergePhase = 'idle' | 'uploading' | 'queued' | 'processing' | 'done' | 'error';
type Support = { status: 'checking' | 'ready' } | { status: 'unsupported'; reason: 'apis' | 'encoder' };

export function usePdfMergeBatch() {
  const [sources, setSources] = useState<readonly MergeSource[]>([]);
  const sourcesRef = useRef<readonly MergeSource[]>([]);
  const [phase, setPhase] = useState<MergePhase>('idle');
  const [result, setResult] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<JobProgress | undefined>();
  const [support, setSupport] = useState<Support>({ status: 'checking' });
  const [limits, setLimits] = useState<PdfMergeLimits>(PDF_MERGE_LIMITS);
  const limitsRef = useRef<PdfMergeLimits>(PDF_MERGE_LIMITS);
  const mounted = useRef(false);
  const nextId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
  const key = useRef<string | null>(null);
  const running = useRef(false);
  const generation = useRef(0);

  const setList = useCallback((next: readonly MergeSource[]) => {
    sourcesRef.current = next;
    if (mounted.current) setSources(next);
  }, []);
  const discardJob = useCallback(() => {
    if (jobId.current) { void deleteJob(jobId.current).catch(() => {}); jobId.current = null; }
  }, []);
  /** Ein neues Ergebnis passt nur zur aktuellen Reihenfolge: Änderungen verwerfen Auftrag, Ergebnis und Schlüssel. */
  const invalidate = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    discardJob();
    key.current = null;
    running.current = false;
    if (mounted.current) { setResult(null); setError(null); setProgress(undefined); setPhase('idle'); }
  }, [discardJob]);
  const reset = useCallback(() => { invalidate(); setList([]); }, [invalidate, setList]);

  useEffect(() => {
    mounted.current = true;
    const check = new AbortController();
    capabilities(check.signal).then(value => {
      if (check.signal.aborted) return;
      if (!value.pdfMerge?.available || !value.tools?.includes('pdf-merge')) { setSupport({ status: 'unsupported', reason: 'encoder' }); return; }
      limitsRef.current = pdfMergeLimits(value.pdfMerge);
      setLimits(limitsRef.current);
      setSupport({ status: 'ready' });
    }).catch(() => { if (!check.signal.aborted) setSupport({ status: 'unsupported', reason: 'apis' }); });
    return () => { check.abort(); mounted.current = false; reset(); };
  }, [reset]);

  useEffect(() => {
    if (phase !== 'done' || !result) return;
    const timer = setTimeout(() => {
      setResult(null);
      setPhase('error');
      setError('Der Auftrag ist abgelaufen. Bitte führen Sie die PDFs erneut zusammen.');
    }, Math.max(0, Date.parse(result.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, result]);

  /** Fügt Dateien am Ende an. Liefert, wie viele wegen der Höchstzahl abgewiesen wurden. */
  const addFiles = useCallback((files: File[]): number => {
    if (support.status !== 'ready' || !files.length) return 0;
    const room = Math.max(0, limitsRef.current.maxFiles - sourcesRef.current.length);
    const accepted = files.slice(0, room);
    if (!accepted.length) return files.length;
    invalidate();
    const added = accepted.map<MergeSource>(file => ({ id: `pdf-${++nextId.current}`, file, name: file.name, size: file.size, status: 'checking' }));
    setList([...sourcesRef.current, ...added]);
    for (const entry of added) {
      void checkPdfFile(entry.file, limitsRef.current.maxTotalBytes).then(check => {
        if (!mounted.current) return;
        setList(sourcesRef.current.map(item => item.id !== entry.id ? item
          : check.ok ? { ...item, status: 'ready' } : { ...item, status: 'invalid', error: pdfMergeMessage(new ApiError(check.code), limitsRef.current) }));
      }).catch(() => setList(sourcesRef.current.map(item => item.id === entry.id ? { ...item, status: 'invalid', error: 'Die Datei konnte nicht gelesen werden.' } : item)));
    }
    return files.length - accepted.length;
  }, [invalidate, setList, support.status]);

  const move = useCallback((id: string, delta: number) => {
    const index = sourcesRef.current.findIndex(item => item.id === id);
    if (index < 0) return;
    const next = moveItem(sourcesRef.current, index, delta);
    if (next.every((item, position) => item === sourcesRef.current[position])) return;
    invalidate();
    setList(next);
  }, [invalidate, setList]);
  const remove = useCallback((id: string) => { invalidate(); setList(sourcesRef.current.filter(item => item.id !== id)); }, [invalidate, setList]);

  const checking = sources.some(item => item.status === 'checking');
  const invalid = sources.filter(item => item.status === 'invalid').length;
  const issue = selectionIssue(sources.map(item => item.size), limits);
  const isProcessing = ['uploading', 'queued', 'processing'].includes(phase);
  const canProcess = support.status === 'ready' && !isProcessing && !checking && invalid === 0 && issue === null && sources.length > 0;

  const process = useCallback(async () => {
    const list = sourcesRef.current;
    if (running.current || support.status !== 'ready' || list.some(item => item.status !== 'ready')
      || selectionIssue(list.map(item => item.size), limitsRef.current) !== null) return;
    const currentGeneration = generation.current;
    const active = () => mounted.current && generation.current === currentGeneration;
    const abort = new AbortController();
    controller.current = abort;
    running.current = true;
    discardJob();
    setResult(null); setError(null); setPhase('uploading');
    try {
      key.current ??= crypto.randomUUID();
      const job = await createJob(list.map(item => item.file), buildPdfMergeOptions(), key.current, abort.signal, waiting => {
        if (active()) setPhase(waiting ? 'queued' : 'uploading');
      });
      if (!active() || abort.signal.aborted) { void deleteJob(job.id).catch(() => {}); return; }
      key.current = null;
      jobId.current = job.id;
      const finished = await pollJob(job, abort.signal, status => {
        if (!active()) return;
        setPhase(status.state === 'queued' ? 'queued' : 'processing');
        setProgress(jobProgress(status));
      });
      if (!active() || abort.signal.aborted) return;
      const item = finished.results[0];
      if (finished.state !== 'succeeded' || finished.results.length !== 1 || !item?.downloadUrl || item.size === null) {
        throw new ApiError(finished.error?.code ?? item?.error?.code ?? finished.state);
      }
      const pageCount = item.details?.pageCount;
      const sourceCount = item.details?.sourceCount;
      if (item.mime !== 'application/pdf' || typeof pageCount !== 'number' || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > limitsRef.current.maxPages
        || sourceCount !== list.length || item.size > limitsRef.current.maxOutputBytes) {
        throw new ApiError('encode-failed');
      }
      setResult({ size: item.size, pageCount, sourceCount, url: item.downloadUrl, name: item.downloadName, expiresAt: finished.expiresAt });
      setPhase('done');
    } catch (failure) {
      if (active() && !abort.signal.aborted) { setError(pdfMergeMessage(failure, limitsRef.current)); setPhase('error'); }
    } finally {
      if (generation.current === currentGeneration) { running.current = false; controller.current = null; setProgress(undefined); }
    }
  }, [discardJob, support.status]);

  return { sources, support, limits, phase, result, error, progress, issue, checking, invalid, isProcessing, canProcess, addFiles, move, remove, process, reset };
}
