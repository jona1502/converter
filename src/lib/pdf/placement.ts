/**
 * Ermittelt die Darstellungsgröße von Bild-XObjects aus den Content-Streams der Seiten
 * (Operatoren q, Q, cm, Do; Form-XObjects rekursiv mit /Matrix; /UserUnit der Seite).
 *
 * Eine Darstellungsgröße gilt für ein Bild nur dann als bekannt, wenn
 * - jedes XObject-Ressourcenwörterbuch, das das Bild enthält, aus erfolgreich ausgewerteten
 *   Seiten- oder Form-Inhalten stammt, und
 * - mindestens ein Do-Aufruf des Bildes gefunden wurde.
 * Bilder in Annotations-Erscheinungsbildern, Mustern, Type3-Schriften oder Vorschaubildern
 * gelten damit als unbekannt; für sie greift nur die Pixel-Kantenbegrenzung.
 * Bekannte Restunschärfe: Teilt sich ein Muster das Ressourcenwörterbuch mit einer Seite, werden
 * Aufrufe innerhalb des Musters nicht gesehen.
 */
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from '@cantoo/pdf-lib';
import { N, numberOf, resolve } from './document';
import { PDF_LIMITS } from './limits';

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m × n in PDF-Konvention (Zeilenvektoren): erst m, dann n anwenden. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Größte Darstellung eines Bildes in Punkt (1/72 Zoll), je Bildachse. */
export interface Placement {
  readonly widthPt: number;
  readonly heightPt: number;
}

// ---------------------------------------------------------------------------------------------
// Scanner für Content-Streams
// ---------------------------------------------------------------------------------------------

type Operand = number | { readonly name: string } | null;

function isWhite(c: number | undefined): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

function isDelimiter(c: number | undefined): boolean {
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
    c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  );
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const MAX_OPERANDS = 16;

/** Überspringt Inline-Bilddaten ab pos (nach BI). Liefert die Position hinter EI. */
function skipInlineImage(bytes: Uint8Array, pos: number): number {
  const len = bytes.length;
  let i = pos;
  // "ID" als eigenes Token suchen
  while (i + 1 < len) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x44 && (isWhite(bytes[i - 1]) || isDelimiter(bytes[i - 1])) && isWhite(bytes[i + 2])) {
      break;
    }
    i++;
  }
  i += 3; // "ID" und genau ein Leerraumzeichen
  while (i + 1 < len) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      isWhite(bytes[i - 1]) &&
      (i + 2 >= len || isWhite(bytes[i + 2]) || isDelimiter(bytes[i + 2]))
    ) {
      return i + 2;
    }
    i++;
  }
  return len;
}

function decodeName(raw: string): string {
  return raw.includes('#') ? raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : raw;
}

/** Ruft onOperator für jeden Operator mit den (höchstens 16 letzten) Operanden auf. */
export function scanContent(bytes: Uint8Array, onOperator: (op: string, operands: readonly Operand[]) => void): void {
  const len = bytes.length;
  const operands: Operand[] = [];
  const push = (value: Operand): void => {
    operands.push(value);
    if (operands.length > MAX_OPERANDS) operands.shift();
  };
  let i = 0;
  while (i < len) {
    const c = bytes[i]!;
    if (isWhite(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < len && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      let depth = 1;
      i++;
      while (i < len && depth > 0) {
        const d = bytes[i]!;
        if (d === 0x5c) i++;
        else if (d === 0x28) depth++;
        else if (d === 0x29) depth--;
        i++;
      }
      push(null);
    } else if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i += 2;
      } else {
        while (i < len && bytes[i] !== 0x3e) i++;
        i++;
        push(null);
      }
    } else if (c === 0x3e) {
      i += bytes[i + 1] === 0x3e ? 2 : 1;
    } else if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i++;
    } else if (c === 0x2f) {
      const start = ++i;
      while (i < len && !isWhite(bytes[i]) && !isDelimiter(bytes[i])) i++;
      push({ name: decodeName(String.fromCharCode(...bytes.subarray(start, Math.min(i, start + 256)))) });
    } else {
      const start = i;
      while (i < len && !isWhite(bytes[i]) && !isDelimiter(bytes[i])) i++;
      if (i === start) {
        i++; // ungültiges Zeichen
        continue;
      }
      const token = String.fromCharCode(...bytes.subarray(start, Math.min(i, start + 64)));
      if (NUMBER.test(token)) {
        push(parseFloat(token));
      } else if (token === 'true' || token === 'false' || token === 'null') {
        push(null);
      } else if (token === 'BI') {
        i = skipInlineImage(bytes, i);
        operands.length = 0;
      } else {
        onOperator(token, operands);
        operands.length = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Auswertung
// ---------------------------------------------------------------------------------------------

class BudgetExceeded extends Error {}

function concatContents(context: PDFContext, contents: PDFObject | undefined, budget: { left: number }): Uint8Array | null {
  const value = resolve(context, contents);
  const streams: PDFRawStream[] = [];
  if (value instanceof PDFRawStream) streams.push(value);
  else if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      const s = resolve(context, value.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
      else return null;
    }
  } else if (value === undefined) {
    return new Uint8Array(0);
  } else {
    return null;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const stream of streams) {
    let decoded: Uint8Array;
    try {
      // Nicht erst vollständig entpacken und danach das Budget prüfen: Content-Streams
      // können bereits bei kleinen Eingabedateien sehr große Ausgaben erzeugen.
      const decoder = decodePDFRawStream(stream);
      const chunks: Uint8Array[] = [];
      let length = 0;
      let end = false;
      while (!end) {
        const chunk = new Uint8Array(Math.min(65_536, budget.left - length + 1));
        let used = 0;
        while (used < chunk.length) {
          const value = decoder.getByte();
          if (value < 0) { end = true; break; }
          chunk[used++] = value;
        }
        length += used;
        if (length > budget.left) throw new BudgetExceeded();
        chunks.push(chunk.subarray(0, used));
      }
      decoded = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        decoded.set(chunk, offset);
        offset += chunk.length;
      }
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      return null;
    }
    budget.left -= decoded.length;
    if (budget.left < 0) throw new BudgetExceeded();
    parts.push(decoded);
    total += decoded.length + 1;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
    out[offset++] = 0x0a; // Streams werden wie durch Leerraum getrennt verkettet
  }
  return out;
}

