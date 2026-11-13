/** Anzeige von Audiodetails: Dauer, Abtastrate und Kanäle. */

const NBSP = ' ';
const kilohertz = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/**
 * Dauer als „mm:ss“ (Minuten ohne Obergrenze, z. B. „75:00“), auf ganze Sekunden gerundet.
 * Von null verschiedene Dauern unter einer halben Sekunde erscheinen als „00:01“, nie als „00:00“.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`Ungültige Dauer: ${seconds}`);
  const total = seconds > 0 ? Math.max(1, Math.round(seconds)) : 0;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** Lesbare Dauer für Hilfstexte, z. B. „30 Minuten“ oder „90 Sekunden“. */
export function formatDurationLimit(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes}${NBSP}${minutes === 1 ? 'Minute' : 'Minuten'}`;
  }
  return `${seconds}${NBSP}${seconds === 1 ? 'Sekunde' : 'Sekunden'}`;
}

/** Abtastrate in kHz, deutsch formatiert, z. B. 44100 → „44,1 kHz“, 48000 → „48 kHz“. */
export function formatSampleRate(hertz: number): string {
  if (!Number.isFinite(hertz) || hertz <= 0) throw new RangeError(`Ungültige Abtastrate: ${hertz}`);
  return `${kilohertz.format(hertz / 1000)}${NBSP}kHz`;
}

/** Kanalzahl: 1 → „Mono“, 2 → „Stereo“, sonst „n Kanäle“. */
export function formatChannels(channels: number): string {
  if (!Number.isInteger(channels) || channels < 1) throw new RangeError(`Ungültige Kanalzahl: ${channels}`);
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}${NBSP}Kanäle`;
}
