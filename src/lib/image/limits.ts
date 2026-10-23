/** Grenzwerte des Verarbeitungskerns (siehe docs/implementation-plan.md). */
export const LIMITS = {
  /** Maximale Dateigröße pro Eingabedatei in Bytes (50 MB). */
  maxFileBytes: 50 * 1024 * 1024,
  /** Maximale Pixelanzahl für Eingabe und Ausgabe (40 Megapixel). */
  maxPixels: 40_000_000,
  /** Maximale Kantenlänge in Pixeln für Eingabe und Ausgabe. */
  maxEdge: 16_384,
  /** Maximale Anzahl Dateien pro Stapel. */
  maxFiles: 30,
  /**
   * Maximale Größe einer BMP-Ausgabe in Bytes (100 MB). BMP ist unkomprimiert (24 bit ≈ 3 Byte/Pixel);
   * beim Zusammensetzen liegen Pixeldaten kurzzeitig doppelt im Speicher. Entspricht ca. 34 MP.
   */
  maxBmpOutputBytes: 100 * 1024 * 1024,
} as const;

/** Dateigröße eines 24-bit-BMP (54 Byte Kopf, Zeilen auf 4 Byte aufgefüllt). */
export function bmpFileSize(width: number, height: number): number {
  return 54 + Math.ceil((width * 3) / 4) * 4 * height;
}

/** Teilmenge von Navigator/WorkerNavigator, die für die Parallelität ausgewertet wird. */
export interface ConcurrencyHints {
  readonly deviceMemory?: unknown;
  readonly hardwareConcurrency?: unknown;
}

/** Ob die Abmessungen innerhalb von LIMITS liegen. */
export function isWithinPixelLimits(width: number, height: number): boolean {
  return width <= LIMITS.maxEdge && height <= LIMITS.maxEdge && width * height <= LIMITS.maxPixels;
}

/**
 * Anzahl gleichzeitiger Verarbeitungen: 2, aber 1 bei wenig Speicher (deviceMemory ≤ 4)
 * oder wenigen Kernen (hardwareConcurrency ≤ 4). Fehlende oder unplausible Angaben werden ignoriert.
 */
export function getConcurrency(hints?: ConcurrencyHints | null): number {
  const nav: ConcurrencyHints | undefined =
    hints ?? (globalThis as { navigator?: ConcurrencyHints }).navigator ?? undefined;
  const memory = nav?.deviceMemory;
  const cores = nav?.hardwareConcurrency;
  if (typeof memory === 'number' && Number.isFinite(memory) && memory > 0 && memory <= 4) return 1;
  if (typeof cores === 'number' && Number.isFinite(cores) && cores > 0 && cores <= 4) return 1;
  return 2;
}
