"""Render Markdown tokens directly; user text never becomes ReportLab markup.

There is deliberately no HTML renderer, image loader or resource resolver.
Only the bundled font files and the supplied source/result paths are opened.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Any, cast
from xml.sax.saxutils import escape, quoteattr

from markdown_it import MarkdownIt
from markdown_it.token import Token
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, LETTER, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    HRFlowable,
    LongTable,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)
from reportlab.platypus.doctemplate import LayoutError

from converter.errors import ProcessingError
from converter.limits import Limits
from converter.options import MarkdownOptions
from converter.processing.files import discard, open_result

MARGIN = 42
PAGE_SIZES = {"a4": A4, "letter": LETTER}
FONT = "MarkdownVera"


def _page(options: MarkdownOptions) -> tuple[float, float]:
    size = PAGE_SIZES[options.page_size]
    return landscape(size) if options.orientation == "landscape" else size


def _width(page: tuple[float, float]) -> float:
    # Platypus frames have 6 pt padding at both horizontal edges.
    return page[0] - 2 * MARGIN - 12


class _PageLimit(Exception):
    pass


class _OutputLimit(Exception):
    pass


class _Parser(MarkdownIt):
    def validateLink(self, url: str) -> bool:
        # Parse even unsafe destinations so image alt text survives. No parser
        # renderer is invoked; _inline independently filters active PDF links.
        return True


class _PaginatedTable(LongTable):
    def split(self, availWidth: float, availHeight: float) -> list[Flowable]:
        parts = super().split(availWidth, availHeight)
        # A remainder could otherwise split again in the same frame, repeating
        # the header halfway down a page and leaving tiny row fragments.
        if len(parts) > 1:
            return [parts[0], PageBreak(), *parts[1:]]
        return parts


def _fonts() -> None:
    if FONT in pdfmetrics.getRegisteredFontNames():
        return
    root = Path(__file__).with_name("fonts")
    for name, filename in [
        (FONT, "Vera.ttf"),
        (FONT + "-Bold", "VeraBd.ttf"),
        (FONT + "-Italic", "VeraIt.ttf"),
        (FONT + "-BoldItalic", "VeraBI.ttf"),
    ]:
        pdfmetrics.registerFont(TTFont(name, str(root / filename)))
    pdfmetrics.registerFontFamily(
        FONT,
        normal=FONT,
        bold=FONT + "-Bold",
        italic=FONT + "-Italic",
        boldItalic=FONT + "-BoldItalic",
    )


def _text(value: str) -> str:
    # Vera covers Latin, not arbitrary Unicode. Missing glyphs get a visible
    # replacement instead of triggering renderer errors or invisible content.
    glyphs = cast(TTFont, pdfmetrics.getFont(FONT)).face.charToGlyph
    return escape("".join(c if ord(c) in glyphs else "?" for c in value))


def _inline(tokens: list[Token]) -> str:
    result: list[str] = []
    links: list[bool] = []
    for token in tokens:
        kind = token.type
        if kind in {"text", "html_inline"}:
            result.append(_text(token.content))
        elif kind == "code_inline":
            result.append('<font backColor="#eef0f3">' + _text(token.content) + "</font>")
        elif kind in {"softbreak", "hardbreak"}:
            result.append("<br/>" if kind == "hardbreak" else " ")
        elif kind in {"strong_open", "strong_close", "em_open", "em_close"}:
            tag = "b" if kind.startswith("strong") else "i"
            result.append(f"</{tag}>" if kind.endswith("close") else f"<{tag}>")
        elif kind == "image":
            result.append(_text(token.content))
        elif kind == "link_open":
            href = str(token.attrGet("href") or "")
            active = href.partition(":")[0].lower() in {"https", "http", "mailto"} and all(
                ord(c) >= 32 for c in href
            )
            links.append(active)
            if active:
                result.append(f'<link href={quoteattr(href)} color="#174ea6">')
        elif kind == "link_close":
            if links.pop():
                result.append("</link>")
        else:
            result.append(_text(token.content))
    return "".join(result)


def _style(name: str = "body", **kwargs: Any) -> ParagraphStyle:
    return ParagraphStyle(
        name,
        fontName=FONT,
        fontSize=10,
        leading=15,
        spaceAfter=8,
        splitLongWords=True,
        allowWidows=1,
        allowOrphans=1,
        **kwargs,
    )


def _code(content: str, indent: int, page: tuple[float, float]) -> list[Flowable]:
    style = _style("code", leftIndent=indent, backColor=colors.HexColor("#f3f4f6"))
    style.fontSize, style.leading, style.spaceAfter = 9, 12, 0
    width = _width(page) - indent - 2
    widths: dict[str, float] = {}
    result: list[Flowable] = []
    # Wrap by measured glyph width, including unbroken words. Each visual line
    # is independently splittable across pages; a code block never overflows.
    for line in content.expandtabs(4).splitlines():
        part: list[str] = []
        used = 0.0
        for char in line:
            if char not in widths:
                widths[char] = float(pdfmetrics.stringWidth(char, FONT, 9))
            advance = widths[char]
            if part and used + advance > width:
                result.append(Paragraph(_text("".join(part)).replace(" ", "&#160;"), style))
                part, used = [], 0.0
            part.append(char)
            used += advance
        result.append(Paragraph(_text("".join(part)).replace(" ", "&#160;") or "&#160;", style))
    result.append(Spacer(1, 8))
    return result


def _table(tokens: list[Token], indent: int, page: tuple[float, float]) -> LongTable:
    rows: list[list[Paragraph]] = []
    row: list[Paragraph] = []
    style = _style("cell")
    style.fontSize, style.leading, style.spaceAfter = 9, 13, 0
    for token in tokens:
        if token.type == "tr_open":
            row = []
        elif token.type == "inline":
            row.append(Paragraph(_inline(token.children or []) or "&#160;", style))
        elif token.type == "tr_close":
            rows.append(row)
    count = max(len(row) for row in rows)
    column_width = (_width(page) - indent) / count
    cell_width = column_width - 12
    header_budget = (page[1] - 2 * MARGIN - 12) / 3
    if any(cell.wrap(cell_width, header_budget)[1] > header_budget for cell in rows[0]):
        # ReportLab cannot split a repeated row. Keep the complete original
        # header as a normal, splittable row and repeat only its first three
        # rendered lines. This bounds repetition without dropping header text.
        rows.insert(
            0, [cast(Paragraph, cell.split(cell_width, 3 * style.leading)[0]) for cell in rows[0]]
        )
    return _PaginatedTable(
        rows,
        colWidths=[column_width] * count,
        repeatRows=1,
        splitByRow=1,
        splitInRow=1,
        hAlign="LEFT",
        spaceAfter=8,
        style=TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9edf2")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c5cbd3")),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        ),
    )


def _story(text: str, page: tuple[float, float]) -> list[Flowable]:
    tokens = _Parser("commonmark", {"html": False}).enable("table").parse(text)
    story: list[Flowable] = []
    lists: list[int | None] = []
    quote = 0
    bullet: str | None = None
    heading = 0
    index = 0
    while index < len(tokens):
        token = tokens[index]
        kind = token.type
        indent = min(120, 14 * (len(lists) + quote))
        if kind == "heading_open":
            heading = int(token.tag[1:])
        elif kind == "heading_close":
            heading = 0
        elif kind == "blockquote_open":
            quote += 1
        elif kind == "blockquote_close":
            quote -= 1
        elif kind in {"bullet_list_open", "ordered_list_open"}:
            lists.append(
                int(token.attrGet("start") or "1") if kind == "ordered_list_open" else None
            )
        elif kind in {"bullet_list_close", "ordered_list_close"}:
            lists.pop()
        elif kind == "list_item_open":
            counter = lists[-1]
            bullet = "•" if counter is None else f"{counter}."
            if counter is not None:
                lists[-1] = counter + 1
        elif kind == "list_item_close":
            bullet = None
        elif kind == "inline":
            style = _style(leftIndent=indent, textColor=colors.HexColor("#202735"))
            if heading:
                style.fontName = FONT + "-Bold"
                style.fontSize = [22, 18, 15, 13, 11, 10][heading - 1]
                style.leading = style.fontSize * 1.3
                style.spaceBefore, style.spaceAfter = 12, 8
            if quote:
                style.textColor = colors.HexColor("#5b6370")
            if bullet:
                style.bulletFontName, style.bulletFontSize = FONT, 10
                style.bulletIndent = max(0, indent - 12)
            story.append(
                Paragraph(_inline(token.children or []) or "&#160;", style, bulletText=bullet)
            )
            bullet = None
        elif kind in {"fence", "code_block"}:
            story.extend(_code(token.content, indent, page))
        elif kind == "table_open":
            end = index + 1
            while tokens[end].type != "table_close":
                end += 1
            story.append(_table(tokens[index + 1 : end], indent, page))
            index = end
        elif kind == "hr":
            story.append(HRFlowable(width="100%", color=colors.HexColor("#c5cbd3"), spaceAfter=8))
        index += 1
    # Syntax-only documents (e.g. empty fences) still yield one useful PDF page.
    return story or [Paragraph("&#160;", _style())]


class _BoundedBuffer(io.BytesIO):
    def __init__(self, maximum: int) -> None:
        super().__init__()
        self.maximum = maximum

    def write(self, data: bytes) -> int:  # type: ignore[override]
        if self.tell() + len(data) > self.maximum:
            raise _OutputLimit()
        return super().write(data)


def render_pdf(
    text: str, limits: Limits, options: MarkdownOptions | None = None
) -> tuple[bytes, int]:
    """Shared in-memory renderer, also exercised by the capability probe."""
    _fonts()
    output = _BoundedBuffer(limits.markdown_max_output_bytes)
    page = _page(options or MarkdownOptions())
    document = SimpleDocTemplate(
        output,
        pagesize=page,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        pageCompression=1,
        title="Markdown",
        author="",
        creator="mi-converter",
    )

    def check_pages(canvas: Any, doc: Any) -> None:
        if doc.page > limits.markdown_max_pages:
            raise _PageLimit()

    try:
        document.build(_story(text, page), onFirstPage=check_pages, onLaterPages=check_pages)
    except (LayoutError, _PageLimit) as exc:
        raise ProcessingError("dimensions-too-large") from exc
    except _OutputLimit as exc:
        raise ProcessingError("result-too-large") from exc
    return output.getvalue(), int(document.page)


def convert(
    source: Path, destination: Path, limits: Limits, options: MarkdownOptions | None = None
) -> dict[str, object]:
    """Produce exactly one bounded PDF in a pre-existing result file."""
    try:
        try:
            with source.open("rb") as stream:
                raw = stream.read(limits.markdown_max_input_bytes + 1)
        except OSError as exc:
            raise ProcessingError("decode-failed") from exc
        if len(raw) > limits.markdown_max_input_bytes:
            raise ProcessingError("file-too-large")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ProcessingError("decode-failed") from exc
        if not text.strip() or any(
            (ord(c) < 32 and c not in "\t\r\n") or 127 <= ord(c) <= 159 for c in text
        ):
            raise ProcessingError("decode-failed")
        try:
            data, pages = render_pdf(text, limits, options)
            with os.fdopen(open_result(destination), "wb") as output:
                output.write(data)
        except (OSError, ValueError) as exc:
            raise ProcessingError("encode-failed") from exc
        return {"pageCount": pages}
    except Exception:
        discard(destination)
        raise
