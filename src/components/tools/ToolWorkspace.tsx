import { useId, type ReactNode } from 'react';

interface ToolWorkspaceProps {
  readonly selection: ReactNode;
  readonly selectionTitle?: string;
  readonly settings: ReactNode;
  readonly action: ReactNode;
  readonly actionTitle: string;
  readonly results: ReactNode;
  readonly resultsHeadingId: string;
  readonly resultNotice?: ReactNode;
  readonly resultsHint?: string;
}

/** Nur Layout: Auswahl, Einstellungen, Start und Ergebnisse behalten ihre DOM-Reihenfolge. */
export function ToolWorkspace({
  selection,
  selectionTitle = 'Bilder auswählen',
  settings,
  action,
  actionTitle,
  results,
  resultsHeadingId,
  resultNotice,
  resultsHint,
}: ToolWorkspaceProps) {
  const id = useId();
  return (
    <div className="grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_1fr]">
      <section aria-labelledby={`${id}-selection`} className="flex min-w-0 flex-col gap-4 xl:col-start-1 xl:row-start-1">
        <h2 id={`${id}-selection`} className="section-title step-title">1. {selectionTitle}</h2>
        {selection}
      </section>

      <aside aria-label="Einstellungen und Verarbeitung" className="flex min-w-0 flex-col gap-8 xl:col-start-2 xl:row-span-2 xl:row-start-1">
        <section aria-labelledby={`${id}-settings`} className="card-muted flex min-w-0 flex-col gap-5">
          <h2 id={`${id}-settings`} className="section-title step-title">2. Einstellungen</h2>
          {settings}
        </section>
        <section aria-labelledby={`${id}-action`} className="flex min-w-0 flex-col gap-4">
          <h2 id={`${id}-action`} className="section-title step-title">3. {actionTitle}</h2>
          {action}
        </section>
      </aside>

      <section aria-labelledby={resultsHeadingId} className="flex min-w-0 flex-col gap-4 xl:col-start-1 xl:row-start-2">
        <h2 id={resultsHeadingId} className="section-title step-title">4. Dateien und Ergebnisse</h2>
        {resultNotice}
        {resultsHint && <p className="hint">{resultsHint}</p>}
        {results}
      </section>
    </div>
  );
}
