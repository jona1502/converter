import { useId, useMemo, useRef, useState } from 'react';
import { type ImageFormat, type ProcessOptions, type ResizeOptions } from '../../lib/image';
import { formatBytes } from '../../lib/format';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { FileList } from './FileList';
import { acceptAttribute, INPUT_FORMATS, formatLabel } from './formats';
import { BrowserSupportNotice, ImageProcessingNotice } from './notices';
import { BackgroundColor, QualitySlider } from './options';
import { useImageBatch, type BatchEntry } from './useImageBatch';
import { ToolWorkspace } from './ToolWorkspace';
import { useInitialFiles, type ToolProps } from './useInitialFiles';

const OUTPUTS: readonly ImageFormat[] = ['jpeg','png','webp','bmp'];
export default function ImageResizer({ initialFiles }: ToolProps) {
  const batch = useImageBatch('image-resize');
  const encode = batch.support.status === 'ready' ? batch.support.encode : null;
  const [format, setFormat] = useState<ImageFormat | 'original'>('original');
  const [mode, setMode] = useState<'percent' | 'dimensions'>('percent');
  const [percent, setPercent] = useState('50');
  const [width, setWidth] = useState(''); const [height, setHeight] = useState('');
  const [keepAspect, setKeepAspect] = useState(true); const [allowUpscale, setAllowUpscale] = useState(false);
  const [quality, setQuality] = useState(85); const [background, setBackground] = useState('#ffffff');
  const [limitMessage, setLimitMessage] = useState(''); const [processedKey, setProcessedKey] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null); const id = useId();
  const validNumber = (value: string) => value !== '' && Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= batch.limits.maxEdge;
  const valid = mode === 'percent' ? Number.isFinite(Number(percent)) && Number(percent) > 0 && (allowUpscale || Number(percent) <= 100)
    : (keepAspect ? (validNumber(width) || validNumber(height)) && (width === '' || validNumber(width)) && (height === '' || validNumber(height)) : validNumber(width) && validNumber(height));
  const unsupportedOriginal = format === 'original' && batch.entries.some(entry => entry.probe && (!OUTPUTS.includes(entry.probe.format as ImageFormat) || !encode?.[entry.probe.format as ImageFormat]));
  const resize = useMemo<ResizeOptions>(() => mode === 'percent'
    ? { mode, percent: Number(percent), allowUpscale }
    : { mode, ...(width !== '' ? { width: Number(width) } : {}), ...(height !== '' ? { height: Number(height) } : {}), keepAspectRatio: keepAspect, allowUpscale },
  [mode,percent,width,height,keepAspect,allowUpscale]);
  const key = JSON.stringify({format,resize,quality,background});
  const optionsFor = (entry: BatchEntry): ProcessOptions => ({ format: format === 'original' ? entry.probe!.format as ImageFormat : format, resize, quality: format === 'original' ? 0.85 : quality/100, background: format === 'original' ? '#ffffff' : background });
  const reason = batch.support.status === 'unsupported' ? 'Der Server unterstützt dieses Werkzeug nicht.' : !encode ? 'Die Serverfunktionen werden geprüft.' : format !== 'original' && !encode[format] ? 'Der Server kann das gewählte Zielformat nicht erzeugen.' : batch.isProcessing ? 'Die Verarbeitung läuft.' : batch.counts.checking ? 'Die Dateien werden geprüft.'
    : !valid ? 'Prüfen Sie die Größenangaben. Eine Vergrößerung muss ausdrücklich erlaubt sein.'
    : unsupportedOriginal ? 'Mindestens ein Originalformat kann nicht ausgegeben werden. Wählen Sie ein Zielformat oder entfernen Sie die betreffende Datei.'
    : !batch.counts.processable ? 'Fügen Sie zuerst mindestens ein verwendbares Bild hinzu.' : null;
  const handleFiles = (files: File[]) => {
    const outcome = batch.addFiles(files);
    setLimitMessage(outcome.rejected.length ? `${outcome.rejected.length} Dateien nicht hinzugefügt. Höchstens ${batch.limits.maxFiles} Dateien erlaubt.` : '');
  };
  useInitialFiles(batch.support.status === 'ready', initialFiles, handleFiles);
  const displayFormat = format === 'original' ? null : format;
  return <div className="flex flex-col gap-8">
    <BrowserSupportNotice support={batch.support} />
    <ToolWorkspace
      selection={<>
        <DropZone accept={acceptAttribute(INPUT_FORMATS)} disabled={!encode} buttonRef={buttonRef} onFiles={handleFiles}>
          <p>Unbewegte Bilder, höchstens {batch.limits.maxFiles} Dateien, je {formatBytes(batch.limits.maxFileBytes)}, {(batch.limits.maxPixels / 1_000_000).toLocaleString('de-DE')} Megapixel und {batch.limits.maxEdge.toLocaleString('de-DE')} Pixel Kantenlänge.</p>
        </DropZone>{limitMessage && <p role="alert" className="notice notice-error">{limitMessage}</p>}
      </>}
      settings={<>
        <div className="field"><label htmlFor={`${id}-mode`} className="label">Größenangabe</label><select id={`${id}-mode`} className="select" value={mode} onChange={event => setMode(event.currentTarget.value as typeof mode)}><option value="percent">Prozent</option><option value="dimensions">Breite und Höhe</option></select></div>
        {mode === 'percent' ? <div className="field"><label className="label" htmlFor={`${id}-percent`}>Größe in Prozent</label><input className="input" id={`${id}-percent`} type="number" min="0.1" step="any" value={percent} onChange={event => setPercent(event.currentTarget.value)} /></div>
        : <><div className="grid gap-4 sm:grid-cols-2"><div className="field"><label className="label" htmlFor={`${id}-width`}>Breite (Pixel)</label><input className="input" id={`${id}-width`} type="number" min="1" max={batch.limits.maxEdge} value={width} onChange={event => setWidth(event.currentTarget.value)} /></div><div className="field"><label className="label" htmlFor={`${id}-height`}>Höhe (Pixel)</label><input className="input" id={`${id}-height`} type="number" min="1" max={batch.limits.maxEdge} value={height} onChange={event => setHeight(event.currentTarget.value)} /></div></div>
          <label className="field-row"><input className="checkbox" type="checkbox" checked={keepAspect} onChange={event => setKeepAspect(event.currentTarget.checked)} />Seitenverhältnis erhalten</label>
          <p className="hint">Mit Seitenverhältnis genügt eine Kante; bei beiden Angaben wird das Bild in den Rahmen eingepasst. Ohne Seitenverhältnis sind beide Angaben nötig; Verzerrungen sind möglich.</p></>}
        <label className="field-row"><input className="checkbox" type="checkbox" checked={allowUpscale} onChange={event => setAllowUpscale(event.currentTarget.checked)} />Vergrößerung erlauben</label>
        <p className="hint">Vergrößern erzeugt keine neuen Details. Ohne Erlaubnis werden Pixel-Zielgrößen auf die Originalgröße begrenzt; Prozentwerte über 100 sind gesperrt. Höchstens {(batch.limits.maxPixels / 1_000_000).toLocaleString('de-DE')} Megapixel und {batch.limits.maxEdge.toLocaleString('de-DE')} Pixel je Kante.</p>
        <div className="field"><label htmlFor={`${id}-format`} className="label">Zielformat</label><select className="select" id={`${id}-format`} value={format} disabled={!encode} onChange={event => setFormat(event.currentTarget.value as typeof format)}>
          <option value="original">Wie Original</option>{OUTPUTS.map(item => <option key={item} value={item} disabled={!encode?.[item]}>{formatLabel(item)}{encode && !encode[item] ? ' – nicht verfügbar' : ''}</option>)}
        </select><p className="hint">Nicht verfügbare Formate kann der Server nicht erzeugen. GIF, AVIF und ICO können hier nicht als Originalformat ausgegeben werden; wählen Sie dann ein anderes Zielformat.</p></div>
        {unsupportedOriginal && <p className="notice notice-warn">Mindestens ein Originalformat ist nicht als Ausgabe verfügbar. Es wird kein Ersatzformat automatisch gewählt.</p>}
        {format === 'original' ? <p className="hint">Originalformat wird beibehalten; JPEG und WebP verwenden 85 % Qualität. Transparenz wird bei JPEG/BMP mit Weiß gefüllt.</p> : <><QualitySlider format={displayFormat} value={quality} onChange={setQuality} /><BackgroundColor format={displayFormat} value={background} onChange={setBackground} /></>}
      </>}
      actionTitle="Skalieren"
      action={<ActionBar processLabel="Skalieren" counts={batch.counts} progress={batch.progress} isProcessing={batch.isProcessing} disabledReason={reason}
        onReset={() => { batch.reset(); setProcessedKey(null); setLimitMessage(''); buttonRef.current?.focus(); }}
        onProcess={() => { setProcessedKey(key); void batch.processAll(optionsFor, 'skaliert'); }} />}
      resultsHeadingId={`${id}-results`}
      resultNotice={processedKey !== null && processedKey !== key && batch.counts.done > 0 && (
        <p className="notice notice-warn">Einstellungen geändert. Diese Ergebnisse stammen aus den vorherigen Einstellungen. Erneut skalieren, um die Ergebnisse zu aktualisieren.</p>
      )}
      results={<FileList entries={batch.entries} onRemove={batch.remove} onEmptied={() => buttonRef.current?.focus()} labelledBy={`${id}-results`} />}
    />
    <p aria-live="polite" className="sr-only">{batch.counts.total} Dateien, {batch.counts.checking} werden geprüft, {batch.counts.done} fertig, {batch.counts.failed + batch.counts.invalid} mit Fehler.</p><ImageProcessingNotice />
  </div>;
}
