/**
 * Laden, Prüfen und Auswerten der Objekttabelle mit @cantoo/pdf-lib.
 */
import {
  EncryptedPDFError,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from '@cantoo/pdf-lib';
import { PDF_LIMITS } from './limits';
import { findPdfSignature } from './signature';
import { PdfProcessingError, type PdfImageFilterKind, type PdfImageSkipReason } from './types';

export const N = {
  Type: PDFName.of('Type'),
  Subtype: PDFName.of('Subtype'),
  Image: PDFName.of('Image'),
  Form: PDFName.of('Form'),
  XObject: PDFName.of('XObject'),
  Filter: PDFName.of('Filter'),
  DecodeParms: PDFName.of('DecodeParms'),
  Width: PDFName.of('Width'),
  Height: PDFName.of('Height'),
  ColorSpace: PDFName.of('ColorSpace'),
  BitsPerComponent: PDFName.of('BitsPerComponent'),
  Decode: PDFName.of('Decode'),
  ImageMask: PDFName.of('ImageMask'),
  Mask: PDFName.of('Mask'),
  SMask: PDFName.of('SMask'),
  Matte: PDFName.of('Matte'),
  Length: PDFName.of('Length'),
  Predictor: PDFName.of('Predictor'),
  Colors: PDFName.of('Colors'),
  Columns: PDFName.of('Columns'),
  N: PDFName.of('N'),
  DCTDecode: PDFName.of('DCTDecode'),
  FlateDecode: PDFName.of('FlateDecode'),
  DeviceRGB: PDFName.of('DeviceRGB'),
  DeviceGray: PDFName.of('DeviceGray'),
  DeviceCMYK: PDFName.of('DeviceCMYK'),
  ICCBased: PDFName.of('ICCBased'),
  Metadata: PDFName.of('Metadata'),
  XRef: PDFName.of('XRef'),
  ObjStm: PDFName.of('ObjStm'),
  FontDescriptor: PDFName.of('FontDescriptor'),
  FontFile: PDFName.of('FontFile'),
  FontFile2: PDFName.of('FontFile2'),
  FontFile3: PDFName.of('FontFile3'),
  ByteRange: PDFName.of('ByteRange'),
  Resources: PDFName.of('Resources'),
  Matrix: PDFName.of('Matrix'),
  UserUnit: PDFName.of('UserUnit'),
} as const;

// ---------------------------------------------------------------------------------------------
// Eingangsprüfung und Laden
// ---------------------------------------------------------------------------------------------

export function checkFileSize(size: number): void {
  if (size > PDF_LIMITS.maxFileBytes) {
    throw new PdfProcessingError('file-too-large', `Datei hat ${size} Bytes, erlaubt sind ${PDF_LIMITS.maxFileBytes}.`);
  }
}

export { findPdfSignature };

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  checkFileSize(file.size);
  const head = new Uint8Array(await file.slice(0, PDF_LIMITS.signatureSearchBytes).arrayBuffer());
  if (findPdfSignature(head) < 0) throw new PdfProcessingError('not-pdf', 'Keine %PDF--Signatur am Dateianfang.');
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Lädt das Dokument ohne Veränderungen an Metadaten (kein Producer/ModDate) und ohne XFA zu
 * entfernen. Verschlüsselte Dateien werden abgelehnt, auch bei leerem Benutzerpasswort:
 * ignoreEncryption würde verschlüsselte Streams als Rohbytes behandeln und sie verfälschen.
 */
export async function loadPdfDocument(bytes: Uint8Array): Promise<PDFDocument> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      preserveXFA: true,
      ignoreEncryption: false,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    if (error instanceof EncryptedPDFError) throw new PdfProcessingError('encrypted', 'Dokument ist verschlüsselt.');
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new PdfProcessingError('parse-failed', message);
  }
  if (doc.isEncrypted) throw new PdfProcessingError('encrypted', 'Dokument ist verschlüsselt.');
  let pages = 0;
  try {
    pages = doc.getPageCount();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PdfProcessingError('parse-failed', `Seitenbaum nicht lesbar: ${message}`);
  }
  if (pages < 1) throw new PdfProcessingError('parse-failed', 'Dokument enthält keine lesbaren Seiten.');
  return doc;
}

// ---------------------------------------------------------------------------------------------
// Hilfsfunktionen für Objekte
// ---------------------------------------------------------------------------------------------

