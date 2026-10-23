import { FORMAT_INFO, type ImageFormat } from './types';

/** Maximale Länge des Namensstamms (ohne Suffix und Endung) in Zeichen. */
const MAX_BASE_LENGTH = 100;
const FALLBACK_BASE = 'bild';

/** Ersetzt Pfadtrenner, unter Windows unzulässige Zeichen und Steuerzeichen; trimmt Leerraum und Punkte. */
function sanitize(part: string): string {
  return (
    part
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      // Bidi-Steuerzeichen (könnten z. B. eine andere Endung vortäuschen)
      .replace(/[؜‎‏‪-‮⁦-⁩]/g, '')
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
  );
}

/** Unter Windows reservierte Gerätenamen. */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function avoidReservedName(base: string): string {
  return RESERVED_WINDOWS_NAMES.test(base) ? `_${base}` : base;
}

/** Kürzt auf höchstens max Zeichen, ohne Ersatzpaare (Emoji etc.) zu zerteilen. */
function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('').replace(/[\s.]+$/, '');
}

/** Entfernt die letzte Endung (".png"), nicht aber einen führenden Punkt. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Baut den Ausgabenamen, z. B. ("Urlaub.PNG", 'webp', 'konvertiert') -> "Urlaub-konvertiert.webp".
 * Pfadtrenner und unzulässige Zeichen werden durch "_" ersetzt, Steuer- und Bidi-Zeichen entfernt,
 * reservierte Windows-Namen (CON, NUL, COM1 …) mit "_" versehen.
 */
export function buildOutputFileName(originalName: string, format: ImageFormat, suffix: string): string {
  const raw = typeof originalName === 'string' ? originalName : '';
  const base = avoidReservedName(truncate(sanitize(stripExtension(raw)), MAX_BASE_LENGTH) || FALLBACK_BASE);
  const cleanSuffix = truncate(sanitize(typeof suffix === 'string' ? suffix : ''), 40);
  return `${base}${cleanSuffix ? `-${cleanSuffix}` : ''}.${FORMAT_INFO[format].extension}`;
}

/**
 * Macht Namen im Stapel eindeutig (Vergleich ohne Groß-/Kleinschreibung):
 * ["a.webp", "A.webp"] -> ["a.webp", "A-2.webp"]. Reihenfolge bleibt erhalten.
 */
export function makeUniqueFileNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let counter = 2;
      do {
        candidate = `${stem}-${counter}${ext}`;
        counter++;
      } while (taken.has(candidate.toLowerCase()));
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
