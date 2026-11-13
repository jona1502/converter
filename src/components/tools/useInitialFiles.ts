import { useEffect, useRef } from 'react';

/** Gemeinsame Props der Werkzeuge. */
export interface ToolProps {
  /** Dateien der Startseite; laufen wie abgelegte Dateien durch die Vorprüfung. */
  readonly initialFiles?: File[];
}

/**
 * Übergibt von der Startseite vorgewählte Dateien genau einmal an dieselbe Funktion, die auch die
 * eigene Dropzone aufruft (gleiche Vorprüfung, gleiche Meldungen). Gewartet wird, bis der Server
 * seine Grenzen gemeldet hat (`ready`); Upload gibt es weiterhin erst nach ausdrücklichem Start.
 * Ohne Dateien passiert nichts.
 */
export function useInitialFiles(
  ready: boolean,
  initialFiles: readonly File[] | undefined,
  onFiles: (files: File[]) => void,
): void {
  const handlerRef = useRef(onFiles);
  handlerRef.current = onFiles;
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!ready || appliedRef.current || !initialFiles || initialFiles.length === 0) return;
    appliedRef.current = true;
    handlerRef.current([...initialFiles]);
  }, [ready, initialFiles]);
}
