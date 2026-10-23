import type { SerializedError } from './errors';
import type { DecodeSupport, EncodeSupport, ProcessOptions, ProcessResult } from './types';

/** Nachrichten Hauptthread -> Worker. */
export type WorkerRequest =
  | { readonly type: 'process'; readonly id: number; readonly file: Blob; readonly options: ProcessOptions }
  | { readonly type: 'capabilities'; readonly id: number };

/** Antworten Worker -> Hauptthread. */
export type WorkerResponse =
  | { readonly type: 'process'; readonly id: number; readonly result: ProcessResult }
  | {
      readonly type: 'capabilities';
      readonly id: number;
      readonly support: EncodeSupport;
      readonly decodeSupport: DecodeSupport;
      /** Ob der Worker dekodieren und zeichnen kann (createImageBitmap + OffscreenCanvas mit 2D-Kontext). */
      readonly usable: boolean;
    }
  | { readonly type: 'error'; readonly id: number; readonly error: SerializedError };
