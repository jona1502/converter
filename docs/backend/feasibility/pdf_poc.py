"""B01-PoC PDF: Analyse und konservative Bildstream-Neukodierung mit pikepdf + Pillow.

Wegwerfcode. Fixtures werden hier erzeugt; jeder Fehlschlag endet mit Exit != 0.
pypdfium2 dient nur als unabhängiger Test-Renderer.
"""

from __future__ import annotations

import io
import math
import os
import random
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Array, Dictionary, Name, Pdf, Stream, String
from PIL import Image, ImageChops, ImageCms, ImageFilter, ImageStat

OUT = Path(os.environ.get("POC_OUT", "/tmp/out")) / "pdf"
OUT.mkdir(parents=True, exist_ok=True)

MAX_DEPTH = 10
MIN_DOWNSCALE = 0.9  # Vertrag: verkleinern nur bei Faktor <= 0,9, sonst Pixelgröße behalten
# Gegenprobe: POC_SWAP=cm bzw. POC_SWAP=form vertauscht die Matrixreihenfolge (CTM x M statt M x CTM)
# nur beim Operator cm bzw. nur bei der Form-/Matrix -> Asserts müssen jeweils scheitern.
SWAP = os.environ.get("POC_SWAP", "")
assert SWAP in ("", "cm", "form"), SWAP
RNG = random.Random(1)
MAX_PIXELS = 40_000_000
MIN_SAVING = 0.97  # ersetzen nur, wenn neu <= 97 % alt
LEVELS = {"high": (300, 3600, 0.85), "balanced": (150, 2000, 0.72), "small": (100, 1300, 0.55)}
IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
TEXT = "B01 Machbarkeitstext"


def jpeg_quality(q: float) -> int:
    """0..1 -> Pillow-JPEG-quality 1..95 (round(q*100), begrenzt)."""
    return max(1, min(95, round(q * 100)))


# ---------------------------------------------------------------- Fixtures
def noise(size: tuple[int, int], lo: int, hi: int) -> Image.Image:
    """Deterministisches Gleichverteilungsrauschen (Image.effect_noise ignoriert random.seed)."""
    span = hi - lo + 1
    data = bytes(lo + (v % span) for v in RNG.randbytes(size[0] * size[1]))
    return Image.frombytes("L", size, data)


def photo(size: tuple[int, int], mode: str = "RGB") -> Image.Image:
    r = Image.linear_gradient("L").resize(size)
    g = Image.radial_gradient("L").resize(size)
    b = noise(size, 0, 255).filter(ImageFilter.GaussianBlur(3))
    im = Image.merge("RGB", (r, g, b))
    n = noise(size, 76, 180)
    im = Image.blend(im, Image.merge("RGB", (n, n, n)), 0.2)
    return im.convert(mode)


def img_stream(pdf: Pdf, data: bytes, w: int, h: int, cs: object, flt: Name, **extra: object) -> Stream:
    s = Stream(pdf, b"")
    s.write(data, filter=flt)
    s.Type, s.Subtype = Name.XObject, Name.Image
    s.Width, s.Height, s.ColorSpace, s.BitsPerComponent = w, h, cs, 8
    for k, v in extra.items():
        s[Name("/" + k)] = v
    return pdf.make_indirect(s)


def flate(pdf: Pdf, im: Image.Image, cs: object | None = None, **extra: object) -> Stream:
    cs = cs or (Name.DeviceGray if im.mode == "L" else Name.DeviceRGB)
    return img_stream(pdf, zlib.compress(im.tobytes(), 6), im.width, im.height, cs, Name.FlateDecode, **extra)


def jpeg(pdf: Pdf, im: Image.Image, q: int = 95) -> Stream:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=q)
    cs = Name.DeviceGray if im.mode == "L" else Name.DeviceRGB
    return img_stream(pdf, buf.getvalue(), im.width, im.height, cs, Name.DCTDecode)


def form(pdf: Pdf, content: bytes, xobjects: dict[str, object], matrix: list[float] | None = None) -> Stream:
    f = pdf.make_indirect(Stream(pdf, content))
    f.Type, f.Subtype = Name.XObject, Name.Form
    f.BBox = Array([-1000, -1000, 2000, 2000])
    f.Resources = Dictionary(XObject=Dictionary({"/" + k: v for k, v in xobjects.items()}))
    if matrix:
        f.Matrix = Array(matrix)
    return f


