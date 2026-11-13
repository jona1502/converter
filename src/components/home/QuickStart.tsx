/**
 * Startseite: Dateien ablegen, Typ lokal erkennen, Aktion wählen, Werkzeug auf derselben Seite
 * mit den Dateien öffnen (select → choose → tool).
 *
 * Datenschutz: Die Dateien bleiben im Arbeitsspeicher dieses React-Baums und werden an die
 * Werkzeugkomponente als Prop übergeben. Sie werden nicht in Web Storage, IndexedDB oder Cache
 * abgelegt. Hochgeladen wird erst nach ausdrücklichem Start im Werkzeug.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { availableTools, availableToolsByCategory, type Tool } from '../../data/tools';
import { actionLabel, classifyFiles, kindLabel, type Classification, type KindGroup } from '../../lib/quickstart';
import { audioAcceptAttribute } from '../../lib/audio/formats';
import { DropZone } from '../tools/DropZone';
import { acceptAttribute, INPUT_FORMATS } from '../tools/formats';
import type { ToolProps } from '../tools/useInitialFiles';

type ToolComponent = LazyExoticComponent<ComponentType<ToolProps>>;

/** Werkzeugkomponenten werden erst geladen, wenn sie gebraucht werden. */
const TOOL_COMPONENTS: Readonly<Record<string, ToolComponent>> = {
  'bilder-konvertieren': lazy(() => import('../tools/ImageConverter')),
  'bilder-komprimieren': lazy(() => import('../tools/ImageCompressor')),
  'bilder-skalieren': lazy(() => import('../tools/ImageResizer')),
  'pdf-komprimieren': lazy(() => import('../tools/PdfCompressor')),
  'audio-konvertieren': lazy(() => import('../tools/AudioConverter')),
};

/** Textlinks in der Reihenfolge Bilder, PDF, Audio. */
const LINKED_TOOLS = availableToolsByCategory.flatMap((group) => group.tools);

const ACCEPT = [acceptAttribute(INPUT_FORMATS), '.pdf,application/pdf', audioAcceptAttribute()].join(',');

type View =
  | { readonly phase: 'select' }
  | { readonly phase: 'choose'; readonly found: Classification }
  | { readonly phase: 'tool'; readonly found: Classification; readonly tool: Tool; readonly files: File[] };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function filesOf(found: Classification, tool: Tool): File[] | null {
  return found.groups.find((group) => group.tools.some((entry) => entry.id === tool.id))?.files ?? null;
}

