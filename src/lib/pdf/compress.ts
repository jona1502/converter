/**
 * Erzeugt eine Variante: frisch geladenes Dokument -> Bilder neu kodieren -> verlustfreie
 * Optimierung -> speichern. Läuft im Worker; im Fenster nur für Tests.
 */
import { PDFName, PDFNumber, PDFRawStream, type PDFContext, type PDFDocument } from '@cantoo/pdf-lib';
import { hasRecodeSupport } from './canvas';
import { collectImages, countSignatures, loadPdfDocument, N, pruneUnreferenced } from './document';
import { toPdfError } from './errors';
import { computePlacements, type Placement } from './placement';
import { getPreset } from './presets';
import { recodeImage } from './recode';
import { deflate } from './streams';
import { PdfProcessingError, type PdfQualityLevel, type PdfResultNote, type PdfVariantResult } from './types';

export type CompressPhase = 'loading' | 'images' | 'saving';

export interface CompressHooks {
  readonly onPhase?: (phase: CompressPhase, current?: number, total?: number) => void;
  /** Im Worker true: dort gibt es nur OffscreenCanvas. */
  readonly requireOffscreen?: boolean;
}

export type CompressStats = Omit<PdfVariantResult, 'level' | 'blob' | 'size' | 'originalSize'>;

export interface CompressOutput {
  readonly bytes: Uint8Array;
  readonly stats: CompressStats;
}

const F = PDFName.of('F');

/**
 * Komprimiert bisher unkomprimierte Streams verlustfrei mit Flate. Ausgenommen: XMP-Metadaten
 * (bleiben für andere Werkzeuge lesbar), Querverweis-/Objekt-Streams (schreibt pdf-lib neu),
 * Streams mit externen Daten (/F) und sehr kleine Streams.
 */
export async function compressPlainStreams(context: PDFContext): Promise<number> {
  let count = 0;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.transform) continue;
    const dict = obj.dict;
    if (dict.has(N.Filter) || dict.has(F)) continue;
    const type = dict.get(N.Type);
    if (type === N.Metadata || type === N.XRef || type === N.ObjStm) continue;
    const size = obj.getContentsSize();
    if (size < 64) continue;
    const packed = await deflate(obj.getContents());
    if (packed.length >= size) continue;
    obj.updateContents(packed);
    dict.set(N.Filter, N.FlateDecode);
    dict.delete(N.DecodeParms);
    dict.set(N.Length, PDFNumber.of(packed.length));
    count++;
  }
  return count;
}

async function saveDocument(doc: PDFDocument): Promise<Uint8Array> {
  const base = { addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 500, rewrite: true } as const;
  try {
    return await doc.save({ ...base, useObjectStreams: true });
  } catch (error) {
    // PDF/A-1 verbietet Objekt-Streams; dann ohne sie speichern.
    if (error instanceof Error && /PDF\/A-1/.test(error.message)) {
      try {
        return await doc.save({ ...base, useObjectStreams: false });
      } catch (inner) {
        throw toPdfError(inner, 'save-failed');
      }
    }
    throw toPdfError(error, 'save-failed');
  }
}

export async function compressPdfBytes(
  bytes: Uint8Array,
  level: PdfQualityLevel,
  hooks: CompressHooks = {},
): Promise<CompressOutput> {
  const preset = getPreset(level);
  if (!hasRecodeSupport(hooks.requireOffscreen ?? false)) {
    throw new PdfProcessingError(
      'unsupported-browser',
      'OffscreenCanvas, createImageBitmap oder (De-)CompressionStream fehlen in diesem Kontext.',
    );
  }
  const onPhase = hooks.onPhase ?? (() => undefined);

  onPhase('loading');
  const doc = await loadPdfDocument(bytes);
  const context = doc.context;
  const versionBefore = context.header.getVersionString();
  let objectsRemoved = pruneUnreferenced(context);
  const signatures = countSignatures(context);
  const { images } = collectImages(context);
  let placements: Map<unknown, Placement>;
  try {
    placements = computePlacements(doc);
  } catch {
    placements = new Map();
  }

  let recompressed = 0;
  let resized = 0;
  let skipped = 0;
  let notSmaller = 0;
  let sizeUnknown = 0;
  onPhase('images', 0, images.length);
  for (let i = 0; i < images.length; i++) {
    const record = images[i]!;
    const placement = placements.get(record.ref);
    if (record.skip === null && !placement) sizeUnknown++;
    let outcome;
    try {
      outcome = await recodeImage(context, record, placement, preset);
    } catch (error) {
      // Einzelbild nicht verarbeitbar (z. B. Canvas-Flächengrenze in Safari, Speicher):
      // Bild bleibt unverändert. Nur ein systematisch fehlender JPEG-Encoder bricht ab.
      const e = toPdfError(error, 'memory-limit');
      if (e.code === 'unsupported-browser') throw e;
      outcome = 'skipped' as const;
    }
    if (outcome === 'resized') {
      resized++;
      recompressed++;
    } else if (outcome === 'recompressed') recompressed++;
    else if (outcome === 'not-smaller') notSmaller++;
    else skipped++;
    onPhase('images', i + 1, images.length);
  }

  const streamsCompressed = await compressPlainStreams(context);
  objectsRemoved += pruneUnreferenced(context);

  onPhase('saving');
  const out = await saveDocument(doc);

  const notes: PdfResultNote[] = [];
  if (notSmaller > 0) notes.push({ code: 'images-not-smaller', count: notSmaller });
  if (skipped > 0) notes.push({ code: 'images-skipped', count: skipped });
  if (sizeUnknown > 0) notes.push({ code: 'image-size-unknown', count: sizeUnknown });
  if (signatures > 0) notes.push({ code: 'signatures-invalidated', count: signatures });
  if (context.header.getVersionString() !== versionBefore) notes.push({ code: 'pdf-version-raised' });

  return {
    bytes: out,
    stats: {
      imagesRecompressed: recompressed,
      imagesResized: resized,
      imagesSkipped: skipped,
      imagesNotSmaller: notSmaller,
      streamsCompressed,
      objectsRemoved,
      notes,
    },
  };
}