def png_predict(raw: bytes, stride: int, bpp: int) -> bytes:
    """PNG-Prädiktor (PDF /Predictor 10..15): Zeilenfilter 0..4 zyklisch je Zeile."""
    out = bytearray()
    prev = bytes(stride)
    for y in range(len(raw) // stride):
        cur = raw[y * stride:(y + 1) * stride]
        ft = y % 5
        row = bytearray([ft])
        for i in range(stride):
            a = cur[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if ft == 0:
                pred = 0
            elif ft == 1:
                pred = a
            elif ft == 2:
                pred = b
            elif ft == 3:
                pred = (a + b) >> 1
            else:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
            row.append((cur[i] - pred) & 0xFF)
        out += row
        prev = cur
    return bytes(out)


def tiff_predict(raw: bytes, stride: int, bpp: int) -> bytes:
    """TIFF-Prädiktor 2 (horizontale Differenz, 8 bit)."""
    out = bytearray()
    for y in range(len(raw) // stride):
        cur = raw[y * stride:(y + 1) * stride]
        out += bytes((cur[i] - (cur[i - bpp] if i >= bpp else 0)) & 0xFF for i in range(stride))
    return bytes(out)


def build_fixture(path: Path) -> dict[str, bytes]:
    RNG.seed(1)
    pdf = Pdf.new()
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))

    im_a = jpeg(pdf, photo((1200, 800)))                       # DCT RGB, 2x platziert
    im_b = flate(pdf, photo((1000, 1000)))                     # Flate RGB in Form-XObject
    im_c = flate(pdf, photo((800, 600), "L"))                  # Flate Gray
    smask = flate(pdf, Image.radial_gradient("L").resize((400, 400)))
    im_d = flate(pdf, photo((400, 400)), SMask=smask)          # mit SMask -> unverändert
    pal = Image.new("P", (64, 64))
    pal.putdata([(x // 16 + y // 16) % 4 for y in range(64) for x in range(64)])
    idx_cs = Array([Name.Indexed, Name.DeviceRGB, 3, String(bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]))])
    im_e = img_stream(pdf, zlib.compress(pal.tobytes()), 64, 64, idx_cs, Name.FlateDecode)
    icc_bytes = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    icc_bytes[24:36] = bytes(12)  # ICC-Header-Erstellungsdatum nullen -> deterministische Fixture
    icc = pdf.make_indirect(Stream(pdf, bytes(icc_bytes)))
    icc.N = 3
    im_f = flate(pdf, photo((300, 300)), cs=Array([Name.ICCBased, icc]))
    g_im = photo((600, 450))                                   # Flate + PNG-Prädiktor (Filter 0..4 gemischt)
    im_g = img_stream(pdf, zlib.compress(png_predict(g_im.tobytes(), 1800, 3)), 600, 450, Name.DeviceRGB, Name.FlateDecode,
                      DecodeParms=Dictionary(Predictor=15, Colors=3, BitsPerComponent=8, Columns=600))
    k_im = photo((200, 100))                                   # Flate + TIFF-Prädiktor 2 -> bleibt unverändert
    im_k = img_stream(pdf, zlib.compress(tiff_predict(k_im.tobytes(), 600, 3)), 200, 100, Name.DeviceRGB, Name.FlateDecode,
                      DecodeParms=Dictionary(Predictor=2, Colors=3, BitsPerComponent=8, Columns=200))
    im_h = flate(pdf, photo((4000, 400)))                      # nur tief verschachtelt platziert -> unsicher, Kantengrenze
    im_j = flate(pdf, photo((800, 200)))                       # ungleichmäßig skaliert + gedreht (Matrixreihenfolge)
    im_l = flate(pdf, photo((400, 100)))                       # zwei nicht kommutierende cm im selben Stream
    im_m = flate(pdf, photo((620, 620)))                       # Faktor 0,968 in high -> keine Verkleinerung
    im_i = jpeg(pdf, photo((300, 200)), q=30)                  # schon stark komprimiert -> keine 3 % Einsparung

    # Seite 1: Text, Vektor, Link, Formularfeld, ImA zweimal, ImB via gedrehtem Form-XObject
    fm1 = form(pdf, b"q 400 0 0 400 0 0 cm /ImB Do Q", {"ImB": im_b}, [0.5, 0, 0, 0.5, 0, 0])
    p1 = pdf.add_blank_page(page_size=(612, 792))
    # ImJ: Bildmatrix S=[100 0 0 100] (Form-Inhalt), Form-/Matrix F=[2 0 0 0.5], Seiten-cm R=[0.8 0.6 -0.6 0.8 330 480]
    # (Drehung um ~36,87°, cos=0.8, sin=0.6 exakt). Richtig (PDF: Bild->Gerät = S x F x R):
    #   S x F = [200 0 0 50]; Zeile 1: 200*(0.8, 0.6) -> Länge 200 pt; Zeile 2: 50*(-0.6, 0.8) -> Länge 50 pt
    #   DPI = min(800*72/200, 200*72/50) = min(288, 288) = 288.
    # Vertauscht (R x F x S): R x F = [[1.6, 0.3], [-1.2, 0.4]] x 100 -> Längen sqrt(160^2+30^2)=162.79 und
    #   sqrt(120^2+40^2)=126.49 pt -> DPI = min(353.8, 113.8) = 113.8 != 288 -> Assert schlägt fehl (POC_SWAP=form).
    #   Bei POC_SWAP=cm bleibt ImJ korrekt (inneres cm gleichmäßig) -> dafür ImL:
    # ImL (400x100): "q R cm S2 cm /ImL Do Q" mit R=[0.8 0.6 -0.6 0.8 72 60], S2=[200 0 0 50 0 0].
    #   Richtig: CTM = S2 x R -> Zeilen 200*(0.8, 0.6) und 50*(-0.6, 0.8) -> 200 x 50 pt
    #   -> DPI = min(400*72/200, 100*72/50) = min(144, 144) = 144.
    #   Vertauscht (R x S2): [[160, 30], [-120, 40]] -> 162.79 x 126.49 pt -> DPI = min(176.9, 56.9) = 56.9 != 144.
    fmj = form(pdf, b"q 100 0 0 100 0 0 cm /ImJ Do Q", {"ImJ": im_j}, [2, 0, 0, 0.5, 0, 0])
    p1.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(ImA=im_a, Fm1=fm1, FmJ=fmj, ImL=im_l))
    p1.Contents = pdf.make_stream(
        b"BT /F1 24 Tf 72 740 Td (" + TEXT.encode() + b") Tj ET\n"
        b"0 0 1 rg 72 600 120 30 re f\n"
        b"q 288 0 0 192 72 380 cm /ImA Do Q\n"
        b"q 144 0 0 96 400 380 cm /ImA Do Q\n"
        b"q 0 1 -1 0 500 60 cm /Fm1 Do Q\n"
        b"q 0.8 0.6 -0.6 0.8 330 480 cm /FmJ Do Q\n"
        b"q 0.8 0.6 -0.6 0.8 72 60 cm 200 0 0 50 0 0 cm /ImL Do Q\n"
    )
    link = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array([72, 735, 350, 765]),
                                        Border=Array([0, 0, 0]), A=Dictionary(S=Name.URI, URI=String("https://example.org/b01"))))
    field_ = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String("kunde"),
                                          V=String("Muster"), Rect=Array([72, 650, 300, 675]), F=4,
                                          DA=String("/Helv 12 Tf 0 g"), P=p1.obj))
    p1.Annots = Array([link, field_])
    pdf.Root.AcroForm = Dictionary(Fields=Array([field_]), NeedAppearances=True, DA=String("/Helv 12 Tf 0 g"),
                                   DR=Dictionary(Font=Dictionary(Helv=font)))

    # Seite 2: Gray, SMask, Indexed, ICCBased, Predictor
    p2 = pdf.add_blank_page(page_size=(612, 792))
    p2.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(ImC=im_c, ImD=im_d, ImE=im_e, ImF=im_f, ImG=im_g, ImI=im_i, ImK=im_k))
    p2.Contents = pdf.make_stream(
        b"BT /F1 14 Tf 72 760 Td (Seite 2) Tj ET\n"
        b"q 192 0 0 144 72 560 cm /ImC Do Q\nq 200 0 0 200 300 560 cm /ImD Do Q\n"
        b"q 100 0 0 100 72 400 cm /ImE Do Q\nq 150 0 0 150 200 400 cm /ImF Do Q\n"
        b"q 288 0 0 216 320 180 cm /ImG Do Q\nq 216 0 0 144 72 200 cm /ImI Do Q\n"
        b"q 100 0 0 50 72 100 cm /ImK Do Q\n"
    )

    # Seite 3 (A4, /Rotate 90): Zyklus, zu tiefe Verschachtelung, Inline-Image
    deepest = form(pdf, b"q 400 0 0 40 100 300 cm /ImH Do Q", {"ImH": im_h})
    cur = deepest
    for _ in range(14):
        cur = form(pdf, b"/N Do", {"N": cur})
    cyc = form(pdf, b"q 0.9 0 0 0.9 10 10 cm /Self Do Q", {})
    cyc.Resources.XObject.Self = cyc
    p3 = pdf.add_blank_page(page_size=(595.28, 841.89))
    p3.Rotate = 90
    p3.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(Deep=cur, Cyc=cyc, ImM=im_m))
    p3.Contents = pdf.make_stream(
        b"BT /F1 14 Tf 72 800 Td (Seite 3) Tj ET\n/Deep Do\nq 50 0 0 50 300 700 cm /Cyc Do Q\n"
        b"q 144 0 0 144 300 450 cm /ImM Do Q\n"
        b"q 50 0 0 50 400 700 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q\n"
    )
    with pdf.open_outline() as ol:
        ol.root.extend([pikepdf.OutlineItem("Kapitel 1", 0), pikepdf.OutlineItem("Kapitel 3", 2)])
    pdf.save(path, deterministic_id=True)
    return {"ImG": g_im.tobytes(), "ImK": k_im.tobytes()}