export function resolve(context: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  if (obj instanceof PDFRef) return context.lookup(obj);
  return obj;
}

function numberOf(context: PDFContext, obj: PDFObject | undefined): number | undefined {
  const value = resolve(context, obj);
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

function isEmptyParams(context: PDFContext, obj: PDFObject | undefined): boolean {
  const value = resolve(context, obj);
  if (value === undefined) return true;
  if (value instanceof PDFDict) return value.keys().length === 0;
  if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) if (!isEmptyParams(context, value.get(i))) return false;
    return true;
  }
  return value.toString() === 'null';
}

// ---------------------------------------------------------------------------------------------
// Bild-XObjects
// ---------------------------------------------------------------------------------------------

export interface ImageRecord {
  readonly ref: PDFRef;
  readonly stream: PDFRawStream;
  readonly width: number;
  readonly height: number;
  readonly filter: PdfImageFilterKind;
  /** Farbmodell der Bilddaten, falls neu kodierbar. */
  readonly color: 'rgb' | 'gray' | null;
  /** ColorSpace-Eintrag behalten (DeviceRGB bzw. ICCBased mit 3 Kanälen). */
  readonly keepColorSpace: boolean;
  /** PNG-Predictor aktiv (nur Flate). */
  readonly pngPredictor: boolean;
  readonly skip: PdfImageSkipReason | null;
  /** Gespeicherte Bytes des Bildes. */
  readonly bytes: number;
  readonly smask: { readonly ref: PDFRef; readonly stream: PDFRawStream; readonly shared: boolean } | null;
}

export interface ImageInventory {
  readonly images: ImageRecord[];
  readonly maskCount: number;
  readonly maskBytes: number;
}

function isImageStream(obj: PDFObject | undefined): obj is PDFRawStream {
  return obj instanceof PDFRawStream && obj.dict.get(N.Subtype) === N.Image;
}

function filterNames(context: PDFContext, dict: PDFDict): PDFName[] | null {
  const filter = resolve(context, dict.get(N.Filter));
  if (filter === undefined) return [];
  if (filter instanceof PDFName) return [filter];
  if (filter instanceof PDFArray) {
    const names: PDFName[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const name = resolve(context, filter.get(i));
      if (!(name instanceof PDFName)) return null;
      names.push(name);
    }
    return names;
  }
  return null;
}

function filterKind(names: PDFName[] | null): PdfImageFilterKind {
  if (names === null) return 'other';
  if (names.length === 0) return 'none';
  if (names.length === 1 && names[0] === N.DCTDecode) return 'dct';
  if (names.length === 1 && names[0] === N.FlateDecode) return 'flate';
  return 'other';
}

type ColorClass = { kind: 'rgb' | 'gray'; keep: boolean } | { kind: 'cmyk' } | { kind: 'other' };

function classifyColorSpace(context: PDFContext, obj: PDFObject | undefined): ColorClass {
  const cs = resolve(context, obj);
  if (cs === N.DeviceRGB) return { kind: 'rgb', keep: true };
  if (cs === N.DeviceGray) return { kind: 'gray', keep: false };
  if (cs === N.DeviceCMYK) return { kind: 'cmyk' };
  if (cs instanceof PDFArray && cs.size() >= 2 && resolve(context, cs.get(0)) === N.ICCBased) {
    const profile = resolve(context, cs.get(1));
    const n = profile instanceof PDFStream ? numberOf(context, profile.dict.get(N.N)) : undefined;
    // Die Bildwerte bleiben in den Kanälen des ICC-Profils; der Eintrag wird unverändert übernommen.
    // Canvas liefert sRGB-JPEGs. Ein ursprüngliches ICC-Profil beizubehalten würde diese
    // Kanalwerte fälschlich im alten Farbraum interpretieren. Daher konservativ überspringen.
    if (n === 4) return { kind: 'cmyk' };
  }
  return { kind: 'other' };
}

function isDefaultDecode(context: PDFContext, obj: PDFObject | undefined, components: number): boolean {
  const decode = resolve(context, obj);
  if (decode === undefined) return true;
  if (!(decode instanceof PDFArray) || decode.size() !== components * 2) return false;
  for (let i = 0; i < decode.size(); i++) {
    if (numberOf(context, decode.get(i)) !== (i % 2 === 0 ? 0 : 1)) return false;
  }
  return true;
}

