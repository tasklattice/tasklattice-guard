"""Source-preserving text views and bounded sibling-list contexts for regexes."""
from __future__ import annotations

import re
from html import unescape
from html.parser import HTMLParser


class _VisibleHTML(HTMLParser):
    """Map visible characters back to the source; never transform markup itself."""

    _BLOCKS = frozenset({"p", "div", "section", "article", "li", "ul", "ol", "table", "tr", "td", "th", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6"})
    _HIDDEN = frozenset({"script", "style", "code", "pre", "head"})

    def __init__(self, source: str):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_offsets = [0, *[m.end() for m in re.finditer("\n", source)]]
        self.parts: list[str] = []
        self.offsets: list[tuple[int, int] | None] = []
        self.hidden: list[str] = []

    def position(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def boundary(self, block: bool = False) -> None:
        self.parts.append("\n" if block else " ")
        self.offsets.append(None)

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self._HIDDEN:
            self.hidden.append(tag)
        self.boundary(tag in self._BLOCKS or bool(self.hidden))

    def handle_endtag(self, tag: str) -> None:
        if tag in self.hidden:
            del self.hidden[self.hidden.index(tag):]
        self.boundary(tag in self._BLOCKS or tag in self._HIDDEN)

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self.boundary(tag in self._BLOCKS)

    def handle_data(self, data: str) -> None:
        if self.hidden:
            return
        start = self.position()
        self.parts.append(data)
        self.offsets.extend((start + i, start + i + 1) for i in range(len(data)))

    def handle_entityref(self, name: str) -> None:
        self.entity("&" + name)

    def handle_charref(self, name: str) -> None:
        self.entity("&#" + name)

    def entity(self, prefix: str) -> None:
        if self.hidden:
            return
        start = self.position()
        raw = prefix + (";" if self.source[start + len(prefix):].startswith(";") else "")
        value = unescape(raw)
        self.parts.append(value)
        self.offsets.extend([(start, start + len(raw))] * len(value))


def html_view(source: str) -> tuple[str, list[tuple[int, int] | None]]:
    parser = _VisibleHTML(source)
    parser.feed(source)
    parser.close()  # Flush a truncated trailing text node as data.
    return "".join(parser.parts), parser.offsets


def project_spans(spans: list[tuple[int, int]], offsets: list[tuple[int, int] | None], source: str) -> list[tuple[int, int]]:
    """Project matches to literal text nodes, preserving tags and their attributes."""
    result: list[tuple[int, int]] = []
    for start, end in spans:
        for mapped in offsets[start:end]:
            if mapped is None:
                continue
            if result and mapped[0] <= result[-1][1]:
                result[-1] = (result[-1][0], max(result[-1][1], mapped[1]))
            else:
                result.append(mapped)
    return [(start, end) for start, end in result if unescape(source[start:end]).strip()]


_ENTRY = re.compile(r"(?P<indent>[ \t]*)[-*][ \t]+(?P<value>[^\r\n]*)\r?$")


def sibling_list_ranges(source: str, patterns: list[str]) -> list[tuple[int, int]]:
    """Only contiguous same-indent scalar siblings; never leak across a record.

    Each required pattern must fully match a sibling value. Large or multiline
    records are deliberately unsupported rather than searched without bounds.
    """
    compiled = [re.compile(p, re.IGNORECASE) for p in patterns]
    result: list[tuple[int, int]] = []
    group: list[tuple[int, int, str]] = []
    indent: str | None = None

    def finish() -> None:
        if (group and len(group) <= 32 and group[-1][1] - group[0][0] <= 8192
                and all(any(p.fullmatch(v) for _, _, v in group) for p in compiled)):
            result.append((group[0][0], group[-1][1]))

    offset = 0
    for line in source.splitlines(keepends=True):
        m = _ENTRY.fullmatch(line.rstrip("\n"))
        if not m or m["indent"] != indent:
            finish()
            group = []
            indent = m["indent"] if m else None
        if m:
            group.append((offset, offset + len(line), m["value"].strip()))
        offset += len(line)
    finish()
    return result