# ---------------------------------------------------------------- Analyse
def concat(m: tuple[float, ...], ctm: tuple[float, ...], kind: str) -> tuple[float, ...]:
    """Neue CTM = M x CTM (PDF-Zeilenvektor-Konvention); kind = "cm" oder "form"."""
    return mul(ctm, m) if SWAP == kind else mul(m, ctm)


def mul(m: tuple[float, ...], n: tuple[float, ...]) -> tuple[float, ...]:
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


@dataclass
class Img:
    obj: Stream
    names: set[str] = field(default_factory=set)
    places: list[tuple[float, float]] = field(default_factory=list)
    uncertain: list[str] = field(default_factory=list)


@dataclass
class Analysis:
    images: dict[tuple[int, int], Img] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    inline_images: int = 0


def reachable_images(xobj_res: Dictionary, seen: set[tuple[int, int]]) -> list[Stream]:
    out = []
    for _, xo in (xobj_res.get("/XObject") or Dictionary()).items():
        if xo.objgen in seen:
            continue
        seen.add(xo.objgen)
        if xo.get("/Subtype") == Name.Image:
            out.append(xo)
        elif xo.get("/Subtype") == Name.Form:
            out += reachable_images(xo.get("/Resources") or Dictionary(), seen)
    return out


def walk(an: Analysis, owner: object, res: Dictionary, ctm: tuple[float, ...], depth: int, stack: tuple, where: str) -> None:
    stack_ctm: list[tuple[float, ...]] = []
    for ins in pikepdf.parse_content_stream(owner):
        op = str(ins.operator)
        if op == "q":
            stack_ctm.append(ctm)
        elif op == "Q":
            ctm = stack_ctm.pop() if stack_ctm else ctm
        elif op == "cm":
            ctm = concat(tuple(float(x) for x in ins.operands), ctm, "cm")
        elif op == "INLINE IMAGE":
            an.inline_images += 1
        elif op == "Do":
            name = str(ins.operands[0])
            xo = (res.get("/XObject") or Dictionary()).get(name)
            if xo is None:
                an.notes.append(f"{where}: XObject {name} fehlt")
                continue
            if xo.get("/Subtype") == Name.Image:
                rec = an.images.setdefault(xo.objgen, Img(xo))
                rec.names.add(name.lstrip("/"))
                w, h = math.hypot(ctm[0], ctm[1]), math.hypot(ctm[2], ctm[3])
                rec.places.append((w, h))
            elif xo.get("/Subtype") == Name.Form:
                sub = f"{where}>{name}"
                if xo.objgen in stack or depth + 1 > MAX_DEPTH:
                    why = "Zyklus" if xo.objgen in stack else f"Tiefe>{MAX_DEPTH}"
                    an.notes.append(f"{sub}: {why}, Abbruch")
                    for im in reachable_images(xo.get("/Resources") or Dictionary(), set()):
                        an.images.setdefault(im.objgen, Img(im)).uncertain.append(f"{why} in {sub}")
                    continue
                m = tuple(float(x) for x in xo.get("/Matrix", Array(IDENT)))
                walk(an, xo, xo.get("/Resources") or res, concat(m, ctm, "form"), depth + 1, stack + (xo.objgen,), sub)


