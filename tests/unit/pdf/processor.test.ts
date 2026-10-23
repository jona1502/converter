import { afterEach, describe, expect, it } from 'vitest';
import {
  createPdfCompressor,
  PdfProcessingError,
  PDF_QUALITY_LEVELS,
  type PdfCompressor,
  type PdfCompressorOptions,
  type PdfErrorCode,
  type PdfVariantResult,
  type PdfVariantStatus,
} from '../../../src/lib/pdf/index';
import { encryptedPdf, mixedPdf, textOnlyPdf } from './fixtures';
import { browserName, jpegBytes, pageCount, toFile } from './helpers';

/**
 * Im Worker gibt es nur OffscreenCanvas. Playwright-WebKit unter Windows hat keins – dort muss
 * compressAll mit 'unsupported-browser' ablehnen statt still schlechter zu komprimieren.
 */
const workerCanRecode = typeof OffscreenCanvas !== 'undefined';

const compressors: PdfCompressor[] = [];
function make(options?: PdfCompressorOptions): PdfCompressor {
  const c = createPdfCompressor(options);
  compressors.push(c);
  return c;
}

afterEach(() => {
  for (const c of compressors.splice(0)) c.dispose();
});

async function codeOf(promise: Promise<unknown>): Promise<PdfErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    if (e instanceof PdfProcessingError) return e.code;
    throw e;
  }
}

describe('createPdfCompressor – Analyse im Worker', () => {
  it('bereinigt synchrone postMessage-Fehler und startet den nächsten Auftrag neu', async () => {
    let terminated = 0;
    let attempts = 0;
    const c = make({ createWorker: () => {
      attempts++;
      if (attempts > 1) return new Worker(new URL('../../../src/lib/pdf/worker.ts', import.meta.url), { type: 'module' });
      return {
        postMessage: () => { throw new DOMException('clone failed', 'DataCloneError'); },
        terminate: () => { terminated++; },
      } as unknown as Worker;
    } });
    const controller = new AbortController();
    const file = toFile(await textOnlyPdf());
    expect(await codeOf(c.analyze(file, controller.signal))).toBe('worker-failed');
    expect(terminated).toBe(1);
    // Ein alter Abort-Listener darf den neuen Worker nicht beenden.
    const next = c.analyze(file);
    controller.abort();
    expect((await next).pageCount).toBe(1);
    expect(attempts).toBe(2);
  });

  it('analysiert eine PDF im Worker', async () => {
    const { bytes } = await mixedPdf();
    const analysis = await make().analyze(toFile(bytes));
    expect(analysis.pageCount).toBe(2);
    expect(analysis.images.total).toBe(3);
  });

  it('überträgt Fehlercodes über die Worker-Grenze', async () => {
    const c = make();
    expect(await codeOf(c.analyze(toFile(await jpegBytes(10, 10))))).toBe('not-pdf');
    expect(await codeOf(c.analyze(toFile(await encryptedPdf('x'))))).toBe('encrypted');
    expect(await codeOf(c.analyze(toFile(new TextEncoder().encode('%PDF-1.7 kaputt'))))).toBe('parse-failed');
    // Der Worker bleibt nach Fehlern nutzbar.
    expect((await c.analyze(toFile(await textOnlyPdf()))).pageCount).toBe(1);
  }, 60_000); // AES-256-Fixture wird im Browser erzeugt.

  it('lehnt ungültige Stufen ab', async () => {
    const c = make();
    const file = toFile(await textOnlyPdf());
    expect(await codeOf(c.compressAll(file, []))).toBe('invalid-options');
    expect(await codeOf(c.compressAll(file, ['small', 'small']))).toBe('invalid-options');
  });
});

describe.runIf(!workerCanRecode)('createPdfCompressor – Browser ohne OffscreenCanvas', () => {
  it('meldet unsupported-browser', async () => {
    const statuses: PdfVariantStatus[] = [];
    const code = await codeOf(make().compressAll(toFile(await textOnlyPdf()), ['small'], { onStatus: (s) => statuses.push(s) }));
    expect(code).toBe('unsupported-browser');
    expect(statuses.at(-1)).toEqual({ level: 'small', phase: 'error', errorCode: 'unsupported-browser' });
  });
});

