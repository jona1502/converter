/**
 * Startseite: Dateien ablegen, Typ lokal erkennen, Aktion wählen, Werkzeug auf derselben Seite
 * mit den Dateien öffnen (select → choose → tool).
 * Der frühere Aktionsschritt ist jetzt eine durchgehende Konvertierungsliste; zusätzliche
 * Werkzeuge öffnen sich weiterhin auf derselben Seite, während die Liste montiert bleibt.
 *
 * Datenschutz: Die Dateien bleiben im Arbeitsspeicher dieses React-Baums und werden an die
 * Werkzeugkomponente als Prop übergeben. Sie werden nicht in Web Storage, IndexedDB oder Cache
 * abgelegt. Hochgeladen wird erst nach ausdrücklichem Start im Werkzeug.
 * Dies gilt ebenso für den ausdrücklichen Start in der Konvertierungsliste.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { availableTools, availableToolsByCategory, type Tool } from '../../data/tools';
import { kindLabel, type FileKind } from '../../lib/quickstart';
import { detectFile, extensionNote } from '../../lib/detect';
import { audioAcceptAttribute, AUDIO_FORMAT_INFO, type AudioFormat } from '../../lib/audio/formats';
import { DEFAULT_ICO_SIZES, type ImageFormat } from '../../lib/image';
import { formatBytes } from '../../lib/format';
import { MARKDOWN_ACCEPT } from '../../lib/markdown';
import { DropZone } from '../tools/DropZone';
import { acceptAttribute, formatLabel, INPUT_FORMATS, OUTPUT_FORMATS } from '../tools/formats';
import { imageErrorMessage } from '../tools/errorMessages';
import { useAudioBatch } from '../tools/useAudioBatch';
import { isProcessable, useImageBatch } from '../tools/useImageBatch';
import type { ToolProps } from '../tools/useInitialFiles';

type ToolComponent = LazyExoticComponent<ComponentType<ToolProps>>;

/** Werkzeugkomponenten werden erst geladen, wenn sie gebraucht werden. */
const TOOL_COMPONENTS: Readonly<Record<string, ToolComponent>> = {
  'bilder-konvertieren': lazy(() => import('../tools/ImageConverter')),
  'bilder-komprimieren': lazy(() => import('../tools/ImageCompressor')),
  'bilder-skalieren': lazy(() => import('../tools/ImageResizer')),
  'pdf-komprimieren': lazy(() => import('../tools/PdfCompressor')),
  'audio-konvertieren': lazy(() => import('../tools/AudioConverter')),
  'markdown-pdf': lazy(() => import('../tools/MarkdownConverter')),
  'pdf-zu-bild': lazy(() => import('../tools/PdfImageConverter')),
};

/** Textlinks in der Reihenfolge Bilder, PDF, Audio. */
const LINKED_TOOLS = availableToolsByCategory.flatMap((group) => group.tools);
const ACCEPT = [acceptAttribute(INPUT_FORMATS), '.pdf,application/pdf', audioAcceptAttribute(), MARKDOWN_ACCEPT].join(',');
interface QueueRow {
  readonly id: string;
  readonly file: File;
  readonly kind?: FileKind | null;
  readonly output?: ImageFormat | AudioFormat;
  readonly message?: string;
  /** Hinweis, wenn die Endung nicht zum erkannten Inhalt passt. */
  readonly note?: string;
}
interface Secondary { readonly tool: Tool; readonly files: File[] }
const STATUS = { checking: 'Wird geprüft …', ready: 'Bereit', invalid: 'Nicht verarbeitbar', uploading: 'Wird hochgeladen …', queued: 'Wartet …', processing: 'Wird verarbeitet …', done: 'Fertig', error: 'Fehlgeschlagen' };

