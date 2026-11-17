import { describe, expect, it } from 'vitest';
import { archiveUrl } from '../../src/lib/api/client';

describe('archiveUrl', () => {
  it('hängt jede Auftrags-ID als job_id an', () => {
    expect(archiveUrl(['a', 'b c'])).toBe('/api/v1/jobs/archive?job_id=a&job_id=b%20c');
  });
});