describe.runIf(workerCanRecode)('createPdfCompressor – Varianten im Worker', () => {
  it('berechnet die Varianten strikt nacheinander mit konsistentem Status', async () => {
    const { bytes } = await mixedPdf();
    const file = toFile(bytes);
    const statuses: PdfVariantStatus[] = [];
    const results: PdfVariantResult[] = [];
    const outcomes = await make().compressAll(file, PDF_QUALITY_LEVELS, {
      onStatus: (s) => statuses.push(s),
      onResult: (r) => {
        // Zum Zeitpunkt des Ergebnisses ist die Variante bereits als fertig gemeldet.
        expect(statuses.at(-1)).toEqual({ level: r.level, phase: 'done' });
        results.push(r);
      },
    });

    expect(statuses.slice(0, 3)).toEqual(PDF_QUALITY_LEVELS.map((level) => ({ level, phase: 'queued' })));
    const rest = statuses.slice(3);
    // Nie zwei Varianten gleichzeitig: Ereignisse bilden zusammenhängende Blöcke in Stufenreihenfolge.
    const order = rest.map((s) => s.level).filter((l, i, a) => i === 0 || a[i - 1] !== l);
    expect(order).toEqual([...PDF_QUALITY_LEVELS]);
    for (const level of PDF_QUALITY_LEVELS) {
      const phases = rest.filter((s) => s.level === level);
      expect(phases[0]!.phase).toBe('loading');
      expect(phases.at(-1)!.phase).toBe('done');
      expect(phases.at(-2)!.phase).toBe('saving');
      const images = phases.filter((s) => s.phase === 'images');
      expect(images.map((s) => s.current)).toEqual([0, 1, 2, 3]);
      for (const s of images) expect(s.current!).toBeLessThanOrEqual(s.total!);
    }

    expect(results.map((r) => r.level)).toEqual([...PDF_QUALITY_LEVELS]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    for (const r of results) {
      expect(r.size).toBe(r.blob.size);
      expect(r.originalSize).toBe(file.size);
      expect(r.blob.type).toBe('application/pdf');
      expect(await pageCount(new Uint8Array(await r.blob.arrayBuffer()))).toBe(2);
    }
    expect(results[2]!.size).toBeLessThanOrEqual(results[1]!.size);
    expect(results[1]!.size).toBeLessThanOrEqual(results[0]!.size);
    console.info(`[pdf-messung ${browserName()} worker] Original ${file.size} B; ${results.map((r) => `${r.level}=${r.size}`).join(' ')}`);
  }, 60_000);

  it('liefert auch für eine reine Text-PDF die echte Größe', async () => {
    const bytes = await textOnlyPdf();
    const outcomes = await make().compressAll(toFile(bytes), ['high']);
    const outcome = outcomes[0]!;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.size).toBe(outcome.result.blob.size);
      expect(outcome.result.imagesRecompressed).toBe(0);
    }
  });

  it('bricht ab, beendet den Worker und bleibt danach nutzbar', async () => {
    const { bytes } = await mixedPdf();
    const c = make();
    const controller = new AbortController();
    const results: PdfVariantResult[] = [];
    const promise = c.compressAll(toFile(bytes), PDF_QUALITY_LEVELS, {
      signal: controller.signal,
      onStatus: (s) => {
        if (s.level === 'balanced' && s.phase === 'images') controller.abort();
      },
      onResult: (r) => results.push(r),
    });
    expect(await codeOf(promise)).toBe('aborted');
    expect(results.map((r) => r.level)).toEqual(['high']);
    expect((await c.analyze(toFile(bytes))).pageCount).toBe(2);
    // Bereits abgebrochenes Signal: sofortige Ablehnung
    expect(await codeOf(c.compressAll(toFile(bytes), ['small'], { signal: controller.signal }))).toBe('aborted');
  }, 60_000);

  it('verwirft Ergebnisse über dem Speicherbudget mit memory-limit', async () => {
    const bytes = await textOnlyPdf();
    const statuses: PdfVariantStatus[] = [];
    const outcomes = await make({ maxResultBytesTotal: 1500 }).compressAll(toFile(bytes), ['high', 'small'], {
      onStatus: (s) => statuses.push(s),
    });
    // Ein Ergebnis (~1,1 KB) passt, das zweite würde das Budget überschreiten.
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[1]!.ok).toBe(false);
    if (!outcomes[1]!.ok) expect(outcomes[1]!.error.code).toBe('memory-limit');
    expect(statuses.at(-1)).toEqual({ level: 'small', phase: 'error', errorCode: 'memory-limit' });
  });

  it('dispose lehnt offene Aufträge mit aborted ab', async () => {
    const { bytes } = await mixedPdf();
    const c = make();
    const promise = c.compressAll(toFile(bytes), PDF_QUALITY_LEVELS);
    c.dispose();
    expect(await codeOf(promise)).toBe('aborted');
    expect(await codeOf(c.analyze(toFile(bytes)))).toBe('aborted');
  });
});
