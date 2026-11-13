import {useEffect, useRef, useState} from 'react';
import {formatBytes, formatSizeChange} from '../../lib/format';
import {ToolWorkspace} from './ToolWorkspace';
import {apiMessage, ApiError, capabilities, cancelJob, createJob, deleteJob, pollJob, type Job} from '../../lib/api/client';
const levels = ['high','balanced','small'] as const;
const labels = {high: 'Hohe Qualität', balanced: 'Ausgewogen', small: 'Kleine Datei'};
export default function PdfCompressor() {
  const [file,setFile] = useState<File | null>(null), [job,setJob] = useState<Job | null>(null);
  const [ready,setReady] = useState(false), [busy,setBusy] = useState(false);
  const [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [limit,setLimit] = useState(100_000_000);
  const input = useRef<HTMLInputElement>(null), choose = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null), jobId = useRef<string | null>(null);
  const generation = useRef(0);
  const retryKey=useRef<string | null>(null);
  useEffect(()=>{
    if(!job||job.state==='expired')return;
    const timer=setTimeout(()=>setJob(value=>value?{...value,state:'expired',results:value.results.map(result=>({...result,downloadUrl:null}))}:value),Math.max(0,Date.parse(job.expiresAt)-Date.now()));
    return ()=>clearTimeout(timer);
  },[job]);
  function release() {
    generation.current++; controller.current?.abort(); controller.current = null;
    if (jobId.current) {void deleteJob(jobId.current).catch(() => {});jobId.current=null;}
  }
  useEffect(() => {
    const setup = new AbortController();
    capabilities(setup.signal).then(value=>{setLimit(value.pdf.maxFileBytes);setReady(true);})
      .catch(error=>{if(!setup.signal.aborted)setError(apiMessage(error));});
    const prevent = (event: DragEvent) => {if(event.dataTransfer?.types.includes('Files'))event.preventDefault();};
    window.addEventListener('dragover',prevent);window.addEventListener('drop',prevent);
    return ()=>{setup.abort();release();window.removeEventListener('dragover',prevent);window.removeEventListener('drop',prevent);};
  },[]);
  function select(files: FileList | File[]) {
    if(!files.length)return;
    release();retryKey.current=null;setJob(null);setBusy(false);setError('');setFile(null);
    setNotice(files.length > 1 ? 'Bitte nur eine PDF auswählen. Ausschließlich die erste Datei wird übernommen.' : '');
    if(files[0]!.size>limit){setError('Die PDF überschreitet die zulässige Dateigröße.');return;}
    setFile(files[0]!);
  }
  function reset(){release();retryKey.current=null;setFile(null);setJob(null);setBusy(false);setError('');setNotice('');choose.current?.focus();}
  async function start(){
    if(!file||busy)return;
    release();setError('');setJob(null);setBusy(true);
    const version=generation.current, active=new AbortController();controller.current=active;
    try{
      retryKey.current??=crypto.randomUUID();
      const accepted=await createJob(file,{tool:'pdf-compress',levels:[...levels]},retryKey.current,active.signal,waiting=>{
        if(version===generation.current)setNotice(waiting?'Wartet auf einen freien Platz auf dem Server. Sie können die Auswahl zurücksetzen.':'');
      });
      retryKey.current=null;
      if(version!==generation.current){void deleteJob(accepted.id).catch(()=>{});return;}
      jobId.current=accepted.id;
      const finished=await pollJob(accepted,active.signal,value=>{if(version===generation.current)setJob(value);});
      if(version===generation.current&&!['succeeded','partially_succeeded'].includes(finished.state))throw new ApiError(finished.error?.code??finished.state);
    }catch(error){if(version===generation.current&&!active.signal.aborted)setError(apiMessage(error));}
    finally{if(version===generation.current){setBusy(false);controller.current=null;}}
  }
  const imageAnalysis=job?.analysis?.images;
  const images=imageAnalysis&&typeof imageAnalysis==='object'?imageAnalysis as Record<string,unknown>:null;
  const progress=job?.progress;
  const statusText=job?.state==='expired'?'Auftrag abgelaufen. Sie können die PDF erneut komprimieren.':busy?
    !job?'Datei wird hochgeladen …':job.state==='queued'?'Wartet auf Verarbeitung …':'PDF wird verarbeitet …':
    job?.state==='succeeded'?'Alle drei Varianten sind fertig.':job?.state==='partially_succeeded'?'Verarbeitung mit Teilfehlern abgeschlossen.':'';
  const signaturesInvalidated=Array.isArray(job?.analysis?.limitations)&&job.analysis.limitations.some(
    limitation=>limitation&&typeof limitation==='object'&&limitation.code==='signatures-invalidated',
  );
  return <ToolWorkspace
    selectionTitle="PDF auswählen"
    selection={<>
      <div className="drop-zone" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();if(ready)select(event.dataTransfer.files);}}>
        <p className="text-lg font-semibold">Eine PDF hier ablegen oder auswählen.</p>
        <p className="hint">{ready?`Maximal ${formatBytes(limit)}.`:'Die Dateigrenze wird vom Server geladen.'} Die Auswahl startet keinen Upload.</p>
        <input ref={input} className="sr-only" tabIndex={-1} type="file" accept=".pdf,application/pdf" aria-label="PDF-Datei" onChange={event=>{if(event.target.files)select(event.target.files);event.target.value='';}}/>
        <button ref={choose} className="btn btn-secondary" disabled={!ready} onClick={()=>input.current?.click()}>PDF auswählen</button>
      </div>
      {file&&<div className="card flex min-w-0 flex-col gap-2">
        <p className="hint">Ausgewählte PDF</p>
        <p className="break-all font-semibold">{file.name}</p>
        <p className="tabular-nums">Originalgröße: {formatBytes(file.size)}</p>
      </div>}
    </>}
    settings={<>
      <p>Alle drei Varianten werden mit einem Start berechnet.</p>
      <p className="hint">Verschlüsselte PDFs werden abgelehnt. Digitale Signaturen können ungültig werden; der Erhalt von PDF/A ist nicht garantiert.</p>
      <dl className="flex flex-col gap-4">
        <div><dt className="font-semibold">Hohe Qualität</dt><dd className="hint">Schonende Komprimierung.</dd></div>
        <div><dt className="font-semibold">Ausgewogen</dt><dd className="hint">Kompromiss zwischen Qualität und Dateigröße.</dd></div>
        <div><dt className="font-semibold">Kleine Datei</dt><dd className="hint">Stärkere Komprimierung mit geringerer Bildqualität.</dd></div>
      </dl>
    </>}
    actionTitle="PDF komprimieren"
    action={<>
      <p className="hint">Erst mit „Komprimieren“ wird Ihre PDF auf den Server hochgeladen. Datei und Ergebnisse werden temporär gespeichert. Downloads sind befristet verfügbar; Zurücksetzen fordert die frühere Löschung an. <a href="/lokale-verarbeitung" className="link">Mehr zur Dateiverarbeitung</a></p>
      <button className="btn btn-primary w-full" disabled={!ready||!file||busy} aria-describedby="pdf-start-hint" onClick={()=>void start()}>Komprimieren</button>
      <p id="pdf-start-hint" className="hint">{!ready?'Der Server wird vorbereitet.':busy?'Die Verarbeitung läuft. Sie können abbrechen oder zurücksetzen.':!file?'Wählen Sie zuerst eine PDF aus.':'Bereit: Analyse und drei Varianten starten.'}</p>
      {(file||busy)&&<div className="flex flex-wrap gap-3">
        {busy&&job&&<button className="btn btn-secondary" onClick={()=>void cancelJob(job.id).catch(error=>setError(apiMessage(error)))}>Abbrechen</button>}
        {file&&<button className="btn btn-ghost" onClick={reset}>Zurücksetzen</button>}
      </div>}
      <div role="status" aria-live="polite" className="space-y-3">{notice&&<p className="notice notice-info">{notice}</p>}{error&&<p className="notice notice-error">{error}</p>}{statusText&&<p>{statusText}</p>}</div>
    </>}
    resultsHeadingId="pdf-results"
    results={<>
      {!job&&<div className="card-muted"><p className="hint">{busy?'Die Analyse und Varianten erscheinen nach der Serverantwort.':'Nach dem Start sehen Sie hier die Analyse und die drei berechneten Varianten.'}</p></div>}
      {job?.analysis&&<section className="card-muted space-y-4" aria-labelledby="pdf-analysis">
        <h3 className="card-title" id="pdf-analysis">Analyse</h3>
        <dl className="meta-list">
          <div><dt>Originalgröße</dt><dd>{formatBytes(job.input.size)}</dd></div>
          {typeof job.analysis.pdfVersion==='string'&&<div><dt>PDF-Version</dt><dd>{job.analysis.pdfVersion}</dd></div>}
          {typeof job.analysis.pageCount==='number'&&<div><dt>Seiten</dt><dd>{job.analysis.pageCount}</dd></div>}
          {typeof images?.total==='number'&&<div><dt>Bilder</dt><dd>{images.total}</dd></div>}
          {typeof images?.recompressible==='number'&&<div><dt>Komprimierbare Bilder</dt><dd>{images.recompressible}</dd></div>}
        </dl>
        {images?.recompressible===0&&<p className="notice notice-info">Keine neu kodierbaren Bilder gefunden. Nur verlustfreie Optimierung ist möglich; die Einsparung kann gering sein.</p>}
        {signaturesInvalidated&&<p className="notice notice-warn">Digitale Signaturen werden durch das Neuschreiben der PDF ungültig.</p>}
        {typeof progress?.current==='number'&&typeof progress?.total==='number'&&<p role="status" className="hint tabular-nums">Bilder verarbeitet: {progress.current} von {progress.total}</p>}
      </section>}
      {job&&<>
        <p className={job.state==='expired'?'notice notice-warn':'hint'}>{job.state==='expired'?'Auftrag abgelaufen. Erneut komprimieren, um neue Ergebnisse zu erzeugen.':`Verfügbar bis ${new Date(job.expiresAt).toLocaleString('de-DE')}.`}</p>
        {job.state==='partially_succeeded'&&<p className="notice notice-warn">Verarbeitung mit Teilfehlern abgeschlossen. Erfolgreiche Varianten können Sie herunterladen.</p>}
        <div className="grid min-w-0 gap-4 2xl:grid-cols-3">{levels.map(level=>{
          const result=job.results.find(result=>result.level===level);
          const change=result?.size!=null?formatSizeChange(job.input.size,result.size):null;
          const status=job.state==='expired'?'Abgelaufen':result?.state==='succeeded'?'Fertig':result?.state==='failed'?'Variante fehlgeschlagen':result?.state==='cancelled'||job.state==='cancelled'?'Abgebrochen':result?.state==='running'?'Wird verarbeitet …':job.state==='failed'?'Nicht berechnet':'Wartet auf Berechnung';
          return <section className="variant-card min-w-0" key={level} aria-labelledby={`pdf-${level}`}>
            <h3 className="card-title" id={`pdf-${level}`}>{labels[level]}</h3>
            <p className={result?.state==='failed'?'badge badge-danger self-start':'badge badge-neutral self-start'}>{status}</p>
            {result?.error&&<p className="field-error">{apiMessage(new ApiError(result.error.code))}</p>}
            {result?.size!=null&&<>
              <dl className="meta-list">
                <div><dt>Originalgröße</dt><dd>{formatBytes(job.input.size)}</dd></div>
                <div><dt>Ergebnisgröße</dt><dd>{formatBytes(result.size)}</dd></div>
                <div><dt>Änderung</dt><dd>{change?.percent}</dd></div>
              </dl>
              <p className="hint">{change?.kind==='larger'?'Größer als das Original':change?.kind==='equal'?'Keine Einsparung':'Kleiner als das Original'}</p>
            </>}
            {typeof result?.details?.imagesSkipped==='number'&&result.details.imagesSkipped>0&&<p className="hint">{result.details.imagesSkipped} Bilder unverändert übersprungen.</p>}
            {job.state!=='expired'&&result?.downloadUrl&&<a className="btn btn-primary mt-auto w-full" href={result.downloadUrl} download={result.downloadName}>{labels[level]} herunterladen</a>}
          </section>;
        })}</div>
      </>}
    </>}/>
}