/** Prüft DecodeParms für Flate: kein Predictor oder PNG-Predictor passend zu den Bilddaten. */
function flatePredictor(context: PDFContext, dict: PDFDict, components: number, width: number): 'none' | 'png' | null {
  let params = resolve(context, dict.get(N.DecodeParms));
  if (params instanceof PDFArray) params = params.size() === 1 ? resolve(context, params.get(0)) : undefined;
  if (params === undefined || !(params instanceof PDFDict)) {
    return isEmptyParams(context, dict.get(N.DecodeParms)) ? 'none' : null;
  }
  const predictor = numberOf(context, params.get(N.Predictor)) ?? 1;
  if (predictor === 1) return 'none';
  if (predictor < 10 || predictor > 15) return null; // nur definierte PNG-Predictoren
  const colors = numberOf(context, params.get(N.Colors)) ?? 1;
  const bpc = numberOf(context, params.get(N.BitsPerComponent)) ?? 8;
  const columns = numberOf(context, params.get(N.Columns)) ?? 1;
  return colors === components && bpc === 8 && columns === width ? 'png' : null;
}

function positiveInt(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value > 0 && value <= 1_000_000 ? value : null;
}

/** Ermittelt alle Bild-XObjects (ohne reine Masken) samt Einstufung. */
export function collectImages(context: PDFContext): ImageInventory {
  const candidates: [PDFRef, PDFRawStream][] = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (isImageStream(obj)) candidates.push([ref, obj]);
  }
  const maskRefs = new Set<PDFRef>();
  const smaskUses = new Map<PDFRef, number>();
  for (const [, stream] of candidates) {
    const smask = stream.dict.get(N.SMask);
    if (smask instanceof PDFRef) {
      maskRefs.add(smask);
      smaskUses.set(smask, (smaskUses.get(smask) ?? 0) + 1);
    }
    const mask = stream.dict.get(N.Mask);
    if (mask instanceof PDFRef) maskRefs.add(mask);
  }

  const images: ImageRecord[] = [];
  let maskCount = 0;
  let maskBytes = 0;
  for (const [ref, stream] of candidates) {
    if (maskRefs.has(ref)) {
      maskCount++;
      maskBytes += stream.getContentsSize();
      continue;
    }
    const dict = stream.dict;
    const width = positiveInt(numberOf(context, dict.get(N.Width)));
    const height = positiveInt(numberOf(context, dict.get(N.Height)));
    const names = filterNames(context, dict);
    const filter = filterKind(names);
    const color = classifyColorSpace(context, dict.get(N.ColorSpace));
    const components = color.kind === 'rgb' ? 3 : color.kind === 'gray' ? 1 : color.kind === 'cmyk' ? 4 : 0;
    const imageMask = resolve(context, dict.get(N.ImageMask));
    const bpc = numberOf(context, dict.get(N.BitsPerComponent));

    let skip: PdfImageSkipReason | null = null;
    let pngPredictor = false;
    if (width === null || height === null) skip = 'invalid-dict';
    else if (imageMask instanceof PDFBool && imageMask.asBoolean()) skip = 'image-mask';
    else if (filter === 'other') skip = 'filter';
    else if (color.kind === 'cmyk') skip = 'cmyk';
    else if (color.kind === 'other') skip = 'colorspace';
    else if (bpc !== 8) skip = 'bits-per-component';
    else if (!isDefaultDecode(context, dict.get(N.Decode), components)) skip = 'decode-array';
    else if (dict.get(N.Mask) !== undefined || (dict.has(N.SMask) && dict.get(N.SMask) !== PDFName.of('None'))) skip = 'mask';
    else if (filter === 'dct' && !isEmptyParams(context, dict.get(N.DecodeParms))) skip = 'decode-parms';
    else if (filter !== 'dct') {
      const predictor = flatePredictor(context, dict, components, width);
      if (predictor === null) skip = 'decode-parms';
      else pngPredictor = predictor === 'png';
    }
    if (skip === null && width !== null && height !== null && width * height > PDF_LIMITS.maxImagePixels) {
      skip = 'too-many-pixels';
    }

    const smaskRef = dict.get(N.SMask);
    const smaskObj = smaskRef instanceof PDFRef ? context.lookup(smaskRef) : undefined;
    const smask =
      smaskRef instanceof PDFRef && smaskObj instanceof PDFRawStream
        ? { ref: smaskRef, stream: smaskObj, shared: (smaskUses.get(smaskRef) ?? 0) > 1 }
        : null;

    images.push({
      ref,
      stream,
      width: width ?? 0,
      height: height ?? 0,
      filter,
      color: skip === null && (color.kind === 'rgb' || color.kind === 'gray') ? color.kind : null,
      keepColorSpace: color.kind === 'rgb' && color.keep,
      pngPredictor,
      skip,
      bytes: stream.getContentsSize(),
      smask,
    });
  }
  return { images, maskCount, maskBytes };
}

