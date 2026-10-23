import { ImageProcessingError, type ImageErrorCode } from './types';

const ERROR_CODES: readonly ImageErrorCode[] = [
  'unsupported-type',
  'file-too-large',
  'dimensions-too-large',
  'animated-unsupported',
  'decode-failed',
  'invalid-options',
  'encode-unsupported',
  'encode-failed',
  'aborted',
];

export interface SerializedError {
  readonly code: ImageErrorCode;
  readonly message: string;
}

export function isImageErrorCode(value: unknown): value is ImageErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Wandelt beliebige Fehler in ImageProcessingError um (unbekannte -> fallbackCode). */
export function toImageError(error: unknown, fallbackCode: ImageErrorCode = 'encode-failed'): ImageProcessingError {
  if (error instanceof ImageProcessingError) return error;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new ImageProcessingError(fallbackCode, message);
}

export function serializeError(error: unknown): SerializedError {
  const e = toImageError(error);
  return { code: e.code, message: e.message };
}

export function deserializeError(value: unknown): ImageProcessingError {
  const v = value as Partial<SerializedError> | null;
  if (v && isImageErrorCode(v.code)) return new ImageProcessingError(v.code, String(v.message ?? ''));
  return new ImageProcessingError('encode-failed', 'Unbekannter Fehler aus dem Worker.');
}

export function abortedError(message = 'Vorgang abgebrochen.'): ImageProcessingError {
  return new ImageProcessingError('aborted', message);
}