def analyze(pdf: Pdf) -> Analysis:
    an = Analysis()
    for i, page in enumerate(pdf.pages):
        walk(an, page, page.obj.get("/Resources") or Dictionary(), IDENT, 0, (), f"S{i + 1}")
    # Bilder ohne erkannte Platzierung (Annotation-AP, Pattern, Type3 ...) -> unsicher
    masks = set()
    for o in pdf.objects:
        if isinstance(o, Stream) and o.get("/Subtype") == Name.Image:
            for k in ("/SMask", "/Mask"):
                if isinstance(o.get(k), Stream):
                    masks.add(o.get(k).objgen)
    for o in pdf.objects:
        if isinstance(o, Stream) and o.get("/Subtype") == Name.Image and o.objgen not in masks and o.objgen not in an.images:
            an.images[o.objgen] = Img(o, uncertain=["keine Platzierung im Seiteninhalt gefunden"])
    return an


def eff_dpi(rec: Img) -> float | None:
    if rec.uncertain or not rec.places:
        return None
    w_pt = max(p[0] for p in rec.places)
    h_pt = max(p[1] for p in rec.places)
    if w_pt <= 0 or h_pt <= 0:
        return None
    return min(int(rec.obj.Width) * 72 / w_pt, int(rec.obj.Height) * 72 / h_pt)


