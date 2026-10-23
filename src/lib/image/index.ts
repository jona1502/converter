/**
 * Öffentliche API des Bildverarbeitungskerns.
 *
 * Kodierungsfähigkeiten bitte über processor.getEncodeSupport() abfragen: Sie gelten für den
 * Kontext (Worker oder Hauptthread-Rückfall), in dem tatsächlich verarbeitet wird.
 * detectEncodeSupport() aus capabilities.ts prüft nur den aufrufenden Kontext und ist daher intern.
 */
export * from './types';
export { LIMITS, getConcurrency } from './limits';
export { probeImage } from './probe';
export { computeTargetSize, type TargetSize } from './resize';
export { buildOutputFileName, makeUniqueFileNames } from './filename';
export {
  createImageProcessor,
  type CoreImageProcessor,
  type ExecutionMode,
  type ImageProcessorOptions,
} from './processor';
