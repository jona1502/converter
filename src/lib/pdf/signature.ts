/** Signaturprüfung ohne pdf-lib, damit die Startseite sie ohne die schwere Bibliothek nutzen kann. */
import { PDF_LIMITS } from './limits';

const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Position von %PDF- in den ersten 1024 Bytes oder -1. */
export function findPdfSignature(bytes: Uint8Array): number {
  const end = Math.min(bytes.length, PDF_LIMITS.signatureSearchBytes) - SIGNATURE.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < SIGNATURE.length; j++) if (bytes[i + j] !== SIGNATURE[j]) continue outer;
    return i;
  }
  return -1;
}