# ---------------------------------------------------------------- Neukodierung
def single_filter(o: Stream) -> object:
    flt = o.get("/Filter")
    if isinstance(flt, Array):
        return flt[0] if len(flt) == 1 else None
    return flt


def eligible(o: Stream) -> str | None:
    flt = single_filter(o)
    if flt is None:
        return "Filterkette"
    if flt not in (Name.DCTDecode, Name.FlateDecode):
        return f"Filter {flt}"
    dp = o.get("/DecodeParms")
    if isinstance(dp, Array):
        dp = dp[0] if len(dp) == 1 else Dictionary(Unsupported=True)
    if isinstance(dp, Dictionary) and len(dp) > 0:
        pred = int(dp.get("/Predictor", 1))
        ncomp = 1 if o.get("/ColorSpace") == Name.DeviceGray else 3
        png_ok = (flt == Name.FlateDecode and 10 <= pred <= 15 and int(dp.get("/Colors", 1)) == ncomp
                  and int(dp.get("/BitsPerComponent", 8)) == 8 and int(dp.get("/Columns", 1)) == int(o.Width)
                  and set(dp.keys()) <= {"/Predictor", "/Colors", "/BitsPerComponent", "/Columns"})
        if not png_ok and not (pred == 1 and set(dp.keys()) <= {"/Predictor"}):
            return f"DecodeParms (Predictor {pred})"
    for k in ("/SMask", "/Mask", "/Decode", "/Alternates"):
        if k in o:
            return f"{k[1:]} vorhanden"
    if o.get("/ImageMask", False):
        return "ImageMask"
    if int(o.get("/BitsPerComponent", 0)) != 8:
        return "BitsPerComponent != 8"
    if o.get("/ColorSpace") not in (Name.DeviceRGB, Name.DeviceGray):
        cs = o.get("/ColorSpace")
        return f"Farbraum {cs[0] if isinstance(cs, Array) else cs}"
    if int(o.Width) * int(o.Height) > MAX_PIXELS:
        return "> 40 MP"
    if flt == Name.DCTDecode:
        mode = Image.open(io.BytesIO(o.read_raw_bytes())).mode
        if mode not in ("RGB", "L"):
            return f"JPEG-Modus {mode}"
    return None


