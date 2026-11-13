/**
 * Typerkennung und Aktionswahl der Startseite. Gelesen werden nur die ersten Bytes jeder Datei,
 * erkannt wird an der Signatur (nicht an Endung oder MIME-Typ), alles lokal und ohne Upload.
 * Die Aktionen je Typ kommen aus dem Werkzeugkatalog.
 */
import { availableTools, TOOL_ACTIONS, type Tool, type ToolCategory } from '../data/tools';
import { detectFormat } from './image/sniff';
import { findPdfSignature } from './pdf/signature';
import { AUDIO_SNIFF_BYTES, sniffAudio } from './audio/sniff';

export type FileKind = 'image' | 'pdf' | 'audio';

/** Gruppen in fester Reihenfolge der Anzeige. */
export const FILE_KINDS: readonly FileKind[] = ['image', 'pdf', 'audio'];

const KIND_INFO: Readonly<Record<FileKind, { label: string; category: ToolCategory }>> = {
  image: { label: 'Bild', category: 'bilder' },
  pdf: { label: 'PDF', category: 'pdf' },
  audio: { label: 'Audio', category: 'audio' },
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

/** Liest höchstens AUDIO_SNIFF_BYTES und erkennt den Typ. Unlesbare Dateien gelten als unbekannt. */
export async function detectFileKind(file: File): Promise<FileKind | null> {
  try {
    const head = new Uint8Array(await file.slice(0, AUDIO_SNIFF_BYTES).arrayBuffer());
    return detectKindFromHead(head);
  } catch {
    return null;
  }
}

/** Werkzeuge, die zu einem Dateityp passen, in Reihenfolge Konvertieren, Komprimieren, Skalieren. */
export function toolsForKind(kind: FileKind): Tool[] {
  const { category } = KIND_INFO[kind];
  return TOOL_ACTIONS.flatMap((action) =>
    availableTools.filter((tool) => tool.category === category && tool.action === action.id),
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
