/**
 * Analyse einer PDF: Seiten, Bilder nach Art und Neukodierbarkeit, Schriften, Signaturen und die
 * daraus folgenden konkreten Grenzen der Komprimierung im Browser.
 */
import { collectImages, countSignatures, embeddedFontBytes, loadPdfDocument, pruneUnreferenced } from './document';
import { computePlacements, type Placement } from './placement';
import type { PdfAnalysis, PdfImageFilterKind, PdfImageSkipReason, PdfLimitation } from './types';

export async function analyzePdfBytes(bytes: Uint8Array): Promise<PdfAnalysis> {
  const doc = await loadPdfDocument(bytes);
  const context = doc.context;
  // Nur im Speicher: verwaiste Objekte sollen die Zählung nicht verfälschen.
  pruneUnreferenced(context);
  const { images, maskCount, maskBytes } = collectImages(context);
  let placements: Map<unknown, Placement>;
  try {
    placements = computePlacements(doc);
  } catch {
    placements = new Map();
  }

  const skipped: Partial<Record<PdfImageSkipReason, number>> = {};
  const byFilter: Record<PdfImageFilterKind, number> = { dct: 0, flate: 0, none: 0, other: 0 };
  let recompressible = 0;
  let recompressibleBytes = 0;
  let imageBytes = maskBytes;
  let sizeUnknown = 0;
  for (const image of images) {
    byFilter[image.filter]++;
    imageBytes += image.bytes;
    if (image.skip) {
      skipped[image.skip] = (skipped[image.skip] ?? 0) + 1;
    } else {
      recompressible++;
      recompressibleBytes += image.bytes;
      if (!placements.has(image.ref)) sizeUnknown++;
    }
  }

  const fontBytes = embeddedFontBytes(context);
  const signatures = countSignatures(context);
  const limitations: PdfLimitation[] = [];
  if (images.length === 0) limitations.push({ code: 'no-images' });
  const notRecompressible = images.length - recompressible;
  if (notRecompressible > 0) limitations.push({ code: 'images-not-recompressible', count: notRecompressible });
  if (sizeUnknown > 0) limitations.push({ code: 'image-size-unknown', count: sizeUnknown });
  if (fontBytes > 0) limitations.push({ code: 'embedded-fonts-unchanged', bytes: fontBytes });
  if (signatures > 0) limitations.push({ code: 'signatures-invalidated', count: signatures });

  return {
    fileSize: bytes.length,
    pdfVersion: context.header.getVersionString(),
    pageCount: doc.getPageCount(),
    encrypted: false,
    images: {
      total: images.length,
      recompressible,
      skipped,
      byFilter,
      bytes: imageBytes,
      recompressibleBytes,
      maskCount,
    },
    fontBytes,
    limitations,
  };
}