export default function QuickStart() {
  const image = useImageBatch();
  const audio = useAudioBatch();
  const [rows, setRows] = useState<readonly QueueRow[]>([]);
  const rowsRef = useRef<readonly QueueRow[]>([]);
  const [secondary, setSecondary] = useState<Secondary | null>(null);
  const secondaryRef = useRef<Secondary | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const alive = useRef(false);
  const nextId = useRef(1);
  const routed = useRef(new Set<string>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const secondaryHeadingRef = useRef<HTMLHeadingElement>(null);
  const updateRows = (fn: (previous: readonly QueueRow[]) => readonly QueueRow[]) => {
    rowsRef.current = fn(rowsRef.current);
    setRows(rowsRef.current);
  };
  useEffect(() => { alive.current = true; setHydrated(true); return () => { alive.current = false; }; }, []);

  // Ein Hash ohne gewählte Dateien führt ins Leere: entfernen, statt eine tote Adresse zu behalten.
  useEffect(() => { if (location.hash) history.replaceState(null, '', location.pathname + location.search); }, []);

  // Browser-Zurück/-Vor zwischen Auswahl und Werkzeug, solange die Dateien noch im Speicher sind.
  // Die Auswahl ist nun die unverändert montierte Dateiliste; Vor stellt das zuletzt geöffnete Werkzeug wieder her.
  useEffect(() => {
    const onPop = () => {
      const previous = secondaryRef.current;
      setSecondary(previous && location.hash === `#${previous.tool.id}` ? previous : null);
      requestAnimationFrame(() => (location.hash ? secondaryHeadingRef : headingRef).current?.focus());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const imageFormats = image.support.status === 'ready' ? OUTPUT_FORMATS.filter(format => image.support.status === 'ready' && image.support.encode[format]) : [];
  const audioFormats = audio.support.status === 'ready' ? audio.limits.outputFormats : [];
  const formatsFor = (row: QueueRow): readonly (ImageFormat | AudioFormat)[] => row.kind === 'image' ? imageFormats : row.kind === 'audio' ? audioFormats : [];
  const outputFor = (row: QueueRow) => {
    const formats = formatsFor(row);
    return row.output && formats.includes(row.output) ? row.output : formats[0];
  };
  const entryFor = (row: QueueRow) => row.kind === 'image' ? image.entries.find(entry => entry.file === row.file) : row.kind === 'audio' ? audio.entries.find(entry => entry.file === row.file) : undefined;
  const canProcess = (row: QueueRow) => {
    if (row.message) return false;
    const entry = entryFor(row);
    const output = outputFor(row);
    return Boolean(entry && output && isProcessable(entry) && (entry.status !== 'done' || entry.result?.format !== output));
  };
  const addFiles = (files: File[]) => {
    const capacity = image.support.status === 'ready' || audio.support.status === 'ready' ? Math.max(0, Math.min(image.limits.maxFiles, audio.limits.maxFiles) - rowsRef.current.length) : Infinity;
    // Eine eigene File-Identität je Auswahl hält auch gleichnamige und erneut gewählte Dateien auseinander.
    const created: QueueRow[] = files.map((file, index) => ({ id: `home-${nextId.current++}`, file: new File([file], file.name, { type: file.type, lastModified: file.lastModified }), ...(index >= capacity ? { kind: null, message: `Die Stapelgrenze von ${Math.min(image.limits.maxFiles, audio.limits.maxFiles)} Dateien ist erreicht. Entfernen Sie zuerst Dateien.` } : {}) }));
    updateRows(previous => [...previous, ...created]);
    headingRef.current?.focus();
    for (const row of created) {
      if (row.message) continue;
      void detectFile(row.file).then(detection => {
        if (!alive.current || !rowsRef.current.some(entry => entry.id === row.id)) return;
        const note = extensionNote(row.file.name, detection);
        updateRows(previous => previous.map(entry => entry.id === row.id ? { ...entry, kind: detection.kind, ...(note ? { note } : {}) } : entry));
      });
    }
  };
  // Erst nach der Fähigkeitsantwort an die Hooks übergeben: deren Prüfung nutzt so die echten Servergrenzen.
  useEffect(() => {
    const limit = Math.min(image.limits.maxFiles, audio.limits.maxFiles);
    rows.forEach((row, index) => {
      if (row.message) return;
      if (index >= limit && (image.support.status === 'ready' || audio.support.status === 'ready')) {
        updateRows(previous => previous.map(entry => entry.id === row.id ? { ...entry, message: `Die Stapelgrenze von ${limit} Dateien ist erreicht. Entfernen Sie zuerst Dateien.` } : entry));
        return;
      }
      if (routed.current.has(row.id) || !row.kind) return;
      const support = row.kind === 'image' ? image.support : row.kind === 'audio' ? audio.support : null;
      if (!support || support.status === 'checking') return;
      routed.current.add(row.id);
      const outcome = index < limit ? (row.kind === 'image' ? image.addFiles([row.file]) : audio.addFiles([row.file])) : null;
      if (!outcome || outcome.rejected.length) {
        updateRows(previous => previous.map(entry => entry.id === row.id ? { ...entry, message: `Die Stapelgrenze von ${limit} Dateien ist erreicht. Entfernen Sie zuerst Dateien.` } : entry));
      }
    });
  }, [rows, image.support, audio.support, image.limits.maxFiles, audio.limits.maxFiles, image.addFiles, audio.addFiles]);
  const remove = (row: QueueRow) => {
    const entry = entryFor(row);
    if (entry) { if (row.kind === 'image') image.remove(entry.id); else audio.remove(entry.id); }
    const index = rowsRef.current.findIndex(entry => entry.id === row.id);
    updateRows(previous => previous.filter(entry => entry.id !== row.id));
    routed.current.delete(row.id);
    requestAnimationFrame(() => {
      const remaining = rowsRef.current;
      if (!remaining.length) pickRef.current?.focus();
      else document.getElementById(`remove-${remaining[Math.min(index, remaining.length - 1)]!.id}`)?.focus();
    });
  };
  const openTool = (id: string, file: File) => {
    const tool = availableTools.find(entry => entry.id === id)!;
    const next = { tool, files: [file] };
    secondaryRef.current = next;
    history.pushState(null, '', `#${id}`);
    setSecondary(next);
    requestAnimationFrame(() => secondaryHeadingRef.current?.focus());
  };
  const closeTool = () => {
    history.pushState(null, '', location.pathname + location.search);
    setSecondary(null);
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  const process = async () => {
    if (runningRef.current) return;
    const selected = rows.filter(canProcess);
    if (!selected.length) return;
    const outputs = new Map(selected.map(row => [row.file, outputFor(row)!]));
    runningRef.current = true; setRunning(true);
    try {
      // Typen nacheinander starten: jeder Hook respektiert bereits die Server-Parallelitätsgrenze.
      await image.processAll(entry => ({ format: outputs.get(entry.file) as ImageFormat, quality: 0.85, background: '#ffffff', resize: { mode: 'none' }, icoSizes: DEFAULT_ICO_SIZES }), (entry, options) => entry.probe?.format === options.format ? 'konvertiert' : '', entry => outputs.has(entry.file));
      await audio.processAll(entry => ({ format: outputs.get(entry.file) as AudioFormat, quality: audio.limits.defaultQuality * 100, channels: 'original' }), entry => outputs.has(entry.file));
    } finally { runningRef.current = false; if (alive.current) setRunning(false); }
  };
  const ToolView = secondary ? TOOL_COMPONENTS[secondary.tool.id] : null;
  return (
    <>
      <div hidden={Boolean(secondary)}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pt-4 sm:pt-10">
          <div className="text-center">
            <h1 ref={headingRef} tabIndex={-1} className="page-title outline-none">Dateien umwandeln</h1>
            <p className="page-lead mx-auto">Legen Sie Dateien ab und wählen Sie direkt die Ausgabe. Hochgeladen wird erst nach „Konvertieren“.</p>
          </div>
          <DropZone variant={rows.length ? 'default' : 'hero'} accept={ACCEPT} disabled={!hydrated || running} buttonRef={pickRef} buttonLabel={rows.length ? 'Weitere Dateien hinzufügen' : 'Dateien auswählen'} onFiles={addFiles} title="Dateien hierher ziehen">
            <p>Bilder, PDF, Audio und Markdown (.md, .markdown, UTF-8). Die Erkennung läuft in Ihrem Browser; hochgeladen wird erst, wenn Sie ausdrücklich starten. Höchstens {Math.min(image.limits.maxFiles, audio.limits.maxFiles)} Dateien; Bilder bis {formatBytes(image.limits.maxFileBytes)}, Audio bis {formatBytes(audio.limits.maxFileBytes)}, Markdown bis 2 MB.</p>
          </DropZone>
          {rows.length > 0 && <section aria-label="Ausgewählte Dateien" className="flex min-w-0 flex-col gap-4">
            <h2 className="text-lg font-semibold">Dateien und Ausgabe</h2>
            <ul className="m-0 flex min-w-0 list-none flex-col gap-4 p-0">
              {rows.map(row => {
                const entry = entryFor(row);
                const status = entry?.status ?? (!row.message && (row.kind === undefined || row.kind === 'image' || row.kind === 'audio') ? 'checking' : 'invalid');
                const formats = formatsFor(row);
                const input = row.kind === 'image' && image.entries.find(entry => entry.file === row.file)?.probe?.format;
                const audioInput = row.kind === 'audio' && audio.entries.find(entry => entry.file === row.file)?.inputFormat;
                const imageError = entry?.error === 'file-too-large' ? `Die Datei ist zu groß. Erlaubt sind höchstens ${formatBytes(image.limits.maxFileBytes)} pro Bild.` : entry?.error === 'dimensions-too-large' ? `Das Bild überschreitet die erlaubten ${image.limits.maxEdge} Pixel je Kante oder ${image.limits.maxPixels} Pixel insgesamt.` : entry?.error ? imageErrorMessage(entry.error) : undefined;
                const message = row.message ?? entry?.serverError ?? imageError ?? (row.kind === null ? 'Dateityp nicht erkannt oder nicht unterstützt. Unterstützt werden Bilder, PDF, Audio (MP3, WAV, FLAC, OGG) und Markdown (.md, .markdown in UTF-8).' : row.kind === 'pdf' ? 'PDF: Komprimierung im zusätzlichen Werkzeug verfügbar.' : row.kind === 'markdown' ? 'Markdown: PDF-Erstellung im zusätzlichen Werkzeug verfügbar.' : undefined);
                const unsupported = row.kind === 'image' ? image.support.status === 'unsupported' || (image.support.status === 'ready' && !imageFormats.length) : row.kind === 'audio' && audio.support.status === 'unsupported';
                return <li key={row.id} data-status={status} className="file-row flex min-w-0 flex-col gap-3 rounded-lg border border-border p-4 text-left sm:flex-row sm:flex-wrap sm:items-start">
                  <div className="min-w-0 flex-1">
                    <p className="break-all font-semibold">{row.file.name}</p>
                    <p className="text-sm text-muted">{formatBytes(row.file.size)} · {row.kind ? kindLabel(row.kind) : 'Datei'}{input ? ` · ${formatLabel(input)}` : audioInput ? ` · ${AUDIO_FORMAT_INFO[audioInput].label}` : ''}</p>
                    <p role="status" className="text-sm">{row.kind === 'pdf' ? 'PDF erkannt' : row.kind === 'markdown' ? 'Markdown erkannt' : STATUS[status]}</p>
                    {row.note && !message && <p className="hint break-words">{row.note}</p>}
                    {message && <p className="hint break-words">{message}</p>}
                    {unsupported && <p className="hint">Die Konvertierung ist derzeit nicht verfügbar. Bitte laden Sie die Seite später erneut.</p>}
                    {entry?.resultUrl && <p className="mt-2 break-all"><a className="link" href={entry.resultUrl} download={entry.outputName}>Download: {entry.outputName}</a> {entry.result && <span className="text-sm text-muted">({formatBytes(entry.result.size)})</span>}</p>}
                  </div>
                  {formats.length > 0 && !row.message && status !== 'invalid' && <div className="flex min-w-0 flex-col gap-1">
                    <label htmlFor={`output-${row.id}`} className="text-sm font-medium">Ausgabe<span className="sr-only"> für {row.file.name}</span></label>
                    <select id={`output-${row.id}`} className="select max-w-full" value={outputFor(row)} disabled={running || status === 'checking'} onChange={event => updateRows(previous => previous.map(entry => entry.id === row.id ? { ...entry, output: event.target.value as ImageFormat | AudioFormat } : entry))}>
                      {formats.map(format => <option key={format} value={format}>{row.kind === 'image' ? formatLabel(format as ImageFormat) : AUDIO_FORMAT_INFO[format as AudioFormat].label}</option>)}
                    </select>
                  </div>}
                  <button id={`remove-${row.id}`} type="button" className="btn btn-ghost shrink-0 self-start" aria-label={`${row.file.name} entfernen`} onClick={() => remove(row)}>Entfernen</button>
                  {row.kind === 'image' && !row.message && status !== 'invalid' && <div className="flex w-full flex-wrap gap-3"><button type="button" className="btn btn-ghost" disabled={running} onClick={() => openTool('bilder-komprimieren', row.file)}>Komprimieren</button><button type="button" className="btn btn-ghost" disabled={running} onClick={() => openTool('bilder-skalieren', row.file)}>Skalieren</button></div>}
                  {row.kind === 'pdf' && !row.message && <button type="button" className="btn btn-secondary" disabled={running} onClick={() => openTool('pdf-komprimieren', row.file)}>PDF komprimieren</button>}
                  {row.kind === 'pdf' && !row.message && <button type="button" className="btn btn-secondary" disabled={running} onClick={() => openTool('pdf-zu-bild', row.file)}>PDF zu Bild</button>}
                  {row.kind === 'markdown' && !row.message && <button type="button" className="btn btn-secondary" disabled={running} onClick={() => openTool('markdown-pdf', row.file)}>PDF erstellen</button>}
                </li>;
              })}
            </ul>
            <button type="button" className="btn btn-primary self-start" disabled={running || !rows.some(canProcess)} onClick={() => void process()}>Konvertieren</button>
            <p role="status" className="hint">{running ? 'Dateien werden konvertiert …' : `${rows.filter(row => entryFor(row)?.status === 'done').length} von ${rows.length} Dateien fertig.`}</p>
          </section>}
          <nav aria-label="Werkzeuge im Überblick" className="text-sm text-muted"><ul className="m-0 flex list-none flex-wrap justify-center gap-x-5 gap-y-1 p-0">{LINKED_TOOLS.map(tool => <li key={tool.id}><a href={tool.href} className="link inline-flex min-h-11 items-center">{tool.title}</a></li>)}</ul></nav>
        </div>
      </div>
      {secondary && ToolView && <div className="flex flex-col gap-6">
        <div><button type="button" className="btn btn-ghost" onClick={closeTool}>← Zur Dateiliste</button></div>
        <div><h1 ref={secondaryHeadingRef} tabIndex={-1} className="page-title outline-none">{secondary.tool.title}</h1><p className="page-lead">{secondary.tool.lead}</p></div>
        <div className="page-section mt-4 sm:mt-6"><Suspense fallback={<p role="status" className="hint">Werkzeug wird geladen …</p>}><ToolView initialFiles={secondary.files} /></Suspense></div>
      </div>}
    </>
  );
}
