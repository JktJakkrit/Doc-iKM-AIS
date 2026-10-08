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
  Detail     the text line(s) the link sits on. For a bare "คลิก" / image button, the date or "Week N" label
             above it plus the card text just above the button (sub header = the month heading). An image-only
             link uses the image name from the PDF's tag tree (the file name from "Copy image address", no
             extension), plus any visible text inside the clickable area; with no image name it falls back to
             the link's #fragment.
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
GENERIC = re.compile(r"^(คลิก(ที่นี่|ดู)?|click( here)?|here|url)$", re.I)
ALT = re.compile(r"/Alt \(([^)]*)\)")
THAI_MONTHS = "มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม"
DATE_LABEL = re.compile(rf"^\d{{1,2}}(\s*-\s*\d{{1,2}})?\s+({THAI_MONTHS})")
WEEK_LABEL = re.compile(r"^Week\s*\d+$", re.I)
MONTH_HEADER = re.compile(r"^เดือน\s")
SKIP_TEXT = {"หรือ", "or"}
COLUMN_HALF = 75         # a line belongs to a link's column when its centre is within this many pt of the link's
COLUMN_TEXT_MAX_W = 260  # wider lines are paragraphs, not card / cell text
LABEL_MAX_DY = 400       # how far above a link its date / "Week N" label may sit
NEAR_TEXT_DY = 60        # without a label, only text this close above the link describes it
GRID_ROW_GAP = 14        # labelled links whose y differs by less than this (chained) are one grid row


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


def figure_alts(doc):
    """{link annotation xref: [image names]} from the PDF's structure tree.

    Chrome's tagged PDFs keep each <img> as a Figure whose /Alt is the image's file name (the tail of "Copy
    image address", without extension). A Link structure element holds its Figure child(ren) plus an OBJR that
    points at the link annotation, which is how an image-only link is tied to its picture.
    """
    def alts_under(xref, depth=0):
        obj = " ".join(doc.xref_object(xref, compressed=False).split())
        found = []
        if "/S /Figure" in obj:
            m = ALT.search(obj)
            if m:
                found.append(m.group(1))
        if depth < 4:
            for child in re.finditer(r"(\d+) 0 R", re.sub(r"/(P|Pg|Obj) \d+ 0 R", "", obj)):
                found += alts_under(int(child.group(1)), depth + 1)
        return found

    result = {}
    for xref in range(1, doc.xref_length()):
        try:
            obj = " ".join(doc.xref_object(xref, compressed=False).split())
        except Exception:
            continue
        if "/S /Link" not in obj or "/OBJR" not in obj:
            continue
        annots = [int(n) for n in re.findall(r"/Obj (\d+) 0 R", obj)]
        alts = []
        for child in re.finditer(r"(\d+) 0 R", re.sub(r"/(P|Pg|Obj) \d+ 0 R", "", obj)):
            alts += alts_under(int(child.group(1)))
        if alts:
            for a in annots:
                result[a] = alts
    return result


def text_inside(lk):
    """Visible text lines lying inside the link's rectangle (text printed over / inside the clickable area)."""
    out = [l["text"] for l in lk["all_lines"]
           if lk["x"] - 2 <= (l["x0"] + l["x1"]) / 2 <= lk["x1"] + 2 and lk["y"] - 2 <= (l["y0"] + l["y1"]) / 2 <= lk["y1"] + 2
           and not is_generic(l["text"])]
    return " ".join(out)


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
            links.append({"page": pno, "y": r.y0, "y1": r.y1, "x": r.x0, "x1": r.x1, "url": uri, "lines": on_line,
                          "fallback": squash(page.get_textbox(r)), "all_lines": lines, "icons": icons,
                          "page_h": page.rect.height, "xrefs": [lk.get("xref")]})
    links.sort(key=lambda d: (d["page"], round(d["y"]), d["x"]))
    merged = []
    for lk in links:
        for m in reversed(merged[-6:]):
            if m["url"] == lk["url"] and m["page"] == lk["page"] and lk["y"] - m["y1"] <= MERGE_Y_GAP and lk["y"] >= m["y"] - 2:
                known = {(l["y0"], l["x0"]) for l in m["lines"]}
                m["lines"] += [l for l in lk["lines"] if (l["y0"], l["x0"]) not in known]
                m["y1"] = max(m["y1"], lk["y1"])
                m["x1"] = max(m["x1"], lk["x1"])
                m["x"] = min(m["x"], lk["x"])
                m["xrefs"] = m["xrefs"] + lk["xrefs"]
                break
        else:
            merged.append(dict(lk))
    for m in merged:
        m["text"] = with_lead_in(m["lines"], m["all_lines"], m["icons"]) or m["fallback"]
    return merged


def is_generic(text):
    """True when the link text says nothing about the target (empty, "คลิก", "Click")."""
    return not text or bool(GENERIC.match(re.sub(r"[\s\-_.:!?,\"'()\[\]]+", " ", text).strip()))


