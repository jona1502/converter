import { canvasToBlob, createCanvas, getContext2D, releaseCanvas, type AnyCanvas, type AnyContext2D } from './canvas';
import { assembleIco, encodeBmp, fitIntoSquare, type IcoImage } from './custom-encoders';
import { detectFormat } from './sniff';
import { DEFAULT_ICO_SIZES, FORMAT_INFO, ImageProcessingError, type IcoSize, type OutputFormat } from './types';

export interface EncodeParams {
  /** Dekodierte, orientierungskorrigierte Quelle. */
  readonly source: ImageBitmap;
  /** Zielgröße (bei ICO ungenutzt, dort gelten icoSizes). */
  readonly width: number;
  readonly height: number;
  readonly format: OutputFormat;
  readonly quality: number;
  /** #rrggbb */
  readonly background: string;
  /** Laut Probe kann die Quelle transparente Bereiche haben. */
  readonly sourceMayHaveTransparency: boolean;
  /** Nur ICO: Größen der Einträge (Standard DEFAULT_ICO_SIZES). */
  readonly icoSizes?: readonly IcoSize[];
}

export interface EncodeOutput {
  readonly blob: Blob;
  readonly mime: string;
  readonly transparencyFlattened: boolean;
}

/** Ab dieser Fläche wird eine nicht nutzbare Canvas als Größenproblem gewertet (Safari/iOS-Grenze ≈ 16,7 MP). */
const LARGE_CANVAS_PIXELS = 4096 * 4096;

function unusableCanvas(width: number, height: number): ImageProcessingError {
  return width * height > LARGE_CANVAS_PIXELS
    ? new ImageProcessingError('dimensions-too-large', `Canvas mit ${width} × ${height} px ist in diesem Browser nicht nutzbar.`)
    : new ImageProcessingError('encode-failed', 'Canvas ist in diesem Kontext nicht nutzbar.');
}

function prepare(ctx: AnyContext2D): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

/**
 * Prüft ein Kodierergebnis: leer -> 'encode-failed', falscher MIME-Typ -> 'encode-unsupported'
 * (kein stiller Formatwechsel), Signatur passt nicht zum Format -> 'encode-failed'.
 * Gibt den geprüften Blob zurück (blob.type entspricht FORMAT_INFO[format].mime).
 */
export async function verifyEncodedBlob(blob: Blob | null, format: OutputFormat): Promise<Blob> {
  const { mime } = FORMAT_INFO[format];
  if (!blob || blob.size === 0) throw new ImageProcessingError('encode-failed', 'Der Browser lieferte ein leeres Ergebnis.');
  if (blob.type !== mime) {
    throw new ImageProcessingError('encode-unsupported', `Erwartet ${mime}, erhalten ${blob.type || 'unbekannt'}.`);
  }
  let head: Uint8Array;
  try {
    head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  } catch (error) {
    throw new ImageProcessingError('encode-failed', `Ergebnis nicht lesbar: ${String(error)}`);
  }
  const detected: string | null = detectFormat(head);
  if (detected !== format) {
    throw new ImageProcessingError('encode-failed', `Ergebnis hat nicht die Signatur von ${mime}.`);
  }
  return blob;
}

/**
 * Verkleinert stark verkleinerte Quellen schrittweise um je die Hälfte, bevor der letzte Schritt
 * auf die Zielgröße zeichnet. Das vermeidet Aliasing bei Browsern, deren Zeichenfilter bei
 * Faktoren < 0,5 nur wenige Quellpixel berücksichtigt. Fehlschläge fallen auf direktes Zeichnen zurück.
 */
function downscaleSteps(source: ImageBitmap, width: number, height: number, temps: AnyCanvas[]): CanvasImageSource {
  let current: CanvasImageSource = source;
  let cw = source.width;
  let ch = source.height;
  while (cw >= width * 2 || ch >= height * 2) {
    const nw = cw >= width * 2 ? Math.floor(cw / 2) : cw;
    const nh = ch >= height * 2 ? Math.floor(ch / 2) : ch;
    const canvas = createCanvas(nw, nh);
    const ctx = canvas ? getContext2D(canvas) : null;
    if (!canvas || !ctx) {
      releaseCanvas(canvas);
      break;
    }
    // Vor dem Zeichnen registrieren, damit die Canvas auch bei einem Fehler freigegeben wird.
    temps.push(canvas);
    prepare(ctx);
    ctx.drawImage(current, 0, 0, nw, nh);
    // Die vorherige Zwischenstufe wird nicht mehr gebraucht.
    for (const previous of temps.splice(0, temps.length - 1)) releaseCanvas(previous);
    current = canvas;
    cw = nw;
    ch = nh;
  }
  return current;
}

/** Pixel je getImageData-Aufruf: begrenzt den Zusatzspeicher bei der Alpha-Prüfung auf wenige MB. */
const ALPHA_SCAN_PIXELS_PER_STRIP = 1 << 20;

