import type { CompressPhase, CompressStats } from './compress';
import type { SerializedPdfError } from './errors';
import type { PdfAnalysis, PdfQualityLevel } from './types';

/** Nachrichten Hauptthread -> Worker. Der Worker bearbeitet sie strikt nacheinander. */
export type PdfWorkerRequest =
  | { readonly type: 'analyze'; readonly id: number; readonly file: Blob }
  | { readonly type: 'compress'; readonly id: number; readonly file: Blob; readonly level: PdfQualityLevel };

/** Antworten Worker -> Hauptthread. */
export type PdfWorkerResponse =
  | {
      readonly type: 'progress';
      readonly id: number;
      readonly phase: CompressPhase;
      readonly current?: number;
      readonly total?: number;
    }
  | { readonly type: 'analysis'; readonly id: number; readonly analysis: PdfAnalysis }
  | {
      readonly type: 'result';
      readonly id: number;
      /** Übertragen (transferable), nicht kopiert. */
      readonly buffer: ArrayBuffer;
      readonly stats: CompressStats;
    }
  | { readonly type: 'error'; readonly id: number; readonly error: SerializedPdfError };
