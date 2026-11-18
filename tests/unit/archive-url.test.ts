import { describe, expect, it } from 'vitest';
import { archiveUrl, batchZipUrl, jobZipUrl } from '../../src/lib/api/client';

describe('archiveUrl', () => {
  it('hängt jede Auftrags-ID als job_id an', () => {
    expect(archiveUrl(['a', 'b c'])).toBe('/api/v1/jobs/archive?job_id=a&job_id=b%20c');
  });
});

describe('batchZipUrl', () => {
  it('liefert erst ab zwei Aufträgen eine URL', () => {
    expect(batchZipUrl(['a'], false)).toBeNull();
    expect(batchZipUrl(['a', 'b'], false)).toBe('/api/v1/jobs/archive?job_id=a&job_id=b');
  });
  it('liefert während der Verarbeitung nichts', () => {
    expect(batchZipUrl(['a', 'b'], true)).toBeNull();
  });
  it('ignoriert fehlende IDs und Duplikate', () => {
    expect(batchZipUrl(['a', undefined, 'a'], false)).toBeNull();
    expect(batchZipUrl(['a', undefined, 'b', 'a'], false)).toBe('/api/v1/jobs/archive?job_id=a&job_id=b');
  });
  it('liefert nichts über der Obergrenze von 30 Aufträgen', () => {
    const ids = Array.from({ length: 31 }, (_, i) => `j${i}`);
    expect(batchZipUrl(ids, false)).toBeNull();
    expect(batchZipUrl(ids.slice(0, 30), false)).not.toBeNull();
  });
});

describe('jobZipUrl', () => {
  const result = (state: string, downloadUrl: string | null = '/x') => ({ state, downloadUrl });
  const job = (state: string, results: ReturnType<typeof result>[]) => ({ id: 'j1', state, results });
  it('liefert ab zwei herunterladbaren Ergebnissen die Archiv-URL des einen Auftrags', () => {
    expect(jobZipUrl(job('succeeded', [result('succeeded'), result('succeeded'), result('succeeded')]))).toBe('/api/v1/jobs/archive?job_id=j1');
    expect(jobZipUrl(job('partially_succeeded', [result('succeeded'), result('failed', null), result('succeeded')]))).toBe('/api/v1/jobs/archive?job_id=j1');
  });
  it('liefert nichts bei weniger als zwei Ergebnissen, laufenden oder abgelaufenen Aufträgen', () => {
    expect(jobZipUrl(job('succeeded', [result('succeeded')]))).toBeNull();
    expect(jobZipUrl(job('partially_succeeded', [result('succeeded'), result('failed', null)]))).toBeNull();
    expect(jobZipUrl(job('running', [result('succeeded'), result('succeeded')]))).toBeNull();
    expect(jobZipUrl(job('expired', [result('succeeded'), result('succeeded')]))).toBeNull();
    expect(jobZipUrl(null)).toBeNull();
  });
});