/**
 * Prüft streifenweise, ob die Canvas irgendein nicht vollständig deckendes Pixel enthält.
 * Bei einem Lesefehler wird vorsichtshalber true angenommen.
 */
function hasTranslucentPixels(ctx: AnyContext2D, width: number, height: number): boolean {
  const rows = Math.max(1, Math.floor(ALPHA_SCAN_PIXELS_PER_STRIP / width));
  try {
    for (let y = 0; y < height; y += rows) {
      const h = Math.min(rows, height - y);
      const data = ctx.getImageData(0, y, width, h).data;
      for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 255) < 255) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** Zeichnet die (ggf. schrittweise verkleinerte) Quelle in das Rechteck dx, dy, dw, dh. */
function drawScaled(ctx: AnyContext2D, source: ImageBitmap, dx: number, dy: number, dw: number, dh: number): void {
  const temps: AnyCanvas[] = [];
  try {
    const drawSource = downscaleSteps(source, dw, dh, temps);
    prepare(ctx);
    ctx.drawImage(drawSource, dx, dy, dw, dh);
  } finally {
    for (const t of temps) releaseCanvas(t);
  }
}

/**
 * Legt den Hintergrund hinter den vorhandenen Inhalt (entspricht Füllen vor dem Zeichnen).
 * Liefert, ob vorher tatsächlich (teil)transparente Pixel vorhanden waren – der Header allein
 * (z. B. RGBA-PNG) sagt das nicht sicher.
 */
function flatten(ctx: AnyContext2D, width: number, height: number, background: string, check: boolean): boolean {
  const translucent = check && hasTranslucentPixels(ctx, width, height);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  return translucent;
}

async function toBlobChecked(canvas: AnyCanvas, mime: string, quality: number | undefined, large: boolean, w: number, h: number): Promise<Blob | null> {
  let blob: Blob | null;
  try {
    blob = await canvasToBlob(canvas, mime, quality);
  } catch (error) {
    if (large) throw unusableCanvas(w, h);
    throw new ImageProcessingError('encode-failed', `Kodierung fehlgeschlagen: ${String(error)}`);
  }
  // Leeres Ergebnis bei großer Fläche: typische Canvas-Flächengrenze (z. B. Safari).
  if ((!blob || blob.size === 0) && large) throw unusableCanvas(w, h);
  return blob;
}

/** ICO: je Größe ein quadratisches, transparent umrandetes PNG; danach Zusammenbau. */
async function encodeIco(source: ImageBitmap, sizes: readonly IcoSize[]): Promise<Blob> {
  const images: IcoImage[] = [];
  for (const size of sizes) {
    const canvas = createCanvas(size, size);
    try {
      const ctx = canvas ? getContext2D(canvas) : null;
      if (!canvas || !ctx) throw unusableCanvas(size, size);
      const fit = fitIntoSquare(source.width, source.height, size);
      drawScaled(ctx, source, fit.x, fit.y, fit.width, fit.height);
      const png = await verifyEncodedBlob(await toBlobChecked(canvas, FORMAT_INFO.png.mime, undefined, false, size, size), 'png');
      images.push({ size, png });
    } finally {
      releaseCanvas(canvas);
    }
  }
  return assembleIco(images);
}

/** Zeichnet die Quelle in Zielgröße und kodiert sie im Zielformat. */
export async function encodeImage(params: EncodeParams): Promise<EncodeOutput> {
  const { source, width, height, format, quality, background } = params;
  const info = FORMAT_INFO[format];

  if (format === 'ico') {
    const blob = await encodeIco(source, params.icoSizes ?? DEFAULT_ICO_SIZES);
    const verified = await verifyEncodedBlob(blob, 'ico');
    return { blob: verified, mime: verified.type, transparencyFlattened: false };
  }

  const large = width * height > LARGE_CANVAS_PIXELS;
  let target: AnyCanvas | null = null;
  try {
    target = createCanvas(width, height);
    const ctx = target ? getContext2D(target) : null;
    if (!target || !ctx) throw unusableCanvas(width, height);
    drawScaled(ctx, source, 0, 0, width, height);

    const transparencyFlattened = info.supportsTransparency
      ? false
      : flatten(ctx, width, height, background, params.sourceMayHaveTransparency);

    let blob: Blob | null;
    if (format === 'bmp') {
      try {
        blob = encodeBmp(ctx, width, height);
      } catch (error) {
        if (large) throw unusableCanvas(width, height);
        throw new ImageProcessingError('encode-failed', `BMP-Kodierung fehlgeschlagen: ${String(error)}`);
      }
    } else {
      blob = await toBlobChecked(target, info.mime, info.supportsQuality ? quality : undefined, large, width, height);
    }
    const verified = await verifyEncodedBlob(blob, format);
    return { blob: verified, mime: verified.type, transparencyFlattened };
  } finally {
    releaseCanvas(target);
  }
}
