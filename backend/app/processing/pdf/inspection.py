"""Conservative PDF analysis: unique streams and bounded placement traversal."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name, Pdf

MAX_DEPTH = 10
IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mul(m: tuple[float, ...], n: tuple[float, ...]) -> tuple[float, ...]:
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (
        a * A + b * C,
        a * B + b * D,
        c * A + d * C,
        c * B + d * D,
        e * A + f * C + E,
        e * B + f * D + F,
    )


@dataclass
class Img:
    obj: Any
    names: set[str] = field(default_factory=set)
    places: list[tuple[float, float]] = field(default_factory=list)
    uncertain: list[str] = field(default_factory=list)


@dataclass
class Analysis:
    images: dict[tuple[int, int], Img] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    inline_images: int = 0


def reachable_images(xobj_res: Any, seen: set[tuple[int, int]]) -> list[Any]:
    out: list[Any] = []
    pending = [xobj_res]
    while pending:
        resources = pending.pop()
        for _, xo in (resources.get("/XObject") or Dictionary()).items():
            if xo.objgen in seen:
                continue
            seen.add(xo.objgen)
            if xo.get("/Subtype") == Name.Image:
                out.append(xo)
            elif xo.get("/Subtype") == Name.Form:
                pending.append(xo.get("/Resources") or Dictionary())
    return out


def walk(
    an: Analysis,
    owner: Any,
    res: Any,
    ctm: tuple[float, ...],
    depth: int,
    stack: tuple[tuple[int, int], ...],
    where: str,
) -> None:
    stack_ctm: list[tuple[float, ...]] = []
    for ins in pikepdf.parse_content_stream(owner):
        op = str(ins.operator)
        if op == "q":
            stack_ctm.append(ctm)
        elif op == "Q":
            ctm = stack_ctm.pop() if stack_ctm else ctm
        elif op == "cm":
            ctm = mul(tuple(float(x) for x in ins.operands), ctm)
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
                walk(
                    an,
                    xo,
                    xo.get("/Resources") or res,
                    mul(m, ctm),
                    depth + 1,
                    (*stack, xo.objgen),
                    sub,
                )


def inspect_document(pdf: Pdf) -> Analysis:
    an = Analysis()
    for i, page in enumerate(pdf.pages):
        unit = float(page.obj.get("/UserUnit", 1))
        ctm = (unit, 0.0, 0.0, unit, 0.0, 0.0)
        walk(an, page, page.obj.get("/Resources") or Dictionary(), ctm, 0, (), f"S{i + 1}")
    # Bilder ohne erkannte Platzierung (Annotation-AP, Pattern, Type3 ...) -> unsicher
    masks = set()
    for o in pdf.objects:
        if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == Name.Image:
            for k in ("/SMask", "/Mask"):
                mask = o.get(k)
                if isinstance(mask, pikepdf.Stream):
                    masks.add(mask.objgen)
    for o in pdf.objects:
        if (
            isinstance(o, pikepdf.Stream)
            and o.get("/Subtype") == Name.Image
            and o.objgen not in masks
            and o.objgen not in an.images
        ):
            an.images[o.objgen] = Img(o, uncertain=["keine Platzierung im Seiteninhalt gefunden"])
    # Shared images can also occur in a pattern, glyph or annotation appearance.
    # Those placements are deliberately not interpreted; even an otherwise known
    # page placement cannot establish a safe DPI in that case.
    unsupported: list[Any] = []
    for obj in pdf.objects:
        if isinstance(obj, (Dictionary, pikepdf.Stream)):
            if obj.get("/PatternType") is not None or obj.get("/Subtype") == Name.Type3:
                unsupported.append(obj.get("/Resources") or Dictionary())
            appearance = obj.get("/AP")
            if isinstance(appearance, Dictionary):
                for _, value in appearance.items():
                    candidates = value.values() if isinstance(value, Dictionary) else [value]
                    for candidate in candidates:
                        if isinstance(candidate, pikepdf.Stream):
                            unsupported.append(candidate.get("/Resources") or Dictionary())
    for resources in unsupported:
        for image in reachable_images(resources, set()):
            an.images.setdefault(image.objgen, Img(image)).uncertain.append("unsupported placement")
    for mask_id in masks:
        an.images.pop(mask_id, None)
    return an


def eff_dpi(rec: Img) -> float | None:
    if rec.uncertain or not rec.places:
        return None
    w_pt = max(p[0] for p in rec.places)
    h_pt = max(p[1] for p in rec.places)
    if w_pt <= 0 or h_pt <= 0:
        return None
    return min(int(rec.obj.Width) * 72 / w_pt, int(rec.obj.Height) * 72 / h_pt)
