/**
 * Modul-Worker für die Bildverarbeitung. Enthält bewusst keine Netzwerkaufrufe und keine Logs.
 * Erzeugt über new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }).
 */
import { canProcessInContext } from './canvas';
import { detectEncodeSupport } from './capabilities';
import { serializeError } from './errors';
import { runPipeline } from './pipeline';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (request.type === 'capabilities') {
      const usable = canProcessInContext();
      const support = await detectEncodeSupport();
      // Ohne PNG-Kodierung ist die Canvas im Worker offensichtlich nicht brauchbar.
      return { type: 'capabilities', id: request.id, support, usable: usable && support.png };
    }
    const result = await runPipeline(request.file, request.options);
    return { type: 'process', id: request.id, result };
  } catch (error) {
    return { type: 'error', id: request.id, error: serializeError(error) };
  }
}

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (!request || typeof request !== 'object' || typeof request.id !== 'number') return;
  void handle(request).then((response) => {
    try {
      scope.postMessage(response);
    } catch (error) {
      scope.postMessage({ type: 'error', id: request.id, error: serializeError(error) });
    }
  });
});