def optimize(src: Path, dst: Path, level: str) -> tuple[list[dict], Analysis]:
    dpi_t, px_t, q = LEVELS[level]
    log = []
    with Pdf.open(src, attempt_recovery=False) as pdf:
        an = analyze(pdf)
        for og, rec in sorted(an.images.items()):
            o = rec.obj
            w, h = int(o.Width), int(o.Height)
            dpi = eff_dpi(rec)
            entry = {"name": ",".join(sorted(rec.names)) or "?", "objgen": og, "px": (w, h),
                     "dpi": None if dpi is None else round(dpi, 2), "unsicher": rec.uncertain, "old": len(o.read_raw_bytes())}
            reason = eligible(o)
            if reason:
                entry["aktion"] = f"unverändert ({reason})"
                log.append(entry)
                continue
            scale = 1.0 if dpi is None else min(1.0, dpi_t / dpi)  # unsicher -> nur Pixelgrenze
            if max(w, h) * scale > px_t:
                scale = px_t / max(w, h)
            if scale > MIN_DOWNSCALE:  # Vertrag/presets.ts: scale > 0.9 ? 1 : scale
                scale = 1.0
            nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
            pil = pikepdf.PdfImage(o).as_pil_image()
            if pil.mode not in ("RGB", "L"):
                entry["aktion"] = f"unverändert (PIL-Modus {pil.mode})"
                log.append(entry)
                continue
            if single_filter(o) == Name.DCTDecode and (nw, nh) == (w, h):
                entry["aktion"] = "unverändert (JPEG ohne Verkleinerung)"  # Vertrag §8: kein Generationsverlust
                log.append(entry)
                continue
            if (nw, nh) != (w, h):
                pil = pil.resize((nw, nh), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            pil.save(buf, "JPEG", quality=jpeg_quality(q), optimize=True)
            new = buf.getvalue()
            entry.update(new=len(new), newpx=(nw, nh))
            if len(new) > MIN_SAVING * entry["old"]:
                entry["aktion"] = "unverändert (Einsparung < 3 %)"
            else:
                o.write(new, filter=Name.DCTDecode)
                o.Width, o.Height, o.BitsPerComponent = nw, nh, 8
                o.ColorSpace = Name.DeviceGray if pil.mode == "L" else Name.DeviceRGB
                if "/DecodeParms" in o:
                    del o.DecodeParms
                entry["aktion"] = "ersetzt"
            log.append(entry)
        pdf.remove_unreferenced_resources()
        pdf.save(dst, deterministic_id=True, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    return log, an


# ---------------------------------------------------------------- Prüfungen
def xobj(pdf: Pdf, page: int, *path: str) -> Stream:
    o = pdf.pages[page].obj.Resources
    for i, n in enumerate(path):
        o = o.XObject["/" + n]
        if i < len(path) - 1:
            o = o.Resources
    return o


def render(path: Path) -> list[Image.Image]:
    doc = pdfium.PdfDocument(str(path))
    try:
        return [doc[i].render(scale=100 / 72).to_pil().convert("RGB") for i in range(len(doc))]
    finally:
        doc.close()


def pdf_text(path: Path, page: int) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[page].get_textpage().get_text_range()
    finally:
        doc.close()


def compare(a: Image.Image, b: Image.Image) -> tuple[float, float]:
    assert a.size == b.size, (a.size, b.size)
    st = ImageStat.Stat(ImageChops.difference(a, b))
    mae = sum(st.mean) / 3
    mse = sum(r * r for r in st.rms) / 3
    psnr = float("inf") if mse == 0 else 10 * math.log10(255 * 255 / mse)
    return mae, psnr


PATHS = {
    "ImA": (0, ("ImA",)), "ImB": (0, ("Fm1", "ImB")), "ImJ": (0, ("FmJ", "ImJ")),
    "ImC": (1, ("ImC",)), "ImD": (1, ("ImD",)), "ImE": (1, ("ImE",)), "ImF": (1, ("ImF",)),
    "ImG": (1, ("ImG",)), "ImI": (1, ("ImI",)), "ImK": (1, ("ImK",)), "ImL": (0, ("ImL",)), "ImM": (2, ("ImM",)),
}  # ImH nur über 15 verschachtelte Forms erreichbar -> wird über den Log geprüft


def verify(src: Path, dst: Path, log: list[dict]) -> list[str]:
    msgs = []
    unchanged = [e["name"] for e in log if e["aktion"].startswith("unverändert") and e["name"] in PATHS]
    with Pdf.open(src, attempt_recovery=False) as a, Pdf.open(dst, attempt_recovery=False) as b:
        assert not b.is_encrypted, "Ergebnis verschlüsselt"
        assert len(a.pages) == len(b.pages) == 3
        for i in range(3):
            assert list(a.pages[i].mediabox) == list(b.pages[i].mediabox)
            assert a.pages[i].Contents.read_bytes() == b.pages[i].Contents.read_bytes(), f"Content S{i + 1}"
        assert int(b.pages[2].Rotate) == 90
        for fm, mtx in (("Fm1", [0.5, 0, 0, 0.5, 0, 0]), ("FmJ", [2, 0, 0, 0.5, 0, 0])):
            assert xobj(a, 0, fm).read_bytes() == xobj(b, 0, fm).read_bytes()
            assert list(xobj(b, 0, fm).Matrix) == mtx
        assert b"(" + TEXT.encode() + b") Tj" in b.pages[0].Contents.read_bytes()
        annots = list(b.pages[0].Annots)
        assert any(x.Subtype == Name.Link and str(x.A.URI) == "https://example.org/b01" for x in annots)
        f = b.Root.AcroForm.Fields[0]
        assert str(f.T) == "kunde" and str(f.V) == "Muster" and f.objgen == annots[1].objgen
        with b.open_outline() as ol:
            titles = [x.title for x in ol.root]
        assert titles == ["Kapitel 1", "Kapitel 3"], titles
        for name in unchanged:
            pg, path = PATHS[name]
            oa, ob = xobj(a, pg, *path), xobj(b, pg, *path)
            assert oa.read_raw_bytes() == ob.read_raw_bytes(), path
            if "/SMask" in oa:
                assert oa.SMask.read_raw_bytes() == ob.SMask.read_raw_bytes()
        msgs.append("Struktur: unverschlüsselt, Seiten/MediaBox/Rotate, Content-Streams (dekodiert byte-gleich), "
                    f"Form-/Matrix, Link, Outline, AcroForm; unverändert byte-identisch: {', '.join(sorted(unchanged))}: OK")
    assert TEXT in pdf_text(dst, 0), "Text nicht extrahierbar"
    msgs.append(f"pdfium-Textextraktion Seite 1 enthält {TEXT!r}: OK")
    for i, (ra, rb) in enumerate(zip(render(src), render(dst), strict=True)):
        mae, psnr = compare(ra, rb)
        msgs.append(f"Render S{i + 1} (100 DPI, pdfium): MAE={mae:.2f}, PSNR={psnr:.1f} dB")
        assert mae < 6.0 and psnr > 25.0, (i, mae, psnr)
    return msgs


def check_new_jpegs(dst: Path, log: list[dict]) -> None:
    with Pdf.open(dst, attempt_recovery=False) as b:
        for e in log:
            if e["aktion"] != "ersetzt" or e["name"] not in PATHS:
                continue
            o = xobj(b, PATHS[e["name"]][0], *PATHS[e["name"]][1])
            im = Image.open(io.BytesIO(o.read_raw_bytes()))
            im.load()
            assert im.format == "JPEG" and im.size == tuple(e["newpx"]) == (int(o.Width), int(o.Height))
            assert o.Filter == Name.DCTDecode and "/DecodeParms" not in o


EXPECTED_DPI = {"ImA": 300.0, "ImB": 360.0, "ImC": 300.0, "ImD": 144.0, "ImE": 46.08, "ImF": 144.0, "ImG": 150.0,
                "ImI": 100.0, "ImJ": 288.0, "ImK": 144.0, "ImL": 144.0,
                "ImM": 310.0, "?": None}
# Erwartete neue Pixelmaße; nur diese Bilder MÜSSEN ersetzt werden, alle anderen MÜSSEN unverändert bleiben.
# ? = ImH (4000x400, unsicher -> nur Kantengrenze 3600/2000/1300). ImA in high: JPEG ohne Verkleinerung -> unverändert.
EXPECTED_PX = {
    "high": {"ImB": (833, 833), "ImC": (800, 600), "ImG": (600, 450), "ImJ": (800, 200), "ImL": (400, 100),
             "ImM": (620, 620), "?": (3600, 360)},
    "balanced": {"ImA": (600, 400), "ImB": (417, 417), "ImC": (400, 300), "ImG": (600, 450), "ImJ": (417, 104),
                 "ImL": (400, 100), "ImM": (300, 300), "?": (2000, 200)},
    "small": {"ImA": (400, 267), "ImB": (278, 278), "ImC": (267, 200), "ImG": (400, 300), "ImJ": (278, 69),
              "ImL": (278, 69), "ImM": (200, 200), "?": (1300, 130)},
}


def expect_pdf_error(path: Path, label: str, **kw: object) -> None:
    try:
        Pdf.open(path, **kw).close()
    except pikepdf.PasswordError:
        raise
    except pikepdf.PdfError as exc:
        print(f"- {label}: PdfError ({str(exc)[:100]})")
        return
    raise AssertionError(f"{label}: kein PdfError")


def error_cases() -> None:
    print("## Fehlerfälle")
    with Pdf.new() as p:
        p.add_blank_page()
        p.save(OUT / "enc_user.pdf", encryption=pikepdf.Encryption(owner="o", user="u", R=6))
        p.save(OUT / "enc_owner_only.pdf", encryption=pikepdf.Encryption(owner="o", user="", R=6))
    try:
        Pdf.open(OUT / "enc_user.pdf", attempt_recovery=False)
        raise AssertionError("kein PasswordError")
    except pikepdf.PasswordError as exc:
        print(f"- verschlüsselt mit Benutzerpasswort: PasswordError ({exc})")
    with Pdf.open(OUT / "enc_owner_only.pdf", attempt_recovery=False) as p:
        assert p.is_encrypted
        print(f"- nur Besitzerpasswort: öffnet ohne Passwort, is_encrypted={p.is_encrypted} -> muss per Regel abgelehnt werden")
    rnd = random.Random(7)
    (OUT / "garbage.pdf").write_bytes(b"%PDF-1.7\n" + bytes(rnd.randrange(256) for _ in range(4000)))
    (OUT / "notpdf.pdf").write_bytes(b"\x89PNG\r\n\x1a\nkein pdf")
    data = (OUT / "fixture.pdf").read_bytes()
    (OUT / "truncated.pdf").write_bytes(data[: len(data) // 2])
    for name, label in (("garbage.pdf", "%PDF-Header + Zufallsbytes"), ("notpdf.pdf", "PNG-Bytes als .pdf")):
        expect_pdf_error(OUT / name, label + " (Standard)")
        expect_pdf_error(OUT / name, label + " (attempt_recovery=False)", attempt_recovery=False)
    with Pdf.open(OUT / "truncated.pdf") as p:  # Standard: qpdf repariert
        probs = p.check_pdf_syntax() if hasattr(p, "check_pdf_syntax") else p.check()
        print(f"- auf 50 % gekürzt, Standard-open(): qpdf REPARIERT und öffnet ({len(p.pages)} Seiten), "
              f"Prüfmeldungen: {len(probs)} -> so nicht verwendbar")
    expect_pdf_error(OUT / "truncated.pdf", "auf 50 % gekürzt (attempt_recovery=False)", attempt_recovery=False)
    for name in ["fixture.pdf"] + [f"result_{lv}.pdf" for lv in LEVELS]:
        with Pdf.open(OUT / name, attempt_recovery=False) as p:
            assert len(p.pages) == 3
    print("- Fixture und alle drei Ergebnisse öffnen mit attempt_recovery=False: OK")
    print("- Hinweis: Exception-Texte enthalten interne Pfade (s. o.) -> nie an Nutzer weitergeben")


def check_predictor_decode(raw: dict[str, bytes]) -> None:
    print("## Prädiktor-Dekodierung (qpdf/PdfImage)")
    with Pdf.open(OUT / "fixture.pdf", attempt_recovery=False) as pdf:
        for name in ("ImG", "ImK"):
            o = xobj(pdf, *PATHS[name][:1], *PATHS[name][1])
            pil = pikepdf.PdfImage(o).as_pil_image()
            same = pil.mode == "RGB" and pil.tobytes() == raw[name]
            pred = int(o.DecodeParms.Predictor)
            print(f"- {name} (Predictor {pred}): PdfImage.as_pil_image() pixelgleich mit Ausgangspixeln = {same}")
            if name == "ImG":
                assert same, "PNG-Prädiktor falsch dekodiert"


def main() -> None:
    src = OUT / "fixture.pdf"
    raw = build_fixture(src)
    print(f"## PDF-Fixture: {src.stat().st_size} B (POC_SWAP={SWAP or '-'})")
    check_predictor_decode(raw)
    with Pdf.open(src, attempt_recovery=False) as pdf:
        an = analyze(pdf)
        print(f"- Inline-Images gefunden (nicht bearbeitet): {an.inline_images}")
        for n in an.notes:
            print(f"- Analyse-Hinweis: {n}")
        print("| Bild | Pixel | Platzierungen (pt) | effektive DPI | erwartet | unsicher |")
        print("| --- | --- | --- | --- | --- | --- |")
        for rec in an.images.values():
            name = ",".join(sorted(rec.names)) or "?"
            d = eff_dpi(rec)
            exp = EXPECTED_DPI[name]
            print(f"| {name} | {int(rec.obj.Width)}x{int(rec.obj.Height)} | {[tuple(round(v, 2) for v in p) for p in rec.places]} | "
                  f"{'-' if d is None else round(d, 2)} | {exp} | {'; '.join(rec.uncertain) or '-'} |")
        for rec in an.images.values():
            name = ",".join(sorted(rec.names)) or "?"
            d, exp = eff_dpi(rec), EXPECTED_DPI[name]
            assert (d is None and exp is None) or (d is not None and exp is not None and math.isclose(d, exp, rel_tol=1e-6)), (name, d, exp)
        assert an.inline_images == 1 and len(an.images) == 13
    sizes = {"original": src.stat().st_size}
    for level in LEVELS:
        dst = OUT / f"result_{level}.pdf"
        t = time.perf_counter()
        log, _ = optimize(src, dst, level)
        dt = time.perf_counter() - t
        sizes[level] = dst.stat().st_size
        dpi_t, px_t, q = LEVELS[level]
        print(f"## Stufe {level}: {dpi_t} DPI / {px_t} px / q={q} -> Pillow quality={jpeg_quality(q)}; {dt:.2f} s")
        print("| Bild | alt px | DPI | neu px | alt B | neu B | Aktion |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for e in log:
            print(f"| {e['name']} | {e['px'][0]}x{e['px'][1]} | {e['dpi']} | {e.get('newpx', '-')} | {e['old']} | "
                  f"{e.get('new', '-')} | {e['aktion']} |")
        for e in log:
            if e["name"] in EXPECTED_PX[level]:
                assert e["aktion"] == "ersetzt" and tuple(e["newpx"]) == EXPECTED_PX[level][e["name"]], (level, e)
            else:
                assert e["aktion"].startswith("unverändert ("), (level, e)
        check_new_jpegs(dst, log)
        for m in verify(src, dst, log):
            print(f"- {m}")
    print("## Dateigrößen")
    print("| Variante | Bytes | Anteil |")
    print("| --- | --- | --- |")
    for k, v in sizes.items():
        print(f"| {k} | {v} | {v / sizes['original']:.1%} |")
    error_cases()
    print("PDF: OK")


if __name__ == "__main__":
    main()