def column_lines(lk):
    """Short text lines of the page that sit in the same visual column as the link (card / table cell)."""
    cx = (lk["x"] + lk["x1"]) / 2
    return [l for l in lk["all_lines"]
            if TOP_MARGIN < l["y0"] and l["y1"] < lk["page_h"] - BOTTOM_MARGIN
            and l["x1"] - l["x0"] <= COLUMN_TEXT_MAX_W and abs((l["x0"] + l["x1"]) / 2 - cx) <= COLUMN_HALF]


def describe_image_link(lk, page_links):
    """Readable (sub_header, detail) for a link that has no text of its own, e.g. a "คลิก" button under a card.

    Card / table layouts put a date or "Week N" label above the picture and the card text just above the
    button, so the label plus the text between the label (or the previous button) and this button describe it.
    Returns None when nothing useful is found nearby.
    """
    cx = (lk["x"] + lk["x1"]) / 2
    col = column_lines(lk)
    above = [l for l in col if l["y1"] <= lk["y"] + 2]
    labels = [l for l in above if (DATE_LABEL.match(l["text"]) or WEEK_LABEL.match(l["text"]))
              and lk["y"] - l["y1"] <= LABEL_MAX_DY]
    label = max(labels, key=lambda l: l["y1"]) if labels else None
    prev_ends = [o["y1"] for o in page_links if o is not lk and o["y"] < lk["y"] - 5
                 and abs((o["x"] + o["x1"]) / 2 - cx) <= COLUMN_HALF]
    floor = max([label["y1"] if label else lk["y"] - NEAR_TEXT_DY] + prev_ends)
    parts = [l["text"] for l in above
             if l["y0"] >= floor - 1 and l is not label
             and not is_generic(l["text"]) and l["text"] not in SKIP_TEXT
             and not (DATE_LABEL.match(l["text"]) or WEEK_LABEL.match(l["text"]) or MONTH_HEADER.match(l["text"]))]
    text = re.sub(r"\s+(หรือ|or)$", "", " ".join(parts))
    if not label:
        return ("", text, False) if text else None

    month = next((l["text"] for l in sorted(lk["all_lines"], key=lambda l: -l["y0"])
                  if MONTH_HEADER.match(l["text"]) and l["y1"] <= label["y0"] + 2), "")
    year = re.search(r"\d{4}", month)
    name = label["text"]
    if year and DATE_LABEL.match(name):
        name = f"{name} {year.group()}"
    sub = month or ("Week 1-12" if WEEK_LABEL.match(name) else "")
    return sub, (f"{name} – {text}" if text else name), True


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
    found = collect_links(doc, args.include_nav)
    alts_by_annot = figure_alts(doc)
    entries = []
    for lk in found:
        section, label = context_at(events, lk["page"], lk["y1"] - 1)
        sub = " > ".join(x for x in (section, label) if x)
        detail = lk["text"]
        generic = is_generic(detail)
        labelled = False
        described = describe_image_link(lk, [o for o in found if o["page"] == lk["page"]])
        if described and (described[2] or generic):
            new_sub, detail, labelled = described
            if labelled:
                sub = new_sub or sub
        elif generic:
            alts = list(dict.fromkeys(a for x in lk["xrefs"] for a in alts_by_annot.get(x, [])))
            inside = text_inside(lk)
            target = lk["url"].partition("#")[2]
            name = " ".join(alts) or target
            detail = f"{name} – {inside}" if name and inside else (name or inside or f"ลิงก์รูปภาพ (หน้า {lk['page']})")
            labelled = True    # image buttons sit in grids too; read them left to right
        entries.append({"lk": lk, "labelled": labelled,
                        "row": {"sub_header": sub, "detail": detail, "url": lk["url"], "page": lk["page"]}})

    # Cards / table cells on one visual row sit at slightly different y; read them left to right.
    row_y, last = {}, None
    for e in sorted((e for e in entries if e["labelled"]), key=lambda e: (e["lk"]["page"], e["lk"]["y"])):
        lk = e["lk"]
        if last is None or lk["page"] != last["page"] or lk["y"] - last["y"] > GRID_ROW_GAP:
            start = lk["y"]
        row_y[id(e)] = start
        last = lk
    entries.sort(key=lambda e: (e["lk"]["page"], row_y.get(id(e), round(e["lk"]["y"])), e["lk"]["x"]))
    rows = [e["row"] for e in entries]

    result = [{"header": args.header or page_title(doc), "rows": rows}]
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"{len(rows)} link rows from {len(doc)} pages ({n_links} raw links) -> {args.out}")
    for r in rows:
        print(f"p{r['page']:>2} | {r['sub_header'][:60]:60} | {r['detail'][:50]}")


if __name__ == "__main__":
    main()
