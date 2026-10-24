import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { type ImageFormat, type ProcessOptions } from '../../lib/image';
import { formatBytes } from '../../lib/format';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { FileList } from './FileList';
import { acceptAttribute, INPUT_FORMATS, formatList } from './formats';
import { BrowserSupportNotice, ImageProcessingNotice } from './notices';
import { BackgroundColor, FormatSelect, QualitySlider } from './options';
import { useImageBatch } from './useImageBatch';

const OUTPUTS: readonly ImageFormat[] = ['jpeg', 'webp', 'png'];

export default function ImageCompressor() {
  const batch = useImageBatch('image-compress');
  const encode = batch.support.status === 'ready' ? batch.support.encode : null;
  const [format, setFormat] = useState<ImageFormat>('jpeg');
  const [quality, setQuality] = useState(75);
  const [background, setBackground] = useState('#ffffff');
  const [maxEdge, setMaxEdge] = useState('');
  const [limitMessage, setLimitMessage] = useState('');
  const [processedKey, setProcessedKey] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const heading = useId(), edgeId = useId(), edgeHint = useId();
  useEffect(() => {
    if (encode && !encode[format]) setFormat(OUTPUTS.find(item => encode[item]) ?? 'png');
  }, [encode, format]);
  const edge = Number(maxEdge);
  const validEdge = maxEdge === '' || (Number.isInteger(edge) && edge > 0 && edge <= batch.limits.maxEdge);
  const options = useMemo<ProcessOptions>(() => ({
    format, quality: quality / 100, background,
    resize: maxEdge === '' ? { mode: 'none' } : { mode: 'maxEdge', maxEdge: edge },
  }), [format, quality, background, maxEdge, edge]);
  const key = JSON.stringify(options);
  const reason = batch.support.status === 'unsupported' ? 'Der Server unterstützt dieses Werkzeug nicht.'
    : !encode ? 'Die Serverfunktionen werden geprüft.'
    : !encode[format] ? 'Der Server kann das gewählte Zielformat nicht erzeugen.'
    : batch.isProcessing ? 'Die Verarbeitung läuft.'
    : batch.counts.checking ? 'Die Dateien werden geprüft.'
    : !validEdge ? 'Geben Sie eine gültige maximale Kantenlänge ein.'
    : !batch.counts.processable ? 'Fügen Sie zuerst mindestens ein verwendbares Bild hinzu.' : null;
  const reset = () => { batch.reset(); setLimitMessage(''); setProcessedKey(null); buttonRef.current?.focus(); };
  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={batch.support} />
    <section className="flex flex-col gap-4" aria-labelledby="compress-files">
      <h2 id="compress-files" className="section-title">1. Bilder auswählen</h2>
      <DropZone accept={acceptAttribute(INPUT_FORMATS)} disabled={!encode} buttonRef={buttonRef} onFiles={files => {
        const outcome = batch.addFiles(files);
        setLimitMessage(outcome.rejected.length ? `${outcome.rejected.length} Dateien wurden nicht hinzugefügt. Höchstens ${batch.limits.maxFiles} Dateien sind gleichzeitig erlaubt.` : '');
      }}>
        <p>{formatList(INPUT_FORMATS)}; nur unbewegte Bilder. Höchstens {batch.limits.maxFiles} Dateien, je {formatBytes(batch.limits.maxFileBytes)} und {(batch.limits.maxPixels / 1_000_000).toLocaleString('de-DE')} Megapixel.</p>
      </DropZone>
      {limitMessage && <p role="alert" className="notice notice-error">{limitMessage}</p>}
    </section>
    <section className="card-muted flex flex-col gap-5" aria-labelledby="compress-options">
      <h2 id="compress-options" className="section-title">2. Komprimierung einstellen</h2>
      <FormatSelect value={format} onChange={setFormat} support={encode} formats={OUTPUTS} />
      <QualitySlider format={format} value={quality} onChange={setQuality} />
      {format === 'png' && <p className="notice notice-info">PNG wird nur neu kodiert; eine kleinere Datei ist nicht garantiert. Wählen Sie JPEG oder WebP für verlustbehaftete Komprimierung oder verkleinern Sie die Abmessungen.</p>}
      <BackgroundColor format={format} value={background} onChange={setBackground} />
      <div className="field"><label className="label" htmlFor={edgeId}>Maximale Kantenlänge (optional)</label>
        <input id={edgeId} className="input" type="number" min={1} max={batch.limits.maxEdge} step={1} value={maxEdge} onChange={event => setMaxEdge(event.currentTarget.value)} aria-describedby={edgeHint} aria-invalid={!validEdge} />
        <p id={edgeHint} className={validEdge ? 'hint' : 'field-error'}>Leer lassen für Originalabmessungen. Sonst 1 bis {batch.limits.maxEdge.toLocaleString('de-DE')} Pixel; kleinere Bilder werden nicht vergrößert.</p>
      </div>
    </section>
    <section className="flex flex-col gap-4" aria-labelledby="compress-start">
      <h2 id="compress-start" className="section-title">3. Komprimieren</h2>
      {processedKey !== null && processedKey !== key && batch.counts.done > 0 && <p className="notice notice-warn">Einstellungen geändert. Erneut komprimieren, um die Ergebnisse zu aktualisieren.</p>}
      <ActionBar processLabel="Komprimieren" counts={batch.counts} progress={batch.progress} isProcessing={batch.isProcessing} disabledReason={reason}
        onReset={reset} onProcess={() => { setProcessedKey(key); void batch.processAll(options, 'komprimiert'); }} />
    </section>
    <section className="flex flex-col gap-4" aria-labelledby={heading}>
      <h2 id={heading} className="section-title">4. Dateien und Ergebnisse</h2>
      <FileList entries={batch.entries} onRemove={batch.remove} onEmptied={() => buttonRef.current?.focus()} labelledBy={heading} />
    </section>
    <p aria-live="polite" className="sr-only">{batch.counts.total} Dateien, {batch.counts.checking} werden geprüft, {batch.counts.done} fertig, {batch.counts.failed + batch.counts.invalid} mit Fehler.</p>
    <ImageProcessingNotice />
  </div>;
}
