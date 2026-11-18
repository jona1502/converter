/**
 * Werkzeugverzeichnis. Kopfzeile und Startseite zeigen nur Einträge mit `available: true`,
 * damit keine Links auf noch nicht vorhandene Seiten veröffentlicht werden.
 * Ein Werkzeug erst freischalten, wenn seine Seite unter `href` existiert.
 */

export type ToolCategory = 'bilder' | 'pdf' | 'audio';
export type ToolOperation = 'konvertieren' | 'komprimieren' | 'skalieren' | 'drehen' | 'teilen' | 'zusammenfuehren';
/** Aktion, nach der die Kopfzeile die Werkzeuge in Menüs gruppiert. */
export type ToolAction = 'convert' | 'compress' | 'resize' | 'rotate' | 'split' | 'merge';

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
  /** Ein Satz unter der Seitenüberschrift, auf der Werkzeugseite und in der Startseite gleich. */
  readonly lead: string;
  /** Pfad der Werkzeugseite (ohne abschließenden Schrägstrich). */
  readonly href: `/${string}`;
  readonly category: ToolCategory;
  readonly operation: ToolOperation;
  /** Menügruppe in der Kopfzeile. */
  readonly action: ToolAction;
  /** Nur verfügbare Werkzeuge werden verlinkt. */
  readonly available: boolean;
  /** `false`: nicht auf der Startseiten-Schnellwahl anbieten (eigene Seite mit Einstellungen nötig). */
  readonly quickStart?: boolean;
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
  { id: 'rotate', title: 'Drehen' },
  { id: 'split', title: 'Teilen' },
  { id: 'merge', title: 'Zusammenführen' },
];

export const TOOLS: readonly Tool[] = [
  {
    id: 'markdown-pdf',
    title: 'Markdown zu PDF',
    description: 'Markdown-Dateien als PDF mit auswählbarem Text ausgeben.',
    lead: 'Erstellen Sie aus einer Markdown-Datei eine PDF mit auswählbarem Text, wahlweise A4 oder US Letter im Hoch- oder Querformat.',
    href: '/pdf/markdown',
    category: 'pdf',
    operation: 'konvertieren',
    action: 'convert',
    available: true,
  },
  {
    id: 'pdf-komprimieren',
    title: 'PDF komprimieren',
    description: 'Drei Qualitätsstufen auf dem Server berechnen und tatsächliche Dateigrößen vergleichen.',
    lead: 'Lassen Sie drei Varianten Ihrer PDF berechnen und die tatsächlichen Dateigrößen vergleichen; auch größere Ergebnisse sind möglich.',
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
    lead: 'Wandeln Sie Bilder in JPEG, PNG, WebP, BMP oder ICO um; die Ausgabeformate richten sich nach den Funktionen des Servers.',
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
    lead: 'Wählen Sie Format, Qualität und bei Bedarf kleinere Abmessungen und vergleichen Sie die tatsächlichen Dateigrößen; eine kleinere Datei ist nicht garantiert.',
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
    lead: 'Ändern Sie die Abmessungen Ihrer Bilder in Prozent oder Pixeln; das Seitenverhältnis bleibt auf Wunsch erhalten, eine Vergrößerung müssen Sie ausdrücklich erlauben.',
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
    lead: 'Wandeln Sie MP3, WAV, FLAC und OGG ineinander um; die Abtastrate bleibt erhalten, Tags und Cover werden nicht übernommen.',
    href: '/audio/konvertieren',
    category: 'audio',
    operation: 'konvertieren',
    action: 'convert',
    available: true,
  },
  {
    id: 'pdf-drehen',
    title: 'PDF drehen',
    description: 'Alle oder ausgewählte Seiten einer PDF um 90°, 180° oder 270° drehen.',
    lead: 'Drehen Sie alle oder ausgewählte Seiten Ihrer PDF; Inhalt und Qualität bleiben unverändert, nur der Drehwinkel der Seiten ändert sich.',
    href: '/pdf/drehen',
    category: 'pdf',
    operation: 'drehen',
    action: 'rotate',
    available: true,
  },
  {
    id: 'pdf-teilen',
    title: 'PDF teilen',
    description: 'Seitenbereiche einer PDF herauslösen oder jede Seite einzeln ausgeben.',
    lead: 'Teilen Sie eine PDF in Seitenbereiche wie 1-3,5,7- oder in einzelne Seiten; ein Bereich ergibt eine PDF, mehrere ein ZIP.',
    href: '/pdf/teilen',
    category: 'pdf',
    operation: 'teilen',
    action: 'split',
    available: true,
    quickStart: false,
  },
  {
    id: 'pdf-zusammenfuehren',
    title: 'PDF zusammenführen',
    description: 'Zwei bis zwanzig PDFs in wählbarer Reihenfolge zu einer PDF verbinden.',
    lead: 'Fügen Sie mehrere PDFs in der gewünschten Reihenfolge zu einer einzigen PDF zusammen; die Seiten bleiben unverändert.',
    href: '/pdf/zusammenfuehren',
    category: 'pdf',
    operation: 'zusammenfuehren',
    action: 'merge',
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

/** Katalogeintrag zur Kennung; wirft bei unbekannter Kennung, damit Tippfehler beim Bauen auffallen. */
export function getTool(id: string): Tool {
  const tool = TOOLS.find((entry) => entry.id === id);
  if (!tool) throw new Error(`Unbekanntes Werkzeug: ${id}`);
  return tool;
}
