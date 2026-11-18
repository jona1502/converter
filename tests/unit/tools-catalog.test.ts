import { describe, expect, it } from 'vitest';
import { availableTools, availableToolsByAction, getTool } from '../../src/data/tools';

describe('Werkzeugkatalog nach Aktion', () => {
  const titlesOf = (id: string) =>
    availableToolsByAction.find((group) => group.action.id === id)?.tools.map((tool) => tool.title);

  it('gruppiert Konvertieren, Komprimieren, Skalieren, Drehen, Teilen und Zusammenführen in dieser Reihenfolge', () => {
    expect(availableToolsByAction.map((group) => group.action.title)).toEqual([
      'Konvertieren',
      'Komprimieren',
      'Skalieren',
      'Drehen',
      'Teilen',
      'Zusammenführen',
    ]);
  });

  it('ordnet Audio unter Konvertieren und PDF unter Komprimieren', () => {
    expect(titlesOf('convert')).toEqual(['Bilder konvertieren', 'Markdown zu PDF', 'Audio konvertieren']);
    expect(titlesOf('compress')).toEqual(['Bilder komprimieren', 'PDF komprimieren']);
    expect(titlesOf('resize')).toEqual(['Bilder skalieren']);
    expect(titlesOf('rotate')).toEqual(['PDF drehen']);
    expect(titlesOf('split')).toEqual(['PDF teilen']);
    expect(titlesOf('merge')).toEqual(['PDF zusammenführen']);
  });

  it('enthält jedes verfügbare Werkzeug genau einmal', () => {
    const ids = availableToolsByAction.flatMap((group) => group.tools.map((tool) => tool.id));
    expect([...ids].sort()).toEqual(availableTools.map((tool) => tool.id).sort());
  });
});

describe('Werkzeugtexte', () => {
  it('hat zu jedem Werkzeug einen Satz als Einleitung', () => {
    for (const tool of availableTools) {
      expect(tool.lead, tool.id).toMatch(/^[^.!?]+[.]$/);
    }
  });

  it('getTool liefert den Eintrag und wirft bei unbekannter Kennung', () => {
    expect(getTool('pdf-komprimieren').href).toBe('/pdf/komprimieren');
    expect(getTool('pdf-drehen').href).toBe('/pdf/drehen');
    expect(getTool('pdf-teilen').href).toBe('/pdf/teilen');
    expect(() => getTool('gibt-es-nicht')).toThrow();
  });
});
