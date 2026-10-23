import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatSizeChange } from '../../lib/format';
import { createPdfCompressor, PDF_LIMITS, PDF_QUALITY_LEVELS, PdfProcessingError, type PdfAnalysis, type PdfCompressor as Compressor, type PdfErrorCode, type PdfQualityLevel, type PdfVariantResult, type PdfVariantStatus } from '../../lib/pdf';

const labels = { high: 'Hohe Qualität', balanced: 'Ausgewogen', small: 'Kleine Datei' };
const descriptions = { high: 'Zielauflösung 300 dpi, zusätzlich Pixelgrenze; schonende Bildkomprimierung.', balanced: 'Zielauflösung 150 dpi, zusätzlich Pixelgrenze; mittlere Bildkomprimierung.', small: 'Zielauflösung 100 dpi, zusätzlich Pixelgrenze; stärkere Bildkomprimierung.' };
const errors: Record<PdfErrorCode, string> = {
  'not-pdf': 'Die Datei ist keine erkennbare PDF.', encrypted: 'Verschlüsselte PDFs werden nicht unterstützt. Bitte zuerst den Passwortschutz entfernen.',
  'file-too-large': 'Die PDF überschreitet die Grenze von 100 MB.', 'parse-failed': 'Die PDF ist beschädigt oder kann nicht gelesen werden.',
  'memory-limit': 'Das Speicherbudget wurde überschritten. Bitte eine kleinere PDF verwenden.', 'save-failed': 'Diese Variante konnte nicht gespeichert werden.',
  'unsupported-browser': 'Dieser Browser unterstützt die lokale PDF-Komprimierung nicht vollständig. Bitte einen aktuellen Browser mit OffscreenCanvas verwenden.',
  'invalid-options': 'Die gewählten Einstellungen sind ungültig.', 'worker-failed': 'Die Verarbeitung wurde unerwartet beendet. Möglicherweise reicht der Arbeitsspeicher nicht aus.', aborted: 'Die Verarbeitung wurde abgebrochen.',
};
function message(error: unknown): string { return error instanceof PdfProcessingError ? errors[error.code] : 'Die PDF konnte nicht verarbeitet werden.'; }
function phase(status: PdfVariantStatus | undefined): string {
  if (!status || status.phase === 'queued') return 'Wartet auf Berechnung';
  if (status.phase === 'loading') return 'PDF wird geladen …';
  if (status.phase === 'images') return `Bilder verarbeitet: ${status.current ?? 0} von ${status.total ?? 0}`;
  if (status.phase === 'saving') return 'PDF wird gespeichert …';
  if (status.phase === 'error') return errors[status.errorCode ?? 'save-failed'];
  return 'Fertig';
}
type Download = { result: PdfVariantResult; url: string };

