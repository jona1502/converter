/** Öffentliche API des PDF-Komprimierungskerns. */
export * from './types';
export { PDF_LIMITS } from './limits';
export { PDF_PRESETS } from './presets';
export { createPdfCompressor, type PdfCompressorOptions } from './processor';
