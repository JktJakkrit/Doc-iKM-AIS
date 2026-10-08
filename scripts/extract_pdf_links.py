#!/usr/bin/env python3
"""Extract clickable-link rows from an iKM page saved as PDF (Chrome / Edge "Save as PDF").

    python extract_pdf_links.py page.pdf --out rows.json [--header "Page title"] [--include-nav]

The output is the JSON that build_xlsx.py --json accepts:
    [{"header": "...", "rows": [{"sub_header": "...", "detail": "...", "url": "...", "page": 4}]}]

Why not just read the text? A PDF printed with "Microsoft Print to PDF" is pure images with no links,
so there is nothing to extract (the script says so and stops). A PDF saved from the browser keeps each
link as an annotation with its real URL, which is what this reads.

How the columns are guessed (always review the preview before building the workbook):
  Header     page title (first header line of page 1, or --header)
  sub header "section > problem label": the last bold line in the left margin is the section,
             the last left-column cell above the link is the problem label (title lines only,
             up to the first "- bullet" line). Labels carry across page breaks.
  Detail     the text line(s) the link sits on
Internal navigation links ("กลับเมนูด้านบน", #Home, top menu #P1..#P9) are skipped unless --include-nav.
"""
import argparse
import json
import re
import sys
import unicodedata

import pymupdf

LEFT_X0_MAX = 135      # left-column text starts near the table's left edge
WIDE_X1_MIN = 420      # lines reaching past this are full-width, not left-column labels
LABEL_GAP = 20         # vertical gap (pt) between left lines that starts a new label (wrapped lines are ~5)
TOP_MARGIN = 30        # browser header (date / title) sits above this; page content starts just below
BOTTOM_MARGIN = 30     # browser footer (URL / page number)
LEAD_IN_MAX = 1        # lines above a short link line that are joined to it to complete a wrapped sentence
SHORT_TAIL = 25        # only a short link line (e.g. just "คลิก") is treated as the tail of a wrapped sentence
MERGE_Y_GAP = 40       # same URL within this many pt (same page) = one multi-line link
NAV_FRAGMENT = re.compile(r"#(Home|P\d+)$")
NUMBERED = re.compile(r"^\W*\d+\s*\.")
BULLET = re.compile(r"^\s*[-–•+]")
COLUMN_TITLES = {"ปัญหาที่พบ", "แนวทางแก้ไข"}


MARKS = "\u0e31\u0e34-\u0e3a\u0e47-\u0e4e"   # Thai vowel/tone marks that sit above or below a letter
MARK_REPEAT = re.compile("([" + MARKS + "])\\1+")
MARKER = re.compile(r"^\s*(\d+\s*\.|[-–•+*])")
THAI = re.compile("[\u0e00-\u0e7f]")
ZERO_WIDTH = re.compile("[\u200b\u200c\u200d\ufeff]")


def squash(s):
    """Collapse whitespace and fix doubled Thai marks that some browser-saved PDFs produce (เรื่่อง -> เรื่อง)."""
    s = ZERO_WIDTH.sub("", unicodedata.normalize("NFC", s))
    s = MARK_REPEAT.sub(r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def join_lines(a, b):
    """Join two wrapped lines. Thai has no space at a wrap point inside a word, so don't add one there."""
    if a and b and THAI.match(a[-1]) and THAI.match(b[0]) and not b.startswith("คลิก"):
        return a + b
    return squash(a + " " + b)


def page_lines(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:
            continue
        for l in b["lines"]:
            text = squash("".join(s["text"] for s in l["spans"]))
            if not text:
                continue
            x0, y0, x1, y1 = l["bbox"]
            chars = [(len(sp["text"].strip()), ("Bd" in sp["font"] or "Bold" in sp["font"] or bool(sp["flags"] & 16)))
                     for sp in l["spans"] if sp["text"].strip()]
            total = sum(n for n, _ in chars) or 1
            bold = sum(n for n, b in chars if b) / total > 0.6   # a bold "-" bullet doesn't make a bold line
            out.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "text": text, "bold": bold})
    out.sort(key=lambda r: (round(r["y0"]), r["x0"]))
    return out


def build_events(doc):
    """Walk every page top to bottom; yield section/label state changes keyed by (page, y)."""
    events = []  # (page_no, y, kind, text)
    for pno, page in enumerate(doc, start=1):
        lines = page_lines(page)
        left = [l for l in lines if l["x0"] < LEFT_X0_MAX and l["x1"] < WIDE_X1_MIN and l["y0"] > TOP_MARGIN
                and l["y1"] < page.rect.height - BOTTOM_MARGIN]
        wide_bold = [l for l in lines if l["x0"] < LEFT_X0_MAX and l["bold"] and l["x1"] >= WIDE_X1_MIN
                     and TOP_MARGIN < l["y0"] < page.rect.height - BOTTOM_MARGIN]
        for l in wide_bold:
            if l["text"] not in COLUMN_TITLES:
                events.append((pno, l["y0"], "section", l["text"]))
        group, prev = [], None
        def flush():
            if group:
                title = []
                for g in group:
                    if BULLET.match(g["text"]):
                        break
                    title.append(g["text"])
                if title:
                    text = title[0]
                    for t in title[1:]:
                        text = join_lines(text, t)
                    events.append((pno, group[0]["y0"], "label", text))
        for l in left:
            if l["bold"]:
                flush(); group, prev = [], None
                if l["text"] not in COLUMN_TITLES:
                    events.append((pno, l["y0"], "section", l["text"]))
                continue
            new = prev is None or NUMBERED.match(l["text"]) or (l["y0"] - prev["y1"]) > LABEL_GAP
            if new and group:
                flush(); group = []
            group.append(l)
            prev = l
        flush()
    events.sort(key=lambda e: (e[0], e[1]))
    return events


