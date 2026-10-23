import { useEffect, useId, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode, type Ref } from 'react';

export interface DropZoneProps {
  /** Wert für das accept-Attribut des Dateifelds. */
  readonly accept: string;
  /** Mehrfachauswahl (Standard: true). */
  readonly multiple?: boolean;
  /** Deaktiviert Auswahl und Drop (z. B. vor der Hydrierung oder ohne Browserunterstützung). */
  readonly disabled?: boolean;
  /** Erhält die gewählten bzw. abgelegten Dateien. */
  readonly onFiles: (files: File[]) => void;
  /** Überschrift im Ablagebereich. */
  readonly title?: string;
  /** Beschriftung des Auswahl-Buttons. */
  readonly buttonLabel?: string;
  /** Hinweise zu Formaten und Grenzwerten (wird mit dem Button per aria-describedby verknüpft). */
  readonly children?: ReactNode;
  /** Ref auf den Auswahl-Button, z. B. um nach „Alle entfernen“ den Fokus dorthin zu setzen. */
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

function hasFiles(event: DragEvent | ReactDragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Ablagebereich mit echtem, beschriftetem Dateifeld. Das Feld selbst ist visuell versteckt;
 * der Button „Dateien auswählen“ öffnet den Dateidialog und ist per Tastatur erreichbar.
 */
export function DropZone({
  accept,
  multiple = true,
  disabled = false,
  onFiles,
  title = 'Dateien hierher ziehen',
  buttonLabel = 'Dateien auswählen',
  children,
  buttonRef,
}: DropZoneProps) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depthRef = useRef(0);

  // Verhindert, dass der Browser eine knapp neben dem Ablagebereich abgelegte Datei öffnet
  // und damit die Seite samt Auswahl verlässt.
  useEffect(() => {
    const prevent = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const deliver = (list: FileList | null | undefined) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    onFiles(multiple ? files : files.slice(0, 1));
  };

  return (
    <div
      className="drop-zone"
      data-dragging={dragging ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      onDragEnter={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        depthRef.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        if (disabled) return;
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depthRef.current = 0;
        setDragging(false);
        if (!disabled) deliver(event.dataTransfer.files);
      }}
    >
      <svg className="size-10 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <p className="text-lg font-semibold">{dragging ? 'Zum Hinzufügen loslassen' : title}</p>
      <p className="text-muted">oder</p>
      <label htmlFor={inputId} className="sr-only">
        {buttonLabel} (Dateifeld)
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        tabIndex={-1}
        aria-describedby={children ? hintId : undefined}
        onChange={(event) => {
          deliver(event.currentTarget.files);
          // Zurücksetzen, damit dieselbe Datei erneut gewählt werden kann.
          event.currentTarget.value = '';
        }}
      />
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-primary"
        disabled={disabled}
        aria-describedby={children ? hintId : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {buttonLabel}
      </button>
      {children && (
        <div id={hintId} className="hint max-w-prose">
          {children}
        </div>
      )}
    </div>
  );
}
