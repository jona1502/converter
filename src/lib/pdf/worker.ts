/**
 * Modul-Worker für die PDF-Komprimierung. Enthält bewusst keine Netzwerkaufrufe und keine Logs.
 * Erzeugt über new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }).
 */
import { analyzePdfBytes } from './analyze';
import { compressPdfBytes } from './compress';
import { readFileBytes } from './document';
import { serializePdfError } from './errors';
import type { PdfWorkerRequest, PdfWorkerResponse } from './worker-protocol';

// Der Parser kann bei beschädigten PDFs Warnungen mit Werten aus dem Dokument ausgeben.
// Dieser dedizierte Worker schreibt deshalb keine Bibliothekslogs in die Entwicklerkonsole.
console.warn = () => undefined;
console.log = () => undefined;

interface WorkerScope {
  postMessage(message: PdfWorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<PdfWorkerRequest>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

async function handle(request: PdfWorkerRequest): Promise<void> {
  const id = request.id;
  try {
    if (request.type === 'analyze') {
      const bytes = await readFileBytes(request.file);
      const analysis = await analyzePdfBytes(bytes);
      scope.postMessage({ type: 'analysis', id, analysis });
      return;
    }
    const bytes = await readFileBytes(request.file);
    const { bytes: out, stats } = await compressPdfBytes(bytes, request.level, {
      requireOffscreen: true,
      onPhase: (phase, current, total) => scope.postMessage({ type: 'progress', id, phase, current, total }),
    });
    const buffer =
      out.byteOffset === 0 && out.byteLength === out.buffer.byteLength && out.buffer instanceof ArrayBuffer
        ? out.buffer
        : out.slice().buffer;
    scope.postMessage({ type: 'result', id, buffer, stats }, [buffer]);
  } catch (error) {
    scope.postMessage({ type: 'error', id, error: serializePdfError(error, request.type === 'compress' ? 'save-failed' : 'parse-failed') });
  }
}

// Aufträge strikt nacheinander: nie zwei Dokumente gleichzeitig im Speicher.
let chain: Promise<void> = Promise.resolve();

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || typeof request !== 'object' || typeof request.id !== 'number') return;
  chain = chain.then(() => handle(request));
});