def context_at(events, pno, y):
    section = label = ""
    for ep, ey, kind, text in events:
        if (ep, ey) > (pno, y + 2):
            break
        if kind == "section":
            section, label = text, ""
        else:
            label = text
    return section, label


def has_icon(line, icons):
    """True if a small picture (bullet icon) sits just left of the line."""
    return any(i[1] < line["y1"] and i[3] > line["y0"] and line["x0"] - 35 <= i[2] <= line["x0"] + 3 for i in icons)


def with_lead_in(ls, lines, icons):
    """Text of the link line(s); if the link is on the tail of a wrapped sentence, add the lines above it.

    A line continues the one above when it has no list marker / bullet icon of its own, is not indented more
    than the line above, and sits right under it in the same column.
    """
    if not ls:
        return ""
    ls = sorted(ls, key=lambda l: (round(l["y0"]), l["x0"]))
    text = ls[0]["text"]
    for l in ls[1:]:
        text = join_lines(text, l["text"])
    first = ls[0]
    if len(text) > SHORT_TAIL:
        return text        # a full-length line is its own item; long wrapped paragraphs are left for review
    for _ in range(LEAD_IN_MAX):
        if MARKER.match(first["text"]) or has_icon(first, icons):
            break
        above = [l for l in lines if l["y1"] <= first["y0"] + 2 and 0 <= first["y0"] - l["y1"] <= 8
                 and abs(l["x0"] - first["x0"]) <= 40 and l["x0"] < first["x1"] and l["x1"] > first["x0"]]
        if not above:
            break
        prev = max(above, key=lambda l: l["y0"])
        if first["x0"] > prev["x0"] + 3:      # indented sub-item, not a continuation
            break
        text = join_lines(prev["text"], text)
        first = prev
    return text


def collect_links(doc, include_nav):
    links = []
    for pno, page in enumerate(doc, start=1):
        lines = page_lines(page)
        icons = [tuple(i["bbox"]) for i in page.get_image_info()
                 if (i["bbox"][2] - i["bbox"][0]) <= 30 and (i["bbox"][3] - i["bbox"][1]) <= 30]
        for lk in page.get_links():
            uri = lk.get("uri")
            if not uri:
                continue
            r = lk["from"]
            if not include_nav and NAV_FRAGMENT.search(uri):
                continue
            mid = (r.y0 + r.y1) / 2
            on_line = [l for l in lines if l["y0"] - 2 <= mid <= l["y1"] + 2 and l["x0"] - 2 <= r.x1 and l["x1"] + 2 >= r.x0]
            links.append({"page": pno, "y": r.y0, "y1": r.y1, "x": r.x0, "url": uri, "lines": on_line,
                          "fallback": squash(page.get_textbox(r)), "all_lines": lines, "icons": icons})
    links.sort(key=lambda d: (d["page"], round(d["y"]), d["x"]))
    merged = []
    for lk in links:
        for m in reversed(merged[-6:]):
            if m["url"] == lk["url"] and m["page"] == lk["page"] and lk["y"] - m["y1"] <= MERGE_Y_GAP and lk["y"] >= m["y"] - 2:
                known = {(l["y0"], l["x0"]) for l in m["lines"]}
                m["lines"] += [l for l in lk["lines"] if (l["y0"], l["x0"]) not in known]
                m["y1"] = max(m["y1"], lk["y1"])
                break
        else:
            merged.append(dict(lk))
    for m in merged:
        m["text"] = with_lead_in(m["lines"], m["all_lines"], m["icons"]) or m["fallback"]
    return merged


def page_title(doc):
    page = doc[0]
    for l in page_lines(page):
        if l["y0"] < 40 and 150 < l["x0"] < 600:
            return l["text"]
    return squash(doc.metadata.get("title") or "")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--out", required=True)
    ap.add_argument("--header")
    ap.add_argument("--include-nav", action="store_true")
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    n_links = sum(len(p.get_links()) for p in doc)
    n_text = sum(len(p.get_text().strip()) for p in doc)
    if n_links == 0:
        why = "has no text layer" if n_text == 0 else "has text but no links"
        print(f"NO LINKS: this PDF {why} (producer: {doc.metadata.get('producer')}). "
              "Ask for a PDF made with the browser's Save as PDF, or the pasted text / HTML.", file=sys.stderr)
        sys.exit(2)

    events = build_events(doc)
    rows = []
    for lk in collect_links(doc, args.include_nav):
        section, label = context_at(events, lk["page"], lk["y1"] - 1)
        sub = " > ".join(x for x in (section, label) if x)
        rows.append({"sub_header": sub, "detail": lk["text"], "url": lk["url"], "page": lk["page"]})

    result = [{"header": args.header or page_title(doc), "rows": rows}]
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"{len(rows)} link rows from {len(doc)} pages ({n_links} raw links) -> {args.out}")
    for r in rows:
        print(f"p{r['page']:>2} | {r['sub_header'][:60]:60} | {r['detail'][:50]}")


if __name__ == "__main__":
    main()
