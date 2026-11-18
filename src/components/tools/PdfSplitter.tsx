import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, cancelJob, capabilities, createJob, deleteJob, pollJob, type Job } from '../../lib/api/client';
import { jobProgress } from '../../lib/api/progress';
import { formatBytes } from '../../lib/format';
import { inspectPdf } from '../../lib/pdfInspect';
import {
  buildSplitOptions, checkSplitSettings, DEFAULT_SPLIT_SETTINGS, MAX_RANGES, SPLIT_LIMITS, splitMessage,
  type SplitMode, type SplitSettings,
} from '../../lib/pdfSplit';
import { ToolWorkspace } from './ToolWorkspace';
import { useInitialFiles, type ToolProps } from './useInitialFiles';

type Support = { status: 'checking' | 'ready' } | { status: 'unsupported' };
type Selected = { file: File; pageCount: number | null; checking: boolean };

const MODES: ReadonlyArray<{ value: SplitMode; label: string }> = [
  { value: 'ranges', label: 'Seitenbereiche' },
  { value: 'each', label: 'Jede Seite einzeln' },
];

export default function PdfSplitter({ initialFiles }: ToolProps) {
  const [support, setSupport] = useState<Support>({ status: 'checking' });
  const [limits, setLimits] = useState(SPLIT_LIMITS);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [settings, setSettings] = useState<SplitSettings>(DEFAULT_SPLIT_SETTINGS);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [touched, setTouched] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
  const generation = useRef(0);
  const retryKey = useRef<string | null>(null);
  const modeName = useId();
  const rangesId = useId();
  const rangesHint = useId();
  const rangesError = useId();
  const heading = useId();

  const release = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    if (jobId.current) { void deleteJob(jobId.current).catch(() => {}); jobId.current = null; }
  }, []);

  useEffect(() => {
    const setup = new AbortController();
    capabilities(setup.signal).then(value => {
      const split = value.pdfSplit;
      if (!split?.available || !value.tools?.includes('pdf-split')) { setSupport({ status: 'unsupported' }); return; }
      setLimits({ maxFileBytes: split.maxFileBytes, maxOutputBytes: split.maxOutputBytes, maxParts: split.maxParts });
      setSupport({ status: 'ready' });
    }).catch(() => { if (!setup.signal.aborted) setSupport({ status: 'unsupported' }); });
    const prevent = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { setup.abort(); release(); window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, [release]);

  useEffect(() => {
    if (!job || job.state === 'expired' || !job.expiresAt) return;
    const timer = setTimeout(() => setJob(value => value && ({ ...value, state: 'expired',
      results: value.results.map(result => ({ ...result, downloadUrl: null })) })), Math.max(0, Date.parse(job.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [job]);

  const select = useCallback((files: FileList | File[]) => {
    if (!files.length) return;
    release();
    retryKey.current = null;
    setJob(null); setBusy(false); setError(''); setSelected(null); setTouched(false);
    setNotice(files.length > 1 ? 'Bitte nur eine PDF auswählen. Ausschließlich die erste Datei wird übernommen.' : '');
    const file = files[0]!;
    if (file.size > limits.maxFileBytes) { setError(splitMessage(new ApiError('file-too-large'), limits)); return; }
    const mine = generation.current;
    setSelected({ file, pageCount: null, checking: true });
    setAnnouncement('PDF ausgewählt. Die Prüfung läuft lokal; es wurde nichts hochgeladen.');
    void inspectPdf(file).then(result => {
      if (generation.current !== mine) return;
      if (!result.ok) {
        setSelected(null);
        setError(result.code === 'encrypted' ? 'Verschlüsselte PDFs werden nicht unterstützt.' : 'Die Datei ist keine erkennbare PDF.');
        return;
      }
      setSelected({ file, pageCount: result.pageCount, checking: false });
    });
  }, [limits, release]);
  useInitialFiles(support.status === 'ready', initialFiles, select);

  // Nur Anfang und Ende werden bereinigt; Leerzeichen innerhalb der Angabe bleiben ein Fehler.
  const effective = useMemo<SplitSettings>(() => ({ ...settings, ranges: settings.ranges.trim() }), [settings]);
  const check = useMemo(() => checkSplitSettings(effective, selected?.pageCount ?? null, limits.maxParts), [effective, selected?.pageCount, limits.maxParts]);
  const rangesInvalid = settings.mode === 'ranges' && !check.ok && (touched || settings.ranges !== '');

  function reset() {
    release();
    retryKey.current = null;
    setSelected(null); setJob(null); setBusy(false); setError(''); setNotice(''); setTouched(false);
    setAnnouncement('Auswahl zurückgesetzt.');
    choose.current?.focus();
  }

  async function start() {
    if (!selected || selected.checking || busy || !check.ok || support.status !== 'ready') return;
    release();
    setError(''); setJob(null); setBusy(true);
    setAnnouncement('Teilen gestartet.');
    const version = generation.current;
    const active = new AbortController();
    controller.current = active;
    try {
      retryKey.current ??= crypto.randomUUID();
      const accepted = await createJob(selected.file, buildSplitOptions(effective), retryKey.current, active.signal, waiting => {
        if (version === generation.current) setNotice(waiting ? 'Wartet auf einen freien Platz auf dem Server. Sie können die Auswahl zurücksetzen.' : '');
      });
      retryKey.current = null;
      if (version !== generation.current) { void deleteJob(accepted.id).catch(() => {}); return; }
      jobId.current = accepted.id;
      const finished = await pollJob(accepted, active.signal, value => { if (version === generation.current) setJob(value); });
      if (version !== generation.current) return;
      const result = finished.results[0];
      if (finished.state !== 'succeeded' || finished.results.length !== 1 || !result?.downloadUrl || result.size === null) {
        throw new ApiError(finished.error?.code ?? result?.error?.code ?? finished.state);
      }
      const details = result.details;
      const valid = typeof details?.pageCount === 'number' && typeof details.partCount === 'number'
        && details.partCount >= 1 && details.partCount <= limits.maxParts && result.size <= limits.maxOutputBytes
        && ['application/pdf', 'application/zip'].includes(result.mime);
      if (!valid) throw new ApiError('encode-failed');
      setJob(finished);
      setAnnouncement('Fertig. Das Ergebnis steht zum Download bereit.');
    } catch (failure) {
      if (version === generation.current && !active.signal.aborted) { setError(splitMessage(failure, limits)); setAnnouncement('Fehlgeschlagen.'); }
    } finally {
      if (version === generation.current) { setBusy(false); controller.current = null; }
    }
  }

  const result = job?.results[0];
  const expired = job?.state === 'expired';
  const position = job ? jobProgress(job)?.position : undefined;
  const succeeded = job?.state === 'succeeded' && !!result?.downloadUrl;
  let disabledReason = '';
  if (support.status === 'checking') disabledReason = 'Die Verfügbarkeit wird geprüft …';
  else if (support.status === 'unsupported') disabledReason = 'PDF teilen ist derzeit nicht verfügbar.';
  else if (busy) disabledReason = 'Die PDF wird geteilt.';
  else if (!selected) disabledReason = 'Wählen Sie zuerst eine PDF aus.';
  else if (selected.checking) disabledReason = 'Die PDF wird geprüft.';
  else if (!check.ok) disabledReason = check.message;
  const statusText = expired ? 'Auftrag abgelaufen. Sie können die PDF erneut teilen.'
    : busy ? (!job ? 'Datei wird hochgeladen …' : job.state === 'queued' ? `Wartet auf Verarbeitung${position ? ` (Platz ${position})` : ''} …` : 'PDF wird geteilt …')
    : '';
  const outcome = check.ok ? (check.zip ? `ZIP mit ${check.parts ?? 'einer PDF je Seite'}${check.parts ? ' PDF-Dateien' : ''}` : 'eine PDF') : null;

  return <div className="flex flex-col gap-8">
    <ToolWorkspace
    selectionTitle="PDF auswählen"
    selection={<>
      <div className="drop-zone" onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); if (support.status === 'ready') select(event.dataTransfer.files); }}>
        <p className="text-lg font-semibold">Eine PDF hier ablegen oder auswählen.</p>
        <p className="hint">{support.status === 'ready' ? `Höchstens ${formatBytes(limits.maxFileBytes)}.` : 'Die Dateigrenze wird vom Server geladen.'} Die Auswahl startet keinen Upload.</p>
        <input ref={input} className="sr-only" tabIndex={-1} type="file" accept=".pdf,application/pdf" aria-label="PDF-Datei"
          onChange={event => { if (event.target.files) select(event.target.files); event.target.value = ''; }} />
        <button ref={choose} type="button" className="btn btn-secondary" disabled={support.status !== 'ready'} onClick={() => input.current?.click()}>PDF auswählen</button>
      </div>
      {support.status === 'unsupported' && <p className="notice notice-error" role="alert">PDF teilen ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.</p>}
      {selected && <div className="card flex min-w-0 flex-col gap-2">
        <p className="hint">Ausgewählte PDF</p>
        <p className="break-all font-semibold">{selected.file.name}</p>
        <p className="tabular-nums">Größe: {formatBytes(selected.file.size)}{selected.checking ? ' · wird geprüft …' : selected.pageCount !== null ? ` · ${selected.pageCount} ${selected.pageCount === 1 ? 'Seite' : 'Seiten'}` : ' · Seitenzahl unbekannt, der Server prüft die Bereiche'}</p>
      </div>}
      {error && !busy && <p className="notice notice-error" role="alert">{error}</p>}
    </>}
    settings={<>
      <fieldset className="fieldset" disabled={busy}>
        <legend className="legend">Art des Teilens</legend>
        <div className="choice-group">
          {MODES.map(mode => <label key={mode.value}>
            <input type="radio" name={modeName} value={mode.value} checked={settings.mode === mode.value}
              onChange={() => setSettings(current => ({ ...current, mode: mode.value }))} />
            {mode.label}
          </label>)}
        </div>
      </fieldset>
      {settings.mode === 'ranges'
        ? <div className="field">
          <label htmlFor={rangesId} className="label">Seiten</label>
          <input id={rangesId} className="input" type="text" inputMode="text" autoComplete="off" spellCheck={false}
            placeholder="1-3,5,7-" value={settings.ranges} disabled={busy} maxLength={1024}
            aria-invalid={rangesInvalid || undefined} aria-describedby={`${rangesHint}${rangesInvalid ? ` ${rangesError}` : ''}`}
            onBlur={() => setTouched(true)} onChange={event => { const { value } = event.currentTarget; setSettings(current => ({ ...current, ranges: value })); }} />
          <p id={rangesHint} className="hint">Einzelne Seiten (5), Bereiche (1-3) und offene Bereiche (7- bis zum Ende), durch Kommas getrennt und ohne Leerzeichen. Höchstens {MAX_RANGES} Bereiche. Genau ein Bereich ergibt eine PDF, mehrere Bereiche ein ZIP mit einer PDF je Bereich.</p>
          {rangesInvalid && !check.ok && <p id={rangesError} className="field-error" role="alert">{check.message}</p>}
        </div>
        : <p className="hint">Jede Seite wird eine eigene PDF; alle Teile kommen als ZIP. Höchstens {limits.maxParts} Seiten.</p>}
      <p className="hint">Verschlüsselte PDFs werden abgelehnt. Teil-PDFs enthalten nur die gewählten Seiten; Lesezeichen, Formularfelder und Anhänge des Dokuments werden nicht übernommen.</p>
    </>}
    actionTitle="PDF teilen"
    action={<>
      <p className="hint">Erst mit „PDF teilen“ wird Ihre PDF auf den Server hochgeladen. Datei und Ergebnis werden temporär gespeichert und sind befristet verfügbar; Zurücksetzen fordert die frühere Löschung an. <a href="/lokale-verarbeitung" className="link">Mehr zur Dateiverarbeitung</a></p>
      <button type="button" className="btn btn-primary w-full" disabled={!!disabledReason} aria-describedby={`${heading}-start`} onClick={() => void start()}>PDF teilen</button>
      <p id={`${heading}-start`} className="hint">{disabledReason || (outcome ? `Bereit: Ergebnis ist ${outcome}.` : 'Bereit.')}</p>
      {(selected || busy) && <div className="flex flex-wrap gap-3">
        {busy && job && <button type="button" className="btn btn-secondary" onClick={() => void cancelJob(job.id).catch(failure => setError(splitMessage(failure, limits)))}>Abbrechen</button>}
        {selected && <button type="button" className="btn btn-ghost" onClick={reset}>Zurücksetzen</button>}
      </div>}
      <div role="status" aria-live="polite" className="space-y-3">{notice && <p className="notice notice-info">{notice}</p>}{statusText && <p>{statusText}</p>}</div>
    </>}
    resultsHeadingId={heading}
    resultsHint={!job && !busy ? 'Nach dem ausdrücklichen Start erscheint hier Ihr Ergebnis zum Download.' : undefined}
    results={<>
      {succeeded && result && job && <section className="card flex min-w-0 flex-col gap-3" aria-label="Ergebnis">
        <dl className="meta-list">
          <div><dt>Ergebnis</dt><dd>{result.mime === 'application/zip' ? 'ZIP mit PDF-Dateien' : 'PDF'}</dd></div>
          <div><dt>Teile</dt><dd>{String(result.details?.partCount)}</dd></div>
          <div><dt>Seiten der Vorlage</dt><dd>{String(result.details?.pageCount)}</dd></div>
          <div><dt>Größe</dt><dd>{formatBytes(result.size ?? 0)}</dd></div>
          <div><dt>Dateiname</dt><dd className="break-all">{result.downloadName}</dd></div>
        </dl>
        <a className="btn btn-primary max-w-full whitespace-normal break-all" href={result.downloadUrl ?? undefined} download={result.downloadName}>
          Herunterladen<span className="sr-only">: {result.downloadName}</span>
        </a>
        <p className="hint">Verfügbar bis <time dateTime={job.expiresAt}>{new Date(job.expiresAt).toLocaleString('de-DE')}</time>.</p>
      </section>}
      {expired && <p className="notice notice-warn">Auftrag abgelaufen. Teilen Sie die PDF erneut, um ein neues Ergebnis zu erzeugen.</p>}
    </>} />
    <div aria-live="polite" className="sr-only" data-testid="live-region">{announcement}</div>
  </div>;
}