function GroupChoice({ group, mixed, onPick }: { group: KindGroup; mixed: boolean; onPick: (tool: Tool, files: File[]) => void }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 border-t border-border pt-5 text-left">
      <h2 id={headingId} className="text-lg font-semibold">
        {mixed ? `${kindLabel(group.kind)}, ` : ''}
        {plural(group.files.length, 'Datei', 'Dateien')}
        <span className="sr-only"> erkannt als {kindLabel(group.kind)}</span>
      </h2>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-muted">
        {group.files.map((file, index) => (
          <li key={`${file.name}-${index}`} className="break-all">
            {file.name} <span className="text-sm">({kindLabel(group.kind)})</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3 pt-2">
        {group.tools.map((tool) => (
          <button key={tool.id} type="button" className="btn btn-primary" aria-describedby={headingId} onClick={() => onPick(tool, group.files)}>
            {actionLabel(tool)}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function QuickStart() {
  const [view, setView] = useState<View>({ phase: 'select' });
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const focusAfterRef = useRef<'heading' | 'picker' | null>(null);
  const runRef = useRef(0);

  useEffect(() => setHydrated(true), []);

  // Ein Hash ohne gewählte Dateien führt ins Leere: entfernen, statt eine tote Adresse zu behalten.
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }, []);

  // Browser-Zurück/-Vor zwischen Auswahl und Werkzeug, solange die Dateien noch im Speicher sind.
  useEffect(() => {
    const onPop = () => {
      const current = viewRef.current;
      if (current.phase === 'select') return;
      const id = location.hash.slice(1);
      const tool = id ? availableTools.find((entry) => entry.id === id) : undefined;
      const files = tool ? filesOf(current.found, tool) : null;
      focusAfterRef.current = 'heading';
      setView(tool && files ? { phase: 'tool', found: current.found, tool, files } : { phase: 'choose', found: current.found });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const target = focusAfterRef.current;
    focusAfterRef.current = null;
    if (target === 'heading') headingRef.current?.focus();
    else if (target === 'picker') pickRef.current?.focus();
  }, [view.phase]);

  const onFiles = useCallback(async (files: File[]) => {
    const run = ++runRef.current;
    setBusy(true);
    const found = await classifyFiles(files);
    if (run !== runRef.current) return;
    setBusy(false);
    focusAfterRef.current = 'heading';
    setView({ phase: 'choose', found });
  }, []);

  const reset = useCallback(() => {
    runRef.current++;
    setBusy(false);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    focusAfterRef.current = 'picker';
    setView({ phase: 'select' });
  }, []);

  const pick = useCallback((found: Classification, tool: Tool, files: File[]) => {
    history.pushState(null, '', `#${tool.id}`);
    focusAfterRef.current = 'heading';
    setView({ phase: 'tool', found, tool, files });
  }, []);

  if (view.phase === 'tool') {
    const ToolView = TOOL_COMPONENTS[view.tool.id]!;
    return (
      <div className="flex flex-col gap-6">
        <div>
          <button type="button" className="btn btn-ghost" onClick={reset}>← Andere Dateien</button>
        </div>
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="page-title outline-none">{view.tool.title}</h1>
          <p className="page-lead">{view.tool.lead}</p>
        </div>
        <div className="page-section mt-4 sm:mt-6">
          <Suspense fallback={<p role="status" className="hint">Werkzeug wird geladen …</p>}>
            <ToolView initialFiles={view.files} />
          </Suspense>
        </div>
      </div>
    );
  }

  if (view.phase === 'choose') {
    const { groups, unknown } = view.found;
    const mixed = groups.length > 1;
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 pt-4 text-center sm:pt-10">
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="page-title outline-none">
            {groups.length === 0 ? 'Dateityp nicht erkannt' : 'Was soll passieren?'}
          </h1>
          <p className="page-lead mx-auto">
            {groups.length === 0
              ? 'Unterstützt werden Bilder, PDF und Audio (MP3, WAV, FLAC, OGG).'
              : mixed
                ? 'Die Dateien gehören zu verschiedenen Typen. Wählen Sie, mit welcher Gruppe Sie weiterarbeiten.'
                : 'Der Typ wurde in Ihrem Browser erkannt. Es wurde noch nichts hochgeladen.'}
          </p>
        </div>
        {groups.map((group) => (
          <GroupChoice key={group.kind} group={group} mixed={mixed} onPick={(tool, files) => pick(view.found, tool, files)} />
        ))}
        {unknown.length > 0 && (
          <div role="status" className="notice notice-warn text-left">
            <p className="notice-title">
              {groups.length === 0 ? 'Nicht erkannt' : `${plural(unknown.length, 'Datei', 'Dateien')} nicht erkannt und nicht übernommen`}
            </p>
            <p className="mt-1 break-all">{unknown.map((file) => file.name).join(', ')}</p>
          </div>
        )}
        <div>
          <button type="button" className={groups.length === 0 ? 'btn btn-primary' : 'btn btn-ghost'} onClick={reset}>Andere Dateien</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8 pt-4 text-center sm:pt-10">
      <div>
        <h1 ref={headingRef} tabIndex={-1} className="page-title outline-none">Dateien umwandeln</h1>
        <p className="page-lead mx-auto">Legen Sie eine Datei ab. Der Browser erkennt den Typ und zeigt, was möglich ist.</p>
      </div>
      <div className="w-full">
        <DropZone
          variant="hero"
          accept={ACCEPT}
          disabled={!hydrated || busy}
          buttonRef={pickRef}
          onFiles={(files) => void onFiles(files)}
          title="Dateien hierher ziehen"
        >
          <p>Bilder, PDF und Audio. Die Erkennung läuft in Ihrem Browser; hochgeladen wird erst, wenn Sie im Werkzeug ausdrücklich starten. Die genauen Grenzen nennt das gewählte Werkzeug.</p>
        </DropZone>
        <p role="status" className="sr-only">{busy ? 'Dateien werden erkannt.' : ''}</p>
      </div>
      <nav aria-label="Werkzeuge im Überblick" className="text-sm text-muted">
        <ul className="m-0 flex list-none flex-wrap justify-center gap-x-5 gap-y-1 p-0">
          {LINKED_TOOLS.map((tool) => (
            <li key={tool.id}>
              <a href={tool.href} className="link inline-flex min-h-11 items-center">{tool.title}</a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
