/**
 * Werkzeug „Bilder konvertieren“: Zielformat wählen, Qualität (nur wo wirksam), Hintergrundfarbe
 * (nur für Formate ohne Transparenz), keine Größenänderung.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DEFAULT_ICO_SIZES, type IcoSize, type ImageFormat, type ProcessOptions } from '../../lib/image';
import { formatBytes } from '../../lib/format';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { FileList } from './FileList';
import { acceptAttribute, formatList, INPUT_FORMATS, pickDefaultFormat } from './formats';
import { BrowserSupportNotice, ImageProcessingNotice } from './notices';
import { BackgroundColor, FormatSelect, QualitySlider, IcoSizes } from './options';
import { useImageBatch, type BatchEntry } from './useImageBatch';
import { useInitialFiles, type ToolProps } from './useInitialFiles';
import { ToolWorkspace } from './ToolWorkspace';

/** Bevorzugte Zielformate in dieser Reihenfolge (erstes kodierbares wird Standard). */
const PREFERRED_FORMATS: readonly ImageFormat[] = ['webp', 'png'];
const numberDe = new Intl.NumberFormat('de-DE');

/**
 * Bei Formatwechsel genügt die neue Endung („foto.png“ → „foto.webp“). Bleibt das Format gleich,
 * wird „-konvertiert“ angehängt, damit der Download die Originaldatei nicht scheinbar ersetzt.
 */
