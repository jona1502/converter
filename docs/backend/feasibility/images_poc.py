"""B01-PoC Bilder: Pillow-Fähigkeiten im Container mit echten Rundreisen prüfen.

Wegwerfcode. Jeder Fehlschlag endet über assert/Exception mit Exit != 0.
"""

from __future__ import annotations

import io
import struct
import time
import warnings
import zlib

from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError, features

ROWS: list[tuple[str, str, str, str]] = []


def sample(mode: str = "RGB", size: tuple[int, int] = (96, 64)) -> Image.Image:
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, size[0] // 2, size[1] // 2), fill=(220, 30, 30, 255))
    d.ellipse((size[0] // 3, size[1] // 4, size[0] - 4, size[1] - 4), fill=(30, 90, 220, 200))
    return im.convert(mode) if mode != "RGBA" else im


def roundtrip(im: Image.Image, fmt: str, **kw: object) -> tuple[Image.Image, bytes]:
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    data = buf.getvalue()
    re = Image.open(io.BytesIO(data))
    re.load()
    return re, data


def check_features() -> None:
    print("## Pillow-Features")
    for name in ("jpg", "zlib", "webp", "avif", "libtiff", "littlecms2"):
        print(f"- features.check({name!r}) = {features.check(name)}")
        assert features.check(name), name
    ext = Image.registered_extensions()
    for e in (".jpg", ".png", ".webp", ".gif", ".bmp", ".ico", ".avif"):
        print(f"- registered_extensions[{e}] = {ext.get(e)}")
        assert e in ext, e


def check_inputs() -> None:
    # Eingabedateien erzeugen (Pillow-Encoder) und als Eingabe öffnen/dekodieren.
    for fmt, mode, kw in [
        ("JPEG", "RGB", {"quality": 90}),
        ("PNG", "RGBA", {}),
        ("WEBP", "RGBA", {"quality": 80}),
        ("GIF", "P", {}),
        ("BMP", "RGB", {}),
        ("ICO", "RGBA", {"sizes": [(32, 32), (64, 64)]}),
        ("AVIF", "RGBA", {"quality": 70}),
    ]:
        src = sample("RGBA").convert(mode) if mode != "P" else sample("RGB").convert("P")
        if fmt == "ICO":
            src = ImageOps.pad(sample("RGBA"), (64, 64), color=(0, 0, 0, 0))
        _, data = roundtrip(src, fmt, **kw)
        im = Image.open(io.BytesIO(data))
        assert im.format == fmt, (im.format, fmt)
        assert not getattr(im, "is_animated", False)
        im.load()
        ROWS.append((fmt, "ja", "", f"{len(data)} B, Modus {im.mode}, {im.size[0]}x{im.size[1]}"))


def check_outputs() -> None:
    base = sample("RGBA", (120, 80))
    for fmt, prep, kw in [
        ("JPEG", lambda i: flatten(i), {"quality": 82, "optimize": True}),
        ("PNG", lambda i: i, {"optimize": True}),
        ("WEBP", lambda i: i, {"quality": 80, "method": 4}),
        ("WEBP", lambda i: i, {"lossless": True}),
        ("BMP", lambda i: flatten(i), {}),
        ("ICO", lambda i: ImageOps.pad(i, (256, 256), color=(0, 0, 0, 0)), {"sizes": [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]}),
    ]:
        out = prep(base)
        re, data = roundtrip(out, fmt, **kw)
        assert re.format == fmt
        assert re.size == out.size, (fmt, re.size, out.size)
        if fmt in ("PNG", "WEBP", "ICO"):  # Transparenz muss erhalten bleiben
            assert re.mode == "RGBA" and re.getpixel((re.width - 1, 0))[3] == 0, (fmt, re.mode)  # transparente Ecke
            if fmt != "ICO":  # ICO ist gepolstert; deckende rote Fläche oben links nur bei PNG/WebP
                assert re.getpixel((2, 2))[3] == 255, fmt
        else:
            assert re.mode == "RGB", (fmt, re.mode)
        note = f"{len(data)} B, {re.mode} {re.size[0]}x{re.size[1]}" + (" lossless" if kw.get("lossless") else "")
        for i, r in enumerate(ROWS):
            if r[0] == fmt:
                ROWS[i] = (fmt, r[1], "ja", r[3] + " / Ausgabe: " + note)
                break


def flatten(im: Image.Image, bg: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        out = Image.new("RGB", im.size, bg)
        out.paste(im, mask=im.getchannel("A"))
        return out
    return im.convert("RGB")


def check_alpha_fill() -> None:
    print("## Alpha -> JPEG/BMP")
    rgba = sample("RGBA", (40, 40))
    try:
        rgba.save(io.BytesIO(), "JPEG")
        raise AssertionError("RGBA->JPEG ohne Fehler")
    except OSError as exc:
        print(f"- RGBA direkt als JPEG: OSError ({exc}) -> Hintergrundfüllung nötig")
    _, bmp_rgba = roundtrip(rgba, "BMP")
    assert Image.open(io.BytesIO(bmp_rgba)).mode == "RGB"  # Alpha geht ohne Fehler verloren
    print(f"- RGBA direkt als BMP: Pillow schreibt Modus {Image.open(io.BytesIO(bmp_rgba)).mode} (Plan verlangt BMP ohne Alpha -> flatten)")
    for fmt in ("JPEG", "BMP"):
        re, _ = roundtrip(flatten(rgba, (0, 255, 0)), fmt)
        px = re.convert("RGB").getpixel((39, 0))  # transparente Ecke
        assert re.mode == "RGB" and px[1] > 240 and px[0] < 20, (fmt, px)
        print(f"- {fmt}: transparente Ecke nach Füllung mit Grün = {px}")


def check_exif() -> None:
    print("## EXIF-Orientierung")
    im = Image.new("RGB", (60, 40), (255, 255, 255))
    ImageDraw.Draw(im).rectangle((0, 0, 14, 14), fill=(255, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6
    _, data = roundtrip(im, "JPEG", quality=95, exif=exif.tobytes())
    src = Image.open(io.BytesIO(data))
    assert src.size == (60, 40) and src.getexif().get(0x0112) == 6
    fixed = ImageOps.exif_transpose(src)
    assert fixed is not None
    px = fixed.getpixel((fixed.width - 3, 2))
    assert fixed.size == (40, 60) and px[0] > 200 and px[1] < 60, (fixed.size, px)
    assert fixed.getexif().get(0x0112) is None
    print(f"- gespeichert 60x40 Orientation=6 -> exif_transpose {fixed.size}, rote Marke oben rechts {px}, Tag entfernt")


def check_ico() -> None:
    print("## ICO mehrere Größen")
    src = ImageOps.pad(sample("RGBA", (300, 180)), (256, 256), color=(0, 0, 0, 0))
    sizes = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]
    _, data = roundtrip(src, "ICO", sizes=sizes)
    ico = Image.open(io.BytesIO(data))
    got = sorted(ico.info["sizes"])
    assert got == sizes, got
    assert ico.size == (256, 256)
    ico.load()
    print(f"- geschrieben {len(data)} B, Einträge {[s[0] for s in got]}, Standard beim Öffnen {ico.size} (größter)")
    ico.size = (32, 32)  # gezielter Eintrag
    ico.load()
    assert ico.im.size == (32, 32)
    print("- Auswahl eines Eintrags über `im.size = (32, 32)` vor load() funktioniert")


def check_animation() -> None:
    print("## Animationserkennung")
    frames = [Image.new("RGB", (32, 32), c) for c in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
    for fmt, kw in [("GIF", {}), ("PNG", {}), ("WEBP", {}), ("AVIF", {})]:
        try:
            _, data = roundtrip(frames[0], fmt, save_all=True, append_images=frames[1:], duration=100, loop=0, **kw)
        except Exception as exc:  # noqa: BLE001 - PoC soll Grenze dokumentieren
            print(f"- {fmt}: animiert schreiben NICHT möglich: {type(exc).__name__}: {exc}")
            continue
        im = Image.open(io.BytesIO(data))
        n, anim = getattr(im, "n_frames", 1), getattr(im, "is_animated", False)
        print(f"- animiertes {fmt}{' (APNG)' if fmt == 'PNG' else ''}: n_frames={n}, is_animated={anim}")
        assert n == 3 and anim, fmt
        static = Image.open(io.BytesIO(roundtrip(frames[0], fmt)[1]))
        assert not getattr(static, "is_animated", False)
        ROWS.append((f"{fmt} animiert", "erkannt", "-", f"n_frames={n} -> ablehnen"))


def png_header_only(w: int, h: int) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b"")


def check_bomb() -> None:
    print("## Pixelbomben / Header-Prüfung")
    print(f"- Image.MAX_IMAGE_PIXELS Standard = {Image.MAX_IMAGE_PIXELS}")
    data = png_header_only(8000, 6000)  # 48 MP, ~60 Byte Datei
    t = time.perf_counter()
    im = Image.open(io.BytesIO(data))
    dt = (time.perf_counter() - t) * 1000
    print(f"- 48-MP-PNG-Header ({len(data)} B): open() lazy in {dt:.2f} ms, size={im.size}, kein load()")
    assert im.size == (8000, 6000) and im.size[0] * im.size[1] > 40_000_000  # eigene Grenze greift vor load()
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            Image.open(io.BytesIO(png_header_only(10000, 10000)))
            raise AssertionError("keine Warnung")
        except Image.DecompressionBombWarning:
            print("- 100 MP (> MAX_IMAGE_PIXELS): DecompressionBombWarning in open(), als Fehler konfigurierbar")
    try:
        Image.open(io.BytesIO(png_header_only(20000, 20000)))
        raise AssertionError("kein Fehler")
    except Image.DecompressionBombError as exc:
        print(f"- 400 MP (> 2x MAX_IMAGE_PIXELS): DecompressionBombError in open(): {exc}")
    old = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = 40_000_000
    try:
        Image.open(io.BytesIO(png_header_only(9000, 9000)))  # 81 MP > 2x40 MP
        raise AssertionError("kein Fehler")
    except Image.DecompressionBombError:
        print("- MAX_IMAGE_PIXELS=40_000_000: 81 MP -> DecompressionBombError; 40..80 MP nur Warnung -> eigene Prüfung nötig")
    finally:
        Image.MAX_IMAGE_PIXELS = old
    # Bytebasierte Typprüfung: PNG-Inhalt mit falscher Endung/Erwartung
    png = roundtrip(sample(), "PNG")[1]
    assert Image.open(io.BytesIO(png)).format == "PNG"
    try:
        Image.open(io.BytesIO(png), formats=["JPEG"])
        raise AssertionError("formats ignoriert")
    except UnidentifiedImageError:
        print("- Image.open(..., formats=[...]) beschränkt Decoder; PNG-Bytes mit formats=['JPEG'] -> UnidentifiedImageError")


def main() -> None:
    check_features()
    check_inputs()
    check_outputs()
    check_alpha_fill()
    check_exif()
    check_ico()
    check_animation()
    check_bomb()
    print("## Formatmatrix")
    print("| Format | Lesen | Schreiben | Hinweis |")
    print("| --- | --- | --- | --- |")
    for r in ROWS:
        print(f"| {r[0]} | {r[1]} | {r[2] or 'nicht gefordert (Encoder für Fixture genutzt)'} | {r[3]} |")
    print("BILDER: OK")


if __name__ == "__main__":
    main()