export default function PdfCompressor() {
  const [ready, setReady] = useState(false);
  const [name, setName] = useState('');
  const [analysis, setAnalysis] = useState<PdfAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statuses, setStatuses] = useState<Partial<Record<PdfQualityLevel, PdfVariantStatus>>>({});
  const [downloads, setDownloads] = useState<Partial<Record<PdfQualityLevel, Download>>>({});
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const active = useRef<{ processor: Compressor; controller: AbortController } | null>(null);
  const generation = useRef(0);
  const urls = useRef<string[]>([]);
  function release() {
    generation.current++;
    active.current?.controller.abort();
    active.current?.processor.dispose();
    active.current = null;
    urls.current.forEach(url => URL.revokeObjectURL(url));
    urls.current = [];
  }
  useEffect(() => {
    setReady(true);
    const preventFileDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileDrop);
    window.addEventListener('drop', preventFileDrop);
    return () => {
      window.removeEventListener('dragover', preventFileDrop);
      window.removeEventListener('drop', preventFileDrop);
      release();
    };
  }, []);
  function reset() {
    release(); setName(''); setAnalysis(null); setBusy(false); setError(''); setNotice(''); setStatuses({}); setDownloads({});
    if (input.current) input.current.value = '';
    choose.current?.focus();
  }
  async function select(files: FileList | File[]) {
    if (!files.length) return;
    release();
    const id = generation.current;
    const file = files[0]!;
    setName(file.name); setAnalysis(null); setDownloads({}); setStatuses({}); setError(''); setBusy(true);
    setNotice(files.length > 1 ? 'Bitte nur eine PDF auswählen. Es wird ausschließlich die erste Datei verarbeitet.' : '');
    const processor = createPdfCompressor();
    const controller = new AbortController();
    active.current = { processor, controller };
    try {
      const a = await processor.analyze(file, controller.signal);
      if (generation.current !== id) return;
      setAnalysis(a);
      await processor.compressAll(file, PDF_QUALITY_LEVELS, {
        signal: controller.signal,
        onStatus: status => { if (generation.current === id) setStatuses(old => ({ ...old, [status.level]: status })); },
        onResult: result => {
          if (generation.current !== id) return;
          const url = URL.createObjectURL(result.blob);
          urls.current.push(url);
          setDownloads(old => ({ ...old, [result.level]: { result, url } }));
        },
      });
    } catch (e) {
      if (generation.current === id) {
        setError(message(e));
        const code = e instanceof PdfProcessingError ? e.code : 'worker-failed';
        setStatuses(old => {
          const next = { ...old };
          for (const level of PDF_QUALITY_LEVELS) {
            if (next[level]?.phase !== 'done') next[level] = { level, phase: 'error', errorCode: code };
          }
          return next;
        });
      }
    }
    finally {
      processor.dispose();
      if (generation.current === id) { setBusy(false); active.current = null; }
    }
  }
  let stem = Array.from(name.replace(/\.pdf$/i, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, ''))
    .slice(0, 100).join('').replace(/[\s.]+$/, '') || 'dokument';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return <div className="space-y-6">
    <div className="notice notice-warn">
      <p>Digitale Signaturen werden durch das Neuschreiben ungültig. Wählen Sie keine signierte PDF aus, deren Signatur gültig bleiben muss.</p>
      <p>Text und Vektoren bleiben erhalten. Maskierte Bilder, besondere Farbräume und einige Bildformate bleiben unverändert. Eine kleinere Datei ist nicht garantiert.</p>
    </div>
    <div className="card p-6 space-y-4" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (ready) void select(event.dataTransfer.files); }}>
      <p>Eine PDF hier ablegen oder auswählen. Die Verarbeitung läuft auf Ihrem Gerät, ohne Upload.</p>
      <p className="text-sm text-muted">Maximal {formatBytes(PDF_LIMITS.maxFileBytes)}. Alle drei Varianten werden nacheinander berechnet; bei großen Dateien kann dies dauern.</p>
      <input ref={input} className="sr-only" type="file" accept=".pdf,application/pdf" aria-label="PDF-Datei" tabIndex={-1} onChange={event => { if (event.target.files) void select(event.target.files); event.target.value = ''; }} />
      <div className="flex flex-wrap gap-3">
        <button ref={choose} type="button" className="btn btn-primary" disabled={!ready} onClick={() => input.current?.click()}>PDF auswählen</button>
        {name && <button type="button" className="btn btn-secondary" onClick={reset}>Zurücksetzen</button>}
      </div>
      {name && <p className="break-all">Ausgewählt: {name}</p>}
    </div>
    <div role="status" aria-live="polite" aria-atomic="true">
      {busy && !analysis && <p>PDF wird analysiert …</p>}
      {notice && <p>{notice}</p>}
      {error && <p className="notice notice-error">{error}</p>}
      {analysis && <div className="space-y-2">
        <p>Original: {formatBytes(analysis.fileSize)} · {analysis.pageCount} Seiten · {analysis.images.total} Bilder, davon {analysis.images.recompressible} grundsätzlich komprimierbar.</p>
        {analysis.images.recompressible === 0 && <p>Keine neu kodierbaren Bilder gefunden. Es ist nur eine verlustfreie Optimierung möglich; die Einsparung kann gering sein.</p>}
        {analysis.images.total > analysis.images.recompressible && <p>{analysis.images.total - analysis.images.recompressible} Bilder bleiben unverändert.</p>}
        {analysis.fontBytes > 0 && <p>Eingebettete Schriften werden nicht verkleinert.</p>}
        {analysis.limitations.some(l => l.code === 'signatures-invalidated') && <p className="notice notice-warn">Die PDF enthält digitale Signaturen. Die Ergebnisse besitzen keine gültigen ursprünglichen Signaturen.</p>}
      </div>}
    </div>
    {analysis && <div className="grid gap-4 md:grid-cols-3">
      {PDF_QUALITY_LEVELS.map(level => {
        const download = downloads[level];
        const change = download ? formatSizeChange(download.result.originalSize, download.result.size) : null;
        return <section key={level} className="card p-5 space-y-3" aria-labelledby={`pdf-${level}`}>
          <h2 id={`pdf-${level}`} className="text-xl font-semibold">{labels[level]}</h2>
          <p className="text-sm text-muted">{descriptions[level]}</p>
          <p role="status" aria-live="polite">{phase(statuses[level])}</p>
          {download && <>
            <p className="text-2xl font-semibold">{formatBytes(download.result.size)}</p>
            <p>{change?.percent} · {change?.kind === 'larger' ? 'Größer als das Original' : change?.kind === 'equal' ? 'Keine Einsparung' : 'Kleiner als das Original'}</p>
            {download.result.imagesSkipped > 0 && <p className="text-sm">{download.result.imagesSkipped} Bilder unverändert übersprungen.</p>}
            <a className="btn btn-primary" href={download.url} download={`${stem}-${level}.pdf`}>{labels[level]} herunterladen</a>
          </>}
        </section>;
      })}
    </div>}
  </div>;
}