function matrixOf(context: PDFContext, obj: PDFObject | undefined): Matrix {
  const value = resolve(context, obj);
  if (!(value instanceof PDFArray) || value.size() !== 6) return IDENTITY;
  const numbers: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = numberOf(context, value.get(i));
    if (n === undefined || !Number.isFinite(n)) return IDENTITY;
    numbers.push(n);
  }
  return numbers as unknown as Matrix;
}

/**
 * Liefert für jedes Bild mit vollständig bekannter Verwendung die größte Darstellungsgröße.
 */
export function computePlacements(doc: PDFDocument): Map<PDFRef, Placement> {
  const context = doc.context;
  const found = new Map<PDFRef, { w: number; h: number }>();
  const visited = new Set<PDFDict>();
  const budget = { left: PDF_LIMITS.maxContentBytesForPlacement };

  const record = (ref: PDFRef, ctm: Matrix, unit: number): void => {
    const w = Math.hypot(ctm[0], ctm[1]) * unit;
    const h = Math.hypot(ctm[2], ctm[3]) * unit;
    if (!(w > 0.01 && h > 0.01) || !Number.isFinite(w) || !Number.isFinite(h)) return;
    const prev = found.get(ref);
    found.set(ref, prev ? { w: Math.max(prev.w, w), h: Math.max(prev.h, h) } : { w, h });
  };

  const run = (
    bytes: Uint8Array,
    resources: PDFDict | undefined,
    base: Matrix,
    unit: number,
    depth: number,
    forms: Set<PDFStream>,
  ): void => {
    const xobjects = resolve(context, resources?.get(N.XObject));
    const xdict = xobjects instanceof PDFDict ? xobjects : undefined;
    let ctm = base;
    const stack: Matrix[] = [];
    scanContent(bytes, (op, operands) => {
      if (op === 'q') {
        if (stack.length < 4096) stack.push(ctm);
      } else if (op === 'Q') {
        ctm = stack.pop() ?? ctm;
      } else if (op === 'cm') {
        const m = operands.slice(-6);
        if (m.length === 6 && m.every((v) => typeof v === 'number')) ctm = multiply(m as unknown as Matrix, ctm);
      } else if (op === 'Do') {
        const last = operands[operands.length - 1];
        if (!xdict || !last || typeof last !== 'object') return;
        const ref = xdict.get(PDFName.of(last.name));
        if (!(ref instanceof PDFRef)) return;
        const target = context.lookup(ref);
        if (!(target instanceof PDFStream)) return;
        const subtype = target.dict.get(N.Subtype);
        if (subtype === N.Image) {
          record(ref, ctm, unit);
        } else if (subtype === N.Form && depth < PDF_LIMITS.maxFormDepth && !forms.has(target)) {
          const content = concatContents(context, target, budget);
          if (!content) return;
          const formResources = resolve(context, target.dict.get(N.Resources));
          const next = new Set(forms).add(target);
          run(
            content,
            formResources instanceof PDFDict ? formResources : resources,
            multiply(matrixOf(context, target.dict.get(N.Matrix)), ctm),
            unit,
            depth + 1,
            next,
          );
        }
      }
    });
    if (xdict) visited.add(xdict);
  };

  try {
    for (const page of doc.getPages()) {
      const node = page.node;
      const content = concatContents(context, node.get(PDFName.of('Contents')), budget);
      if (!content) continue;
      const unitValue = numberOf(context, node.get(N.UserUnit));
      const unit = unitValue !== undefined && unitValue > 0 ? unitValue : 1;
      run(content, node.Resources(), IDENTITY, unit, 0, new Set());
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) return new Map();
    throw error;
  }

  // Alle XObject-Wörterbücher finden, die ein Bild enthalten.
  const containers = new Map<PDFRef, PDFDict[]>();
  const noteXObjectDict = (dict: PDFDict): void => {
    const x = resolve(context, dict.get(N.XObject));
    if (!(x instanceof PDFDict)) return;
    for (const value of x.values()) {
      if (value instanceof PDFRef) {
        const list = containers.get(value);
        if (list) list.push(x);
        else containers.set(value, [x]);
      }
    }
  };
  const walk = (obj: PDFObject, depth: number): void => {
    if (depth > 32) return;
    if (obj instanceof PDFDict) {
      if (obj.has(N.XObject)) noteXObjectDict(obj);
      for (const value of obj.values()) if (value instanceof PDFDict || value instanceof PDFArray) walk(value, depth + 1);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        if (value instanceof PDFDict || value instanceof PDFArray) walk(value, depth + 1);
      }
    } else if (obj instanceof PDFStream) {
      walk(obj.dict, depth + 1);
    }
  };
  for (const [, obj] of context.enumerateIndirectObjects()) walk(obj, 0);

  const result = new Map<PDFRef, Placement>();
  for (const [ref, size] of found) {
    const list = containers.get(ref);
    if (!list || list.length === 0 || !list.every((d) => visited.has(d))) continue;
    result.set(ref, { widthPt: size.w, heightPt: size.h });
  }
  return result;
}
