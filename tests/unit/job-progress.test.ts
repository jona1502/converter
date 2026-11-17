import { describe, expect, it } from 'vitest';
import { jobProgress } from '../../src/lib/api/progress';

type Input = Parameters<typeof jobProgress>[0];
const job = (state: Input['state'], progress: Input['progress']): Input => ({ state, progress });

describe('jobProgress', () => {
  it('liest die Warteposition wartender Aufträge', () => {
    expect(jobProgress(job('queued', { step: 'queue', position: 3 }))).toEqual({ position: 3 });
  });

  it('ignoriert ungültige Positionen und fremde Schritte', () => {
    expect(jobProgress(job('queued', { step: 'queue', position: 0 }))).toBeUndefined();
    expect(jobProgress(job('queued', { step: 'queue', position: 1.5 }))).toBeUndefined();
    expect(jobProgress(job('queued', { step: 'queue', position: '2' }))).toBeUndefined();
    expect(jobProgress(job('queued', { step: 'other', position: 2 }))).toBeUndefined();
    expect(jobProgress(job('queued', null))).toBeUndefined();
  });

  it('berechnet den Anteil laufender Aufträge aus current und total', () => {
    expect(jobProgress(job('running', { step: 'encode', current: 25, total: 100 }))).toEqual({ fraction: 0.25 });
    expect(jobProgress(job('running', { step: 'variant', level: 'high', current: 3, total: 12 }))).toEqual({ fraction: 0.25 });
  });

  it('begrenzt den Anteil auf 1 und verlangt total > 0', () => {
    expect(jobProgress(job('running', { current: 9, total: 4 }))).toEqual({ fraction: 1 });
    expect(jobProgress(job('running', { current: 0, total: 0 }))).toBeUndefined();
    expect(jobProgress(job('running', { current: -1, total: 4 }))).toBeUndefined();
    expect(jobProgress(job('running', null))).toBeUndefined();
  });

  it('meldet für beendete Aufträge nichts', () => {
    expect(jobProgress(job('succeeded', { current: 1, total: 1 }))).toBeUndefined();
  });
});
