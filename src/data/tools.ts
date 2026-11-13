/**
 * Werkzeugverzeichnis. Kopfzeile und Startseite zeigen nur Einträge mit `available: true`,
 * damit keine Links auf noch nicht vorhandene Seiten veröffentlicht werden.
 * Ein Werkzeug erst freischalten, wenn seine Seite unter `href` existiert.
 */

export type ToolCategory = 'bilder' | 'pdf' | 'audio';
export type ToolOperation = 'konvertieren' | 'komprimieren' | 'skalieren';
/** Aktion, nach der die Kopfzeile die Werkzeuge in Menüs gruppiert. */
export type ToolAction = 'convert' | 'compress' | 'resize';

export interface ToolActionInfo {
  readonly id: ToolAction;
  /** Menübeschriftung der Aktion. */
  readonly title: string;
}

export interface ToolCategoryInfo {
  readonly id: ToolCategory;
  /** Anzeigename der Kategorie. */
  readonly title: string;
}

export interface Tool {
  /** Eindeutige Kennung. */
  readonly id: string;
  /** Kurzer Titel, auch als Navigationsbeschriftung verwendet. */
  readonly title: string;
  /** Ein Satz, was das Werkzeug tut. */
  readonly description: string;
  /** Pfad der Werkzeugseite (ohne abschließenden Schrägstrich). */
  readonly href: `/${string}`;
  readonly category: ToolCategory;
  readonly operation: ToolOperation;
  /** Menügruppe in der Kopfzeile. */
  readonly action: ToolAction;
  /** Nur verfügbare Werkzeuge werden verlinkt. */
  readonly available: boolean;
}

export const TOOL_CATEGORIES: readonly ToolCategoryInfo[] = [
  { id: 'bilder', title: 'Bilder' },
  { id: 'pdf', title: 'PDF' },
  { id: 'audio', title: 'Audio' },
];

/** Reihenfolge der Menüs in der Kopfzeile. */
export const TOOL_ACTIONS: readonly ToolActionInfo[] = [
  { id: 'convert', title: 'Konvertieren' },
  { id: 'compress', title: 'Komprimieren' },
  { id: 'resize', title: 'Skalieren' },
];

export const TOOLS: readonly Tool[] = [
  {
    id: 'pdf-komprimieren',
    title: 'PDF komprimieren',
    description: 'Drei Qualitätsstufen auf dem Server berechnen und tatsächliche Dateigrößen vergleichen.',
    href: '/pdf/komprimieren',
    category: 'pdf',
    operation: 'komprimieren',
    action: 'compress',
    available: true,
  },
  {
    id: 'bilder-konvertieren',
    title: 'Bilder konvertieren',
    description: 'JPEG, PNG, WebP, BMP und ICO erzeugen.',
    href: '/bilder/konvertieren',
    category: 'bilder',
    operation: 'konvertieren',
    action: 'convert',
    available: true,
  },
  {
    id: 'bilder-komprimieren',
    title: 'Bilder komprimieren',
    description: 'Dateigröße von Bildern über Qualität und Abmessungen verringern.',
    href: '/bilder/komprimieren',
    category: 'bilder',
    operation: 'komprimieren',
    action: 'compress',
    available: true,
  },
  {
    id: 'bilder-skalieren',
    title: 'Bilder skalieren',
    description: 'Bilder auf eine neue Breite oder Höhe bringen oder prozentual verkleinern bzw. vergrößern.',
    href: '/bilder/skalieren',
    category: 'bilder',
    operation: 'skalieren',
    action: 'resize',
    available: true,
  },
  {
    id: 'audio-konvertieren',
    title: 'Audio konvertieren',
    description: 'MP3, WAV, FLAC und OGG ineinander umwandeln, auf Wunsch in Mono.',
    href: '/audio/konvertieren',
    category: 'audio',
    operation: 'konvertieren',
    action: 'convert',
    available: true,
  },
];

/** Alle freigeschalteten Werkzeuge in Listenreihenfolge. */
export const availableTools: readonly Tool[] = TOOLS.filter((tool) => tool.available);

/** Freigeschaltete Werkzeuge nach Kategorie; Kategorien ohne verfügbares Werkzeug entfallen. */
export const availableToolsByCategory: readonly { category: ToolCategoryInfo; tools: readonly Tool[] }[] =
  TOOL_CATEGORIES.map((category) => ({
    category,
    tools: availableTools.filter((tool) => tool.category === category.id),
  })).filter((group) => group.tools.length > 0);

/**
 * Freigeschaltete Werkzeuge nach Aktion (Menüs der Kopfzeile); Aktionen ohne verfügbares Werkzeug entfallen.
 * Innerhalb einer Aktion gilt die Reihenfolge von `TOOL_CATEGORIES` (Bilder, PDF, Audio).
 */
export const availableToolsByAction: readonly { action: ToolActionInfo; tools: readonly Tool[] }[] =
  TOOL_ACTIONS.map((action) => ({
    action,
    tools: TOOL_CATEGORIES.flatMap((category) =>
      availableTools.filter((tool) => tool.action === action.id && tool.category === category.id),
    ),
  })).filter((group) => group.tools.length > 0);
