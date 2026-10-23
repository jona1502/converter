import { afterEach, describe, expect, it } from 'vitest';
import { getConcurrency } from '../../src/lib/image/limits';
import {
  createImageProcessor,
  ImageProcessingError,
  type CoreImageProcessor,
  type ImageErrorCode,
  type ImageProcessorOptions,
  type ProcessOptions,
} from '../../src/lib/image/index';
import { detectFormat } from '../../src/lib/image/sniff';
import { bytesToFile } from './helpers/bytes';
import { bytesOf, fill, halfTransparent, renderRequired } from './helpers/images';

const pngOptions: ProcessOptions = { format: 'png', quality: 0.9, background: '#ffffff', resize: { mode: 'none' } };
const jpegOptions: ProcessOptions = { ...pngOptions, format: 'jpeg', background: '#ff0000' };

/**
 * Ein Worker kann nur verarbeiten, wenn dort OffscreenCanvas existiert. Playwright-WebKit (Windows)
 * hat kein OffscreenCanvas – weder im Fenster noch im Worker –, dort greift der Hauptthread-Rückfall.
 */
const workerExpected = typeof OffscreenCanvas !== 'undefined';

const processors: CoreImageProcessor[] = [];

function make(options?: ImageProcessorOptions): CoreImageProcessor {
  const p = createImageProcessor(options);
  processors.push(p);
  return p;
}

afterEach(() => {
  for (const p of processors.splice(0)) p.dispose();
});

async function codeOf(promise: Promise<unknown>): Promise<ImageErrorCode | 'resolved'> {
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    expect(e).toBeInstanceOf(ImageProcessingError);
    return (e as ImageProcessingError).code;
  }
}

const realWorker = (): Worker =>
  new Worker(new URL('../../src/lib/image/worker.ts', import.meta.url), { type: 'module' });

/**
 * Worker aus Quelltext. blob:-Worker werden NUR in Tests verwendet, um Worker-Verhalten gezielt
 * nachzustellen; der Produktionscode nutzt ausschließlich die eigene Datei worker.ts.
 */
function scriptWorker(source: string): () => Worker {
  return () => new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
}

/**
 * Test-Worker, der sich als nutzbar meldet, Verarbeitungsaufträge aber nie beantwortet. Er quittiert
 * den Empfang mit einer Nachricht (id -1, vom Prozessor ignoriert), damit Tests deterministisch
 * genau dann abbrechen können, wenn der Auftrag im Worker läuft.
 */
const hangingWorker = scriptWorker(`
  self.onmessage = (e) => {
    if (e.data.type === 'capabilities') {
      postMessage({ type: 'capabilities', id: e.data.id, support: { jpeg: true, png: true, webp: true, bmp: true, ico: true }, decodeSupport: { jpeg: true, png: true, webp: true, gif: false, bmp: true, ico: true, avif: false }, usable: true });
    } else {
      postMessage({ type: 'received', id: -1 });
    }
  };
`);

/** Worker-Fabrik mit Zählern und Empfangsereignis „Auftrag im Worker angekommen“. */
function countingWorkers(factory: () => Worker = realWorker) {
  const stats = { created: 0, terminated: 0, received: 0 };
  const receivedWaiters: Array<{ count: number; resolve: () => void }> = [];
  const createWorker = (): Worker => {
    const worker = factory();
    stats.created++;
    worker.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type !== 'received') return;
      stats.received++;
      for (const w of receivedWaiters.filter((x) => stats.received >= x.count)) w.resolve();
    });
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      stats.terminated++;
      terminate();
    };
    return worker;
  };
  const waitForReceived = (count: number): Promise<void> =>
    stats.received >= count ? Promise.resolve() : new Promise((resolve) => receivedWaiters.push({ count, resolve }));
  return { stats, createWorker, waitForReceived };
}

