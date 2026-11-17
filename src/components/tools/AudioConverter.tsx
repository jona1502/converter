/**
 * Werkzeug „Audio konvertieren“: MP3, WAV, FLAC und OGG ineinander umwandeln. Qualität nur, wo sie
 * wirkt (MP3/OGG), Kanäle original oder Mono. Ablauf wie bei den Bildwerkzeugen: auswählen, prüfen,
 * ausdrücklich starten, Ergebnis herunterladen.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { audioAcceptAttribute, audioFormatLabel, AUDIO_FORMAT_INFO, AUDIO_FORMATS, type AudioFormat } from '../../lib/audio/formats';
import { formatChannels, formatDuration, formatDurationLimit, formatSampleRate } from '../../lib/audio/display';
import { buildAudioOptions, qualityApplies, type AudioChannels, type AudioSettings } from '../../lib/audio/options';
import { ActionBar } from './ActionBar';
import { DropZone } from './DropZone';
import { EntryList, MetadataGroup, ResultSummary } from './FileList';
import { AudioProcessingNotice, BrowserSupportNotice } from './notices';
import { ToolWorkspace } from './ToolWorkspace';
import { useAudioBatch, type AudioEntry } from './useAudioBatch';
import { useInitialFiles, type ToolProps } from './useInitialFiles';

/** Bevorzugtes Zielformat, falls der Server es anbietet. */
const PREFERRED_FORMAT: AudioFormat = 'mp3';

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function AudioFormatSelect({ value, onChange, available, disabled }: {
  value: AudioFormat | null;
  onChange: (format: AudioFormat) => void;
  /** null, solange die Fähigkeiten geladen werden. */
  available: readonly AudioFormat[] | null;
  disabled: boolean;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="label">Zielformat</label>
      <select
        id={id}
        className="select"
        value={value ?? ''}
        disabled={disabled || !available}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.currentTarget.value as AudioFormat)}
      >
        {!value && <option value="">Wird geprüft …</option>}
        {AUDIO_FORMATS.map((format) => {
          const offered = !available || available.includes(format);
          return (
            <option key={format} value={format} disabled={!offered}>
              {audioFormatLabel(format)} (.{AUDIO_FORMAT_INFO[format].extension}){offered ? '' : ' – nicht verfügbar'}
            </option>
          );
        })}
      </select>
      <p id={hintId} className="hint">
        {!available
          ? 'Es wird geprüft, welche Formate der Server erzeugen kann.'
          : 'MP3 und OGG (Vorbis) sind verlustbehaftet und klein, WAV und FLAC speichern verlustfrei. Die Abtastrate bleibt erhalten.'}
      </p>
    </div>
  );
}

function AudioQuality({ value, onChange }: { value: number; onChange: (percent: number) => void }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label">Qualität</label>
        <output htmlFor={id} className="rounded-lg border border-border bg-surface px-2 py-1 text-sm font-semibold tabular-nums">
          {value} %
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-valuetext={`${value} %`}
        aria-describedby={hintId}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <p id={hintId} className="hint">Höhere Werte klingen besser und ergeben größere Dateien.</p>
    </div>
  );
}

function ChannelChoice({ value, onChange, disabled }: { value: AudioChannels; onChange: (channels: AudioChannels) => void; disabled: boolean }) {
  const hintId = useId();
  const name = useId();
  return (
    <fieldset className="fieldset" aria-describedby={hintId}>
      <legend className="legend">Kanäle</legend>
      <div className="choice-group">
        <label>
          <input type="radio" name={name} value="original" checked={value === 'original'} disabled={disabled} onChange={() => onChange('original')} />
          Wie im Original
        </label>
        <label>
          <input type="radio" name={name} value="mono" checked={value === 'mono'} disabled={disabled} onChange={() => onChange('mono')} />
          Mono
        </label>
      </div>
      <p id={hintId} className="hint">Mono mischt alle Kanäle zu einem. Das hilft auch, wenn MP3 mehr als zwei Kanäle nicht speichern kann.</p>
    </fieldset>
  );
}

function originalPrefix(entry: AudioEntry): string {
  return entry.inputFormat ? `${audioFormatLabel(entry.inputFormat)} · ` : '';
}

function renderResult(entry: AudioEntry) {
  const { result } = entry;
  if (!result) return null;
  return (
    <ResultSummary
      entry={entry}
      resultSize={result.size}
      original={
        <MetadataGroup label="Original">
          {entry.inputFormat && <div><dt>Format</dt><dd>{audioFormatLabel(entry.inputFormat)}</dd></div>}
          <div><dt>Größe</dt><dd>{formatBytes(entry.size)}</dd></div>
        </MetadataGroup>
      }
      result={
        <MetadataGroup label="Ergebnis">
          <div><dt>Format</dt><dd>{audioFormatLabel(result.format)}</dd></div>
          {result.durationSeconds !== undefined && <div><dt>Dauer</dt><dd className="tabular-nums">{formatDuration(result.durationSeconds)}</dd></div>}
          {result.sampleRate !== undefined && result.sampleRate > 0 && <div><dt>Abtastrate</dt><dd>{formatSampleRate(result.sampleRate)}</dd></div>}
          {result.channels !== undefined && Number.isInteger(result.channels) && result.channels > 0 && <div><dt>Kanäle</dt><dd>{formatChannels(result.channels)}</dd></div>}
          <div><dt>Größe</dt><dd>{formatBytes(result.size)}</dd></div>
        </MetadataGroup>
      }
    />
  );
}