function converterSuffix(entry: BatchEntry, options: ProcessOptions): string {
  return entry.probe?.format === options.format ? 'konvertiert' : '';
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export default function ImageConverter({ initialFiles }: ToolProps) {
  const batch = useImageBatch();
  const { support, counts, isProcessing } = batch;
  const encode = support.status === 'ready' ? support.encode : null;

  const [hydrated, setHydrated] = useState(false);
  const [format, setFormat] = useState<ImageFormat | null>(null);
  const [quality, setQuality] = useState(85);
  const [background, setBackground] = useState('#ffffff');
  const [icoSizes, setIcoSizes] = useState<readonly IcoSize[]>(DEFAULT_ICO_SIZES);
  const [announcement, setAnnouncement] = useState('');
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const [processedKey, setProcessedKey] = useState<string | null>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef(0);
  const announcementFrameRef = useRef<number | null>(null);
  const listHeadingId = useId();

  useEffect(() => setHydrated(true), []);
  useEffect(() => () => {
    generationRef.current++;
    if (announcementFrameRef.current !== null) cancelAnimationFrame(announcementFrameRef.current);
  }, []);

  // Standardformat festlegen, sobald bekannt ist, was der Browser kodieren kann.
  useEffect(() => {
    if (!encode) return;
    setFormat((current) => (current && encode[current] ? current : pickDefaultFormat(encode, PREFERRED_FORMATS)));
  }, [encode]);

  const options = useMemo<ProcessOptions | null>(
    () => (format ? { format, quality: quality / 100, background, resize: { mode: 'none' }, icoSizes } : null),
    [format, quality, background, icoSizes],
  );
  const optionsKey = options ? JSON.stringify(options) : null;
  const settingsChanged = processedKey !== null && optionsKey !== processedKey && counts.done > 0 && !isProcessing;

  const announce = useCallback((message: string) => {
    // Leeren und neu setzen, damit auch eine gleichlautende Meldung erneut vorgelesen wird.
    setAnnouncement('');
    if (announcementFrameRef.current !== null) cancelAnimationFrame(announcementFrameRef.current);
    const generation = generationRef.current;
    announcementFrameRef.current = requestAnimationFrame(() => {
      announcementFrameRef.current = null;
      if (generation === generationRef.current) setAnnouncement(message);
    });
  }, []);

  const handleFiles = useCallback(
    (files: File[]) => {
      const generation = generationRef.current;
      const outcome = batch.addFiles(files);
      if (outcome.rejected.length > 0) {
        const names = outcome.rejected.slice(0, 5).map((file) => file.name);
        const more = outcome.rejected.length - names.length;
        setLimitMessage(
          `Es können höchstens ${batch.limits.maxFiles} Dateien gleichzeitig in der Liste sein. ${
            outcome.rejected.length === 1 ? '1 Datei wurde' : `${outcome.rejected.length} Dateien wurden`
          } nicht hinzugefügt: ${names.join(', ')}${more > 0 ? ` und ${more} weitere` : ''}.`,
        );
      } else {
        setLimitMessage(null);
      }
      if (outcome.added === 0) {
        if (outcome.rejected.length > 0) announce('Keine Datei hinzugefügt – die Höchstzahl ist erreicht.');
        return;
      }
      announce(`${plural(outcome.added, 'Datei', 'Dateien')} hinzugefügt, Prüfung läuft.`);
      void outcome.checked.then(({ ready, invalid }) => {
        if (generation !== generationRef.current) return;
        announce(
          `Prüfung abgeschlossen: ${plural(ready, 'Datei', 'Dateien')} bereit${
            invalid > 0 ? `, ${plural(invalid, 'Datei', 'Dateien')} nicht verwendbar` : ''
          }.`,
        );
      });
    },
    [announce, batch],
  );

  useInitialFiles(support.status === 'ready', initialFiles, handleFiles);

  const handleProcess = useCallback(async () => {
    if (!options) return;
    const generation = generationRef.current;
    setProcessedKey(JSON.stringify(options));
    announce('Konvertierung gestartet.');
    const summary = await batch.processAll(options, converterSuffix);
    if (generation !== generationRef.current) return;
    if (summary.total === 0) return;
    announce(
      `Konvertierung abgeschlossen: ${summary.done} von ${summary.total} fertig${
        summary.failed > 0 ? `, ${summary.failed} mit Fehler` : ''
      }.`,
    );
  }, [announce, batch, options]);

  const handleRemove = useCallback(
    (id: string) => {
      generationRef.current++;
      const entry = batch.entries.find((item) => item.id === id);
      batch.remove(id);
      if (entry) announce(`Datei ${entry.name} entfernt.`);
    },
    [announce, batch],
  );

  const handleReset = useCallback(() => {
    generationRef.current++;
    batch.reset();
    setLimitMessage(null);
    setProcessedKey(null);
    announce('Alle Dateien entfernt.');
    fileButtonRef.current?.focus();
  }, [announce, batch]);

  const focusFileButton = useCallback(() => fileButtonRef.current?.focus(), []);

  let disabledReason: string | null = null;
  if (!hydrated) disabledReason = 'Die Seite wird geladen …';
  else if (support.status === 'unsupported') disabledReason = 'Der Server unterstützt dieses Werkzeug nicht.';
  else if (!encode || !format) disabledReason = 'Es wird geprüft, welche Formate der Server erzeugen kann.';
  else if (isProcessing) disabledReason = 'Die Konvertierung läuft.';
  else if (counts.checking > 0) disabledReason = 'Die Dateien werden noch geprüft.';
  else if (counts.processable === 0) disabledReason = 'Fügen Sie zuerst mindestens ein verwendbares Bild hinzu.';
  else if (!encode[format]) disabledReason = 'Das gewählte Format kann der Server nicht erzeugen.';

  const dropDisabled = !hydrated || support.status === 'unsupported';

  return (
    <div className="flex flex-col gap-8">
      <BrowserSupportNotice support={support} />

      <ToolWorkspace
        selection={<>
          <DropZone
            accept={acceptAttribute(INPUT_FORMATS)}
            disabled={dropDisabled}
            onFiles={handleFiles}
            buttonRef={fileButtonRef}
            title="Bilder hierher ziehen"
          >
            <p>Formate: {formatList(INPUT_FORMATS)} (keine animierten Bilder).</p>
            <p>
              Höchstens {batch.limits.maxFiles} Dateien, je bis {formatBytes(batch.limits.maxFileBytes)},{' '}
              {numberDe.format(batch.limits.maxEdge)} Pixel Kantenlänge und{' '}
              {numberDe.format(batch.limits.maxPixels / 1_000_000)} Megapixel.
            </p>
          </DropZone>
          {limitMessage && (
            <p className="notice notice-error" role="alert">
              {limitMessage}
            </p>
          )}
        </>}
        settings={<>
          <FormatSelect value={format} onChange={setFormat} support={encode} disabled={dropDisabled} />
          <QualitySlider format={format} value={quality} onChange={setQuality} />
          <BackgroundColor format={format} value={background} onChange={setBackground} />
          {format === 'ico' && <IcoSizes value={icoSizes} onChange={setIcoSizes} />}
          <p className="hint">{format === 'ico' ? 'Jede gewählte Größe wird quadratisch mit transparentem Rand eingepasst. Kleine Quellen können vergrößert werden.' : 'Die Abmessungen der Bilder bleiben unverändert.'}</p>
        </>}
        actionTitle="Konvertieren"
        action={<ActionBar
          processLabel="Konvertieren"
          onProcess={() => void handleProcess()}
          onReset={handleReset}
          counts={counts}
          isProcessing={isProcessing}
          progress={batch.progress}
          disabledReason={disabledReason}
        />}
        resultsHeadingId={listHeadingId}
        resultNotice={settingsChanged && (
          <p className="notice notice-warn text-sm">
            Die Einstellungen wurden geändert. Diese Ergebnisse stammen aus den vorherigen Einstellungen.
            Konvertieren Sie erneut, damit die Ergebnisse sie übernehmen.
          </p>
        )}
        resultsHint="Nach dem Konvertieren erscheint bei jeder Datei ein Link zum Herunterladen."
        results={<FileList
          entries={batch.entries}
          onRemove={handleRemove}
          onEmptied={focusFileButton}
          labelledBy={listHeadingId}
        />}
      />

      <ImageProcessingNotice />

      <div aria-live="polite" className="sr-only" data-testid="live-region">
        {announcement}
      </div>
    </div>
  );
}
