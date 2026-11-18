/**
 * Typerkennung und Aktionswahl der Startseite. Gelesen werden nur die ersten Bytes jeder Datei,
 * Bilder, PDF und Audio werden an der Signatur erkannt. Markdown benötigt eine passende Endung
 * und gültigen UTF-8-Text. Alles bleibt lokal und ohne Upload.
 * Die Aktionen je Typ kommen aus dem Werkzeugkatalog.
 */
import { availableTools, TOOL_ACTIONS, type Tool, type ToolCategory } from '../data/tools';
import { detectFormat } from './image/sniff';
import { findPdfSignature } from './pdf/signature';
import { AUDIO_SNIFF_BYTES, sniffAudio } from './audio/sniff';
import { checkMarkdownFile } from './markdown';

export type FileKind = 'image' | 'pdf' | 'audio' | 'markdown';

/** Gruppen in fester Reihenfolge der Anzeige. */
export const FILE_KINDS: readonly FileKind[] = ['image', 'pdf', 'audio', 'markdown'];

const KIND_INFO: Readonly<Record<FileKind, { label: string; category: ToolCategory }>> = {
  image: { label: 'Bild', category: 'bilder' },
  pdf: { label: 'PDF', category: 'pdf' },
  audio: { label: 'Audio', category: 'audio' },
  markdown: { label: 'Markdown', category: 'pdf' },
};

/** Anzeigename des Typs (Einzahl). */
export function kindLabel(kind: FileKind): string {
  return KIND_INFO[kind].label;
}

/** Erkennt den Typ an den Kopfbytes; sonst null. */
export function detectKindFromHead(head: Uint8Array): FileKind | null {
  if (detectFormat(head)) return 'image';
  if (findPdfSignature(head) >= 0) return 'pdf';
  if (sniffAudio(head)) return 'audio';
  return null;
}

/** Prüft Kopfbytes; für Markdown zusätzlich die gesamte Quelle bis 2 MiB. Unlesbares bleibt unbekannt. */
export async function detectFileKind(file: File): Promise<FileKind | null> {
  try {
    const head = new Uint8Array(await file.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
    const signed = detectKindFromHead(head);
    if (signed) return signed;
    return /\.(md|markdown)$/i.test(file.name) && (await checkMarkdownFile(file)).ok ? 'markdown' : null;
  } catch {
    return null;
  }
}

/** Eigene Eingabe (Markdown) oder mehrere Bilder zu einem Ergebnis (Bild zu PDF): nie als Aktion für eine PDF-Datei. */
const NOT_FOR_SINGLE_FILE: ReadonlySet<string> = new Set(['markdown-pdf', 'image-pdf']);

/** Werkzeuge, die zu einem Dateityp passen, in Reihenfolge Konvertieren, Komprimieren, Skalieren. */
export function toolsForKind(kind: FileKind): Tool[] {
  if (kind === 'markdown') return availableTools.filter((tool) => tool.id === 'markdown-pdf');
  const { category } = KIND_INFO[kind];
  return TOOL_ACTIONS.flatMap((action) =>
    availableTools.filter((tool) => tool.category === category && tool.action === action.id && !NOT_FOR_SINGLE_FILE.has(tool.id)),
  );
}

/** Beschriftung des Aktions-Buttons („Konvertieren“, „Komprimieren“, „Skalieren“). */
export function actionLabel(tool: Tool): string {
  return TOOL_ACTIONS.find((action) => action.id === tool.action)?.title ?? tool.title;
}

export interface ClassifiedFile {
  readonly file: File;
  readonly kind: FileKind | null;
}

export interface KindGroup {
  readonly kind: FileKind;
  readonly files: File[];
  readonly tools: Tool[];
}

export interface Classification {
  /** Erkannte Typen, nicht leer, in fester Reihenfolge. */
  readonly groups: KindGroup[];
  /** Dateien ohne erkannten Typ. */
  readonly unknown: File[];
}

/** Sortiert erkannte Dateien nach Typ. Gruppen ohne Werkzeug entfallen. */
export function groupFiles(items: readonly ClassifiedFile[]): Classification {
  const groups: KindGroup[] = [];
  for (const kind of FILE_KINDS) {
    const files = items.filter((item) => item.kind === kind).map((item) => item.file);
    const tools = toolsForKind(kind);
    if (files.length > 0 && tools.length > 0) groups.push({ kind, files, tools });
  }
  const grouped = new Set(groups.flatMap((group) => group.files));
  return { groups, unknown: items.map((item) => item.file).filter((file) => !grouped.has(file)) };
}

/** Erkennt alle Dateien (nacheinander, um den Speicherbedarf klein zu halten) und gruppiert sie. */
export async function classifyFiles(files: readonly File[]): Promise<Classification> {
  const items: ClassifiedFile[] = [];
  for (const file of files) items.push({ file, kind: await detectFileKind(file) });
  return groupFiles(items);
}