describe('createImageProcessor', () => {
  it('verarbeitet im Worker (bzw. im Rückfall) und liefert dessen Fähigkeiten', async () => {
    const p = make();
    expect(await p.getExecutionMode()).toBe(workerExpected ? 'worker' : 'main');
    const support = await p.getEncodeSupport();
    expect(support.png).toBe(true);
    expect(support.jpeg).toBe(true);
    const decodeSupport = await p.getDecodeSupport();
    expect(decodeSupport.png).toBe(true);
    expect(decodeSupport.jpeg).toBe(true);
    expect(decodeSupport.bmp).toBe(true);

    const source = await renderRequired('png', 30, 20, halfTransparent);
    const result = await p.process(source, jpegOptions);
    expect(result).toMatchObject({ format: 'jpeg', mime: 'image/jpeg', width: 30, height: 20, transparencyFlattened: true });
    expect(result.blob).toBeInstanceOf(Blob);
    expect(detectFormat(await bytesOf(result.blob))).toBe('jpeg');
  });

  it('überträgt Fehler aus dem Worker als ImageProcessingError', async () => {
    const p = make();
    const png = await bytesOf(await renderRequired('png', 8, 8, fill('#000000')));
    expect(await codeOf(p.process(bytesToFile(png.subarray(0, 33), 'kaputt.png'), pngOptions))).toBe('decode-failed');
    expect(await codeOf(p.process(new Blob(['kein Bild']), pngOptions))).toBe('unsupported-type');
    expect(await codeOf(p.process(bytesToFile(png, 'a.png'), { ...pngOptions, quality: 2 }))).toBe('invalid-options');
    if (!(await p.getEncodeSupport()).webp) {
      expect(await codeOf(p.process(bytesToFile(png, 'a.png'), { ...pngOptions, format: 'webp' }))).toBe('encode-unsupported');
    }
  });

  it('fällt auf den Hauptthread zurück, wenn kein Worker erzeugt werden kann', async () => {
    const p = make({
      createWorker: () => {
        throw new Error('kein Worker');
      },
    });
    expect(await p.getExecutionMode()).toBe('main');
    const result = await p.process(await renderRequired('png', 12, 10, fill('#00ff00')), pngOptions);
    expect([result.width, result.height]).toEqual([12, 10]);
  });

  it('fällt zurück, wenn der Worker nicht verarbeiten kann oder nicht antwortet', async () => {
    const unusable = make({
      createWorker: scriptWorker(
        "self.onmessage = (e) => postMessage({ type: 'capabilities', id: e.data.id, support: { jpeg: false, png: false, webp: false }, usable: false });",
      ),
    });
    expect(await unusable.getExecutionMode()).toBe('main');
    expect((await unusable.getEncodeSupport()).png).toBe(true);

    const silent = make({ createWorker: scriptWorker('self.onmessage = () => {};'), capabilityTimeoutMs: 300 });
    expect(await silent.getExecutionMode()).toBe('main');
    const result = await silent.process(await renderRequired('png', 5, 5, fill('#00ff00')), pngOptions);
    expect(result.width).toBe(5);

    const mainOnly = make({ preferWorker: false });
    expect(await mainOnly.getExecutionMode()).toBe('main');
  });

  it('startet nie mehr Aufträge gleichzeitig als getConcurrency()', async () => {
    const limit = getConcurrency();
    const p = make();
    const source = await renderRequired('png', 400, 300, fill('#123456'));
    let active = 0;
    let maxActive = 0;
    let starts = 0;
    const jobs = Array.from({ length: 6 }, () => {
      const job = p.process(source, jpegOptions, {
        onStart: () => {
          starts++;
          active++;
          maxActive = Math.max(maxActive, active);
        },
      });
      return job.then(
        (r) => {
          active--;
          return r;
        },
        (e: unknown) => {
          active--;
          throw e;
        },
      );
    });
    await Promise.all(jobs);
    expect(starts).toBe(6);
    expect(maxActive).toBe(limit);
  });

  it('entfernt abgebrochene wartende Aufträge, ohne sie zu starten', async () => {
    const p = make();
    const source = await renderRequired('png', 200, 200, fill('#123456'));
    const blockers = Array.from({ length: getConcurrency() }, () => p.process(source, pngOptions));
    const controller = new AbortController();
    let started = false;
    const waiting = p.process(source, pngOptions, { signal: controller.signal, onStart: () => (started = true) });
    controller.abort();
    expect(await codeOf(waiting)).toBe('aborted');
    await Promise.all(blockers);
    expect(started).toBe(false);
    expect(await codeOf(p.process(source, pngOptions, { signal: AbortSignal.abort() }))).toBe('aborted');
  });

  it('beendet beim Abbruch eines laufenden Auftrags den Worker und ersetzt ihn', async () => {
    const { stats, createWorker, waitForReceived } = countingWorkers(hangingWorker);
    const p = make({ createWorker, concurrency: 1 });
    expect(await p.getExecutionMode()).toBe('worker');
    expect(stats.created).toBe(1);
    const source = await renderRequired('png', 6, 6, fill('#00ff00'));
    const controller = new AbortController();
    const running = p.process(source, pngOptions, { signal: controller.signal });
    await waitForReceived(1);
    controller.abort();
    expect(await codeOf(running)).toBe('aborted');
    expect(stats.terminated).toBe(1);

    // Der nächste Auftrag erhält einen neuen Worker.
    const next = p.process(source, pngOptions);
    await waitForReceived(2);
    expect(stats.created).toBe(2);
    p.dispose();
    expect(await codeOf(next)).toBe('aborted');
    expect(stats.terminated).toBe(2);
  });

  it('zerstört den Worker, wenn ein Auftrag nicht zugestellt werden kann (kein Leck)', async () => {
    const failingPost = (): Worker => {
      const worker = hangingWorker();
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message: { type?: string }) => {
        if (message?.type === 'process') throw new DOMException('nicht klonbar', 'DataCloneError');
        post(message);
      };
      return worker;
    };
    const { stats, createWorker } = countingWorkers(failingPost);
    const p = make({ createWorker, concurrency: 1 });
    expect(await p.getExecutionMode()).toBe('worker');
    const source = await renderRequired('png', 4, 4, fill('#000000'));
    expect(await codeOf(p.process(source, pngOptions))).toBe('invalid-options');
    expect(stats.terminated).toBe(1);
    expect(await codeOf(p.process(source, pngOptions))).toBe('invalid-options');
    expect(stats.created).toBe(2);
    expect(stats.terminated).toBe(2);
  });

  it('verarbeitet nach einem Abbruch mit dem echten Worker weiter', async () => {
    const p = make({ concurrency: 1 });
    const source = await renderRequired('png', 6, 6, fill('#00ff00'));
    const controller = new AbortController();
    const aborted = p.process(source, pngOptions, { signal: controller.signal, onStart: () => controller.abort() });
    expect(await codeOf(aborted)).toBe('aborted');
    expect((await p.process(source, pngOptions)).width).toBe(6);
  });

  it('dispose lehnt alle offenen Aufträge mit aborted ab', async () => {
    const { stats, createWorker } = countingWorkers();
    const p = make({ createWorker });
    const big = await renderRequired('png', 50, 50, fill('#000000'));
    const jobs = Array.from({ length: 4 }, () => p.process(big, jpegOptions));
    p.dispose();
    expect(await Promise.all(jobs.map(codeOf))).toEqual(['aborted', 'aborted', 'aborted', 'aborted']);
    expect(stats.terminated).toBe(stats.created);
    expect(await codeOf(p.process(big, jpegOptions))).toBe('aborted');
    expect(await codeOf(p.getEncodeSupport())).toBe('aborted');
  });

  it('dispose beendet laufende Worker-Aufträge und alle Worker', async () => {
    const { stats, createWorker, waitForReceived } = countingWorkers(hangingWorker);
    const p = make({ createWorker });
    expect(await p.getExecutionMode()).toBe('worker');
    const source = await renderRequired('png', 6, 6, fill('#000000'));
    let started = 0;
    const jobs = Array.from({ length: 4 }, () => p.process(source, jpegOptions, { onStart: () => started++ }));
    await waitForReceived(getConcurrency());
    p.dispose();
    expect(await Promise.all(jobs.map(codeOf))).toEqual(['aborted', 'aborted', 'aborted', 'aborted']);
    expect(started).toBe(getConcurrency());
    expect(stats.created).toBeGreaterThanOrEqual(1);
    expect(stats.terminated).toBe(stats.created);
  });

  it('ruft onStart genau einmal je Auftrag auf, auch im Hauptthread-Rückfall', async () => {
    const p = make({ preferWorker: false });
    const source = await renderRequired('png', 10, 10, fill('#000000'));
    let calls = 0;
    await Promise.all([
      p.process(source, pngOptions, { onStart: () => calls++ }),
      p.process(source, pngOptions, { onStart: () => calls++ }),
      p.process(source, pngOptions, { onStart: () => calls++ }),
    ]);
    expect(calls).toBe(3);
  });

  it('bricht laufende Hauptthread-Aufträge ab', async () => {
    const p = make({ preferWorker: false, concurrency: 1 });
    const big = await renderRequired('png', 400, 300, fill('#000000'));
    const controller = new AbortController();
    const job = p.process(big, jpegOptions, { signal: controller.signal, onStart: () => controller.abort() });
    expect(await codeOf(job)).toBe('aborted');
    const next = await p.process(await renderRequired('png', 4, 4, fill('#000000')), pngOptions);
    expect(next.width).toBe(4);
  });
});