export default function AudioConverter({ initialFiles }: ToolProps) {
  const batch = useAudioBatch();
  const { support, counts, isProcessing, limits } = batch;
  const ready = support.status === 'ready';

  const [hydrated, setHydrated] = useState(false);
  const [format, setFormat] = useState<AudioFormat | null>(null);
  const [quality, setQuality] = useState(Math.round(limits.defaultQuality * 100));
  const [channels, setChannels] = useState<AudioChannels>('original');
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

  // Zielformat und Standardqualität übernehmen, sobald der Server seine Fähigkeiten gemeldet hat.
  useEffect(() => {
    if (!ready) return;
    setFormat((current) => {
      if (current && limits.outputFormats.includes(current)) return current;
      return limits.outputFormats.includes(PREFERRED_FORMAT) ? PREFERRED_FORMAT : limits.outputFormats[0] ?? null;
    });
    setQuality(Math.round(limits.defaultQuality * 100));
  }, [ready, limits]);

  const settings = useMemo<AudioSettings | null>(() => (format ? { format, quality, channels } : null), [format, quality, channels]);
  const optionsKey = settings ? JSON.stringify(buildAudioOptions(settings, limits.qualityFormats)) : null;
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

  const handleFiles = useCallback((files: File[]) => {
    const generation = generationRef.current;
    const outcome = batch.addFiles(files);
    if (outcome.rejected.length > 0) {
      const names = outcome.rejected.slice(0, 5).map((file) => file.name);
      const more = outcome.rejected.length - names.length;
      setLimitMessage(
        `Es können höchstens ${limits.maxFiles} Dateien gleichzeitig in der Liste sein. ${
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
    void outcome.checked.then(({ ready: readyCount, invalid }) => {
      if (generation !== generationRef.current) return;
      announce(
        `Prüfung abgeschlossen: ${plural(readyCount, 'Datei', 'Dateien')} bereit${
          invalid > 0 ? `, ${plural(invalid, 'Datei', 'Dateien')} nicht verwendbar` : ''
        }.`,
      );
    });
  }, [announce, batch, limits.maxFiles]);

  useInitialFiles(ready, initialFiles, handleFiles);

  const handleProcess = useCallback(async () => {
    if (!settings || !optionsKey) return;
    const generation = generationRef.current;
    setProcessedKey(optionsKey);
    announce('Konvertierung gestartet.');
    const summary = await batch.processAll(settings);
    if (generation !== generationRef.current) return;
    if (summary.total === 0) return;
    announce(
      `Konvertierung abgeschlossen: ${summary.done} von ${summary.total} fertig${
        summary.failed > 0 ? `, ${summary.failed} mit Fehler` : ''
      }.`,
    );
  }, [announce, batch, optionsKey, settings]);

  const handleRemove = useCallback((id: string) => {
    generationRef.current++;
    const entry = batch.entries.find((item) => item.id === id);
    batch.remove(id);
    if (entry) announce(`Datei ${entry.name} entfernt.`);
  }, [announce, batch]);

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
  else if (!ready || !format) disabledReason = 'Es wird geprüft, welche Formate der Server erzeugen kann.';
  else if (isProcessing) disabledReason = 'Die Konvertierung läuft.';
  else if (counts.checking > 0) disabledReason = 'Die Dateien werden noch geprüft.';
  else if (counts.processable === 0) disabledReason = 'Fügen Sie zuerst mindestens eine verwendbare Audiodatei hinzu.';
  else if (!limits.outputFormats.includes(format)) disabledReason = 'Das gewählte Format kann der Server nicht erzeugen.';

  const dropDisabled = !hydrated || support.status === 'unsupported';

  return (
    <div className="flex flex-col gap-8">
      <BrowserSupportNotice support={support} />

      <ToolWorkspace
        selectionTitle="Audiodateien auswählen"
        selection={<>
          <DropZone
            accept={audioAcceptAttribute()}
            disabled={dropDisabled}
            onFiles={handleFiles}
            buttonRef={fileButtonRef}
            title="Audiodateien hierher ziehen"
          >
            <p>Formate: MP3, WAV, FLAC und OGG (Vorbis oder Opus). M4A und AAC werden nicht unterstützt.</p>
            <p>
              Höchstens {limits.maxFiles} Dateien, je bis {formatBytes(limits.maxFileBytes)} und{' '}
              {formatDurationLimit(limits.maxDurationSeconds)} Spieldauer.
            </p>
          </DropZone>
          {limitMessage && (
            <p className="notice notice-error" role="alert">
              {limitMessage}
            </p>
          )}
        </>}
        settings={<>
          <AudioFormatSelect value={format} onChange={setFormat} available={ready ? limits.outputFormats : null} disabled={dropDisabled} />
          {format && qualityApplies(format, limits.qualityFormats) && <AudioQuality value={quality} onChange={setQuality} />}
          <ChannelChoice value={channels} onChange={setChannels} disabled={dropDisabled} />
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
          zipHref={batch.zipUrl}
        />}
        resultsHeadingId={listHeadingId}
        resultNotice={settingsChanged && (
          <p className="notice notice-warn text-sm">
            Die Einstellungen wurden geändert. Diese Ergebnisse stammen aus den vorherigen Einstellungen.
            Konvertieren Sie erneut, damit die Ergebnisse sie übernehmen.
          </p>
        )}
        resultsHint="Nach dem Konvertieren erscheint bei jeder Datei ein Link zum Herunterladen."
        results={<EntryList
          entries={batch.entries}
          onRemove={handleRemove}
          onEmptied={focusFileButton}
          labelledBy={listHeadingId}
          originalPrefix={originalPrefix}
          renderResult={renderResult}
        />}
      />

      <AudioProcessingNotice maxFileBytes={limits.maxFileBytes} maxDurationSeconds={limits.maxDurationSeconds} />

      <div aria-live="polite" className="sr-only" data-testid="live-region">
        {announcement}
      </div>
    </div>
  );
}
