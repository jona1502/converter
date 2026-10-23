import { PdfProcessingError, type PdfErrorCode } from './types';

const ERROR_CODES: readonly PdfErrorCode[] = [
  'not-pdf',
  'encrypted',
  'file-too-large',
  'parse-failed',
  'memory-limit',
  'save-failed',
  'unsupported-browser',
  'invalid-options',
  'worker-failed',
  'aborted',
];

export interface SerializedPdfError {
  readonly code: PdfErrorCode;
  readonly message: string;
}

export function isPdfErrorCode(value: unknown): value is PdfErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Wandelt beliebige Fehler in PdfProcessingError um (unbekannte -> fallbackCode). */
export function toPdfError(error: unknown, fallbackCode: PdfErrorCode): PdfProcessingError {
  if (error instanceof PdfProcessingError) return error;
  if (error instanceof RangeError || (error instanceof DOMException && error.name === 'QuotaExceededError')) {
    return new PdfProcessingError('memory-limit', `${error.name}: ${error.message}`);
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new PdfProcessingError(fallbackCode, message);
}

export function serializePdfError(error: unknown, fallbackCode: PdfErrorCode = 'parse-failed'): SerializedPdfError {
  const e = toPdfError(error, fallbackCode);
  return { code: e.code, message: e.message };
}

export function deserializePdfError(value: unknown): PdfProcessingError {
  const v = value as Partial<SerializedPdfError> | null;
  if (v && isPdfErrorCode(v.code)) return new PdfProcessingError(v.code, String(v.message ?? ''));
  return new PdfProcessingError('worker-failed', 'Unbekannter Fehler aus dem Worker.');
}

export function abortedError(message = 'Vorgang abgebrochen.'): PdfProcessingError {
  return new PdfProcessingError('aborted', message);
}
