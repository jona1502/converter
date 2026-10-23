/**
 * Wiederverwendbare Optionsbausteine der Bildwerkzeuge. Fähigkeiten (Qualität, Transparenz)
 * werden aus FORMAT_INFO abgeleitet, Kodierbarkeit aus EncodeSupport.
 */
import { useId } from 'react';
import { FORMAT_INFO, ICO_SIZES, type IcoSize, type EncodeSupport, type ImageFormat } from '../../lib/image';
import { formatLabel, joinGerman, OUTPUT_FORMATS } from './formats';

export function IcoSizes({ value, onChange }: { value: readonly IcoSize[]; onChange: (sizes: readonly IcoSize[]) => void }) {
  return <fieldset className="field">
    <legend className="label">ICO-Größen</legend>
    <div className="flex flex-wrap gap-3">{ICO_SIZES.map(size => <label key={size} className="flex items-center gap-2">
      <input type="checkbox" checked={value.includes(size)} disabled={value.length === 1 && value.includes(size)}
        onChange={event => onChange(event.currentTarget.checked ? [...value, size].sort((a,b) => a-b) : value.filter(item => item !== size))} />
      {size} px
    </label>)}</div>
    <p className="hint">Mindestens eine Größe ist erforderlich.</p>
  </fieldset>;
}

export interface FormatSelectProps {
  readonly value: ImageFormat | null;
  readonly onChange: (format: ImageFormat) => void;
  /** null, solange die Fähigkeitsprüfung läuft. */
  readonly support: EncodeSupport | null;
  readonly formats?: readonly ImageFormat[];
  readonly label?: string;
  readonly disabled?: boolean;
}

export function FormatSelect({
  value,
  onChange,
  support,
  formats = OUTPUT_FORMATS,
  label = 'Zielformat',
  disabled = false,
}: FormatSelectProps) {
  const id = useId();
  const hintId = useId();
  const unsupported = support ? formats.filter((format) => !support[format]) : [];
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value ?? ''}
        disabled={disabled || !support}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.currentTarget.value as ImageFormat)}
      >
        {!value && <option value="">Wird geprüft …</option>}
        {formats.map((format) => {
          const available = !support || support[format];
          return (
            <option key={format} value={format} disabled={!available}>
              {formatLabel(format)} (.{FORMAT_INFO[format].extension}){available ? '' : ' – nicht verfügbar'}
            </option>
          );
        })}
      </select>
      <p id={hintId} className="hint">
        {!support
          ? 'Es wird geprüft, welche Formate Ihr Browser erzeugen kann.'
          : unsupported.length > 0
            ? `${joinGerman(unsupported.map(formatLabel))} kann Ihr Browser nicht erzeugen; ${unsupported.length > 1 ? 'diese Formate sind' : 'das Format ist'} deshalb nicht auswählbar.`
            : 'Alle Formate werden von Ihrem Browser unterstützt.'}
      </p>
    </div>
  );
}

export interface QualitySliderProps {
  readonly format: ImageFormat | null;
  /** Qualität in Prozent (1–100). */
  readonly value: number;
  readonly onChange: (percent: number) => void;
  readonly disabled?: boolean;
}

/** Schieberegler für die Qualität; erscheint nur, wenn sie beim Zielformat wirkt. */
export function QualitySlider({ format, value, onChange, disabled = false }: QualitySliderProps) {
  const id = useId();
  const hintId = useId();
  if (!format) return null;
  const info = FORMAT_INFO[format];
  if (!info.supportsQuality) {
    return (
      <div className="field">
        <p className="label">Qualität</p>
        <p className="hint" data-quality-hint={format}>
          {info.label} wird verlustfrei gespeichert. Eine Qualitätseinstellung wirkt bei diesem Format nicht.
        </p>
      </div>
    );
  }
  return (
    <div className="field">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label">
          Qualität
        </label>
        <output htmlFor={id} className="font-mono text-sm font-semibold">
          {value} %
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="range"
        min={1}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuetext={`${value} %`}
        aria-describedby={hintId}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <p id={hintId} className="hint">
        Niedrigere Werte ergeben kleinere Dateien, aber sichtbarere Kompressionsspuren.
      </p>
    </div>
  );
}

export interface BackgroundColorProps {
  readonly format: ImageFormat | null;
  /** Farbe als #rrggbb. */
  readonly value: string;
  readonly onChange: (color: string) => void;
  readonly disabled?: boolean;
}

/** Hintergrundfarbe für transparente Bereiche; erscheint nur bei Zielformaten ohne Transparenz. */
export function BackgroundColor({ format, value, onChange, disabled = false }: BackgroundColorProps) {
  const id = useId();
  const hintId = useId();
  if (!format || FORMAT_INFO[format].supportsTransparency) return null;
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        Hintergrundfarbe
      </label>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="color"
          className="color-input"
          value={value}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.currentTarget.value.toLowerCase())}
        />
        <span className="font-mono text-sm">
          {value}
        </span>
      </div>
      <p id={hintId} className="hint">
        {FORMAT_INFO[format].label} kann keine Transparenz speichern. Transparente Bereiche werden mit dieser Farbe
        gefüllt.
      </p>
    </div>
  );
}