/** Prüft, ob eine Soft-Mask als 8-bit-Graustufen (Flate oder unkomprimiert) neu geschrieben werden kann. */
export function smaskRewritable(
  context: PDFContext,
  stream: PDFRawStream,
): { width: number; height: number; pngPredictor: boolean } | null {
  const dict = stream.dict;
  const width = positiveInt(numberOf(context, dict.get(N.Width)));
  const height = positiveInt(numberOf(context, dict.get(N.Height)));
  if (width === null || height === null || width * height > PDF_LIMITS.maxImagePixels) return null;
  const kind = filterKind(filterNames(context, dict));
  if (kind !== 'flate' && kind !== 'none') return null;
  if (resolve(context, dict.get(N.ColorSpace)) !== N.DeviceGray) return null;
  if (numberOf(context, dict.get(N.BitsPerComponent)) !== 8) return null;
  if (!isDefaultDecode(context, dict.get(N.Decode), 1)) return null;
  if (dict.get(N.Matte) !== undefined) return null; // vorgemischte Farben: Maske unverändert lassen
  const predictor = flatePredictor(context, dict, 1, width);
  if (predictor === null) return null;
  return { width, height, pngPredictor: predictor === 'png' };
}

// ---------------------------------------------------------------------------------------------
// Schriften, Signaturen
// ---------------------------------------------------------------------------------------------

export function embeddedFontBytes(context: PDFContext): number {
  const seen = new Set<PDFObject>();
  let bytes = 0;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : undefined;
    if (!dict || dict.get(N.Type) !== N.FontDescriptor) continue;
    for (const key of [N.FontFile, N.FontFile2, N.FontFile3]) {
      const file = resolve(context, dict.get(key));
      if (file instanceof PDFRawStream && !seen.has(file)) {
        seen.add(file);
        bytes += file.getContentsSize();
      }
    }
  }
  return bytes;
}

/** Anzahl der Signaturwörterbücher (/ByteRange); deren Signatur wird durch Neuschreiben ungültig. */
export function countSignatures(context: PDFContext): number {
  let count = 0;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && !(obj instanceof PDFStream) && obj.get(N.ByteRange) instanceof PDFArray) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Unreferenzierte Objekte
// ---------------------------------------------------------------------------------------------

/**
 * Entfernt Objekte, die vom Trailer (Root, Info) aus nicht erreichbar sind – z. B. Altstände
 * inkrementeller Updates, Linearisierungs-Wörterbücher oder verwaiste Ressourcen. Ohne Root wird
 * nichts entfernt. Liefert die Zahl entfernter Objekte.
 */
export function pruneUnreferenced(context: PDFContext): number {
  const root = context.trailerInfo.Root;
  if (!(root instanceof PDFRef) || context.lookup(root) === undefined) return 0;
  const reachable = new Set<PDFRef>();
  const stack: PDFObject[] = [root];
  const info = context.trailerInfo.Info;
  if (info) stack.push(info);
  const encrypt = context.trailerInfo.Encrypt;
  if (encrypt) stack.push(encrypt);
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      if (reachable.has(obj)) continue;
      reachable.add(obj);
      const target = context.lookup(obj);
      if (target !== undefined) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const value of obj.values()) stack.push(value);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    }
  }
  let removed = 0;
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (reachable.has(ref)) continue;
    context.delete(ref);
    // Alte Querverweis- und Objekt-Streams schreibt pdf-lib ohnehin neu; sie zählen nicht als Ersparnis.
    const type = obj instanceof PDFRawStream ? obj.dict.get(N.Type) : undefined;
    if (type !== N.XRef && type !== N.ObjStm) removed++;
  }
  return removed;
}

export { numberOf };
