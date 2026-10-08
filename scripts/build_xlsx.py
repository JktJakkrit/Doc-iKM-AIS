#!/usr/bin/env python3
"""Convert iKM page content into the user's Excel layout (many pages in one run).

Input (pick one):
  --text  FILE   pasted page text, pipe-separated rows, pages separated by a line of --- or ===
  --json  FILE   [{"header": "...", "rows": [{"sub_header": "...", "detail": "...", "url": "https://..."}]}]

Output:
  --output FILE.xlsx          new workbook (or --append to add to an existing one)
  --append EXISTING.xlsx      add rows below existing data, skipping URLs already present

Options:
  --fill-down                 repeat Header and sub header on every row (default: write once per group, blank below)
  --link-mode label|url       what goes in the Link column: the literal "URL" (default) or the raw URL
  --link-label TEXT           label used when --link-mode label (default "URL")

Only rows that contain a clickable URL are kept. Everything else on the page is dropped.
"""
import argparse
import json
import re
import sys

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font

COLUMNS = ["Header", "sub header", "Detail", "Link", "Link D", "PRC", "NLP", "common", "Web points"]
WIDTHS = [38, 32, 52, 14, 14, 10, 10, 10, 12]

MD_LINK = re.compile(r"\[([^\]]*)\]\((https?://[^)\s]+)\)")
BARE_URL = re.compile(r"https?://[^\s|)\]]+")
PAGE_SEP = re.compile(r"^\s*(-{3,}|={3,})\s*$")


def clean(cell: str) -> str:
    cell = cell.strip()
    if cell in ('""', "''"):
        return ""
    return cell


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def parse_page(lines):
    """Return {"header": str, "rows": [...]} from one page of pipe-separated text."""
    header = ""
    sub = ""
    rows = []
    for line in lines:
        if not line.strip():
            continue
        cells = [clean(c) for c in line.split("|")]
        if not header:
            header = next((c for c in cells if c), "")
            continue  # first non-empty line is the page title

        # a non-empty column B on any line sets the current sub header
        if len(cells) > 1 and cells[1]:
            sub = cells[1]

        found = None
        for idx, cell in enumerate(cells):
            m = MD_LINK.search(cell)
            if m:
                label_text = squash(MD_LINK.sub(lambda mm: mm.group(1), cell))
                found = (idx, label_text, m.group(2))
                break
        if not found:
            for idx, cell in enumerate(cells):
                m = BARE_URL.search(cell)
                if m and cell.strip() != "URL":
                    found = (idx, squash(cell.replace(m.group(0), "")) or m.group(0), m.group(0))
                    break
        if found:
            _, detail, url = found
            rows.append({"sub_header": sub, "detail": detail, "url": url})
    return {"header": header, "rows": rows}


def parse_text(text):
    pages, buf = [], []
    for line in text.splitlines():
        if PAGE_SEP.match(line):
            if buf:
                pages.append(parse_page(buf))
            buf = []
        else:
            buf.append(line)
    if buf:
        pages.append(parse_page(buf))
    return pages


def link_cell(cell, url):
    cell.hyperlink = url
    cell.font = Font(color="0563C1", underline="single")


def row_key(header, sub, detail, url):
    return (squash(header or ""), squash(sub or ""), squash(detail or ""), url)


def existing_keys(ws):
    """Keys of rows already in the sheet. Header / sub header are blank on continuation rows, so carry them down."""
    seen, header, sub = set(), "", ""
    for row in ws.iter_rows(min_row=2):
        a, b, c = row[0].value, row[1].value, row[2].value
        if a:
            header, sub = a, ""
        if b:
            sub = b
        url = ""
        for cell in row[2:4]:
            if cell.hyperlink and cell.hyperlink.target:
                url = cell.hyperlink.target
                break
        if url:
            seen.add(row_key(header, sub, c, url))
    return seen


def write(pages, args):
    if args.append:
        wb = load_workbook(args.append)
        ws = wb.active
        if ws.max_row < 1 or ws.cell(1, 1).value is None:
            ws.append(COLUMNS)
    else:
        wb = Workbook()
        ws = wb.active
        ws.title = "Sheet1"
        ws.append(COLUMNS)
        for i, w in enumerate(WIDTHS, start=1):
            ws.column_dimensions[ws.cell(1, i).column_letter].width = w
        for c in ws[1]:
            c.font = Font(bold=True)
        ws.freeze_panes = "A2"

    # Skip rows already in the workbook so re-running a batch is safe. A row is "the same" only if Header,
    # sub header, Detail and URL all match: the same link (e.g. "My Order CLICK") legitimately appears under
    # many different problems and must be kept for each of them.
    seen = existing_keys(ws) if args.append else set()
    added = skipped = 0
    empty_pages = []

    for page in pages:
        rows = [r for r in page["rows"] if r["url"]]
        if not rows:
            empty_pages.append(page["header"] or "(no title)")
            continue
        last_sub = None
        first = True
        for r in rows:
            key = row_key(page["header"], r["sub_header"], r["detail"], r["url"])
            if key in seen:
                skipped += 1
                continue
            seen.add(key)
            show_header = args.fill_down or first
            show_sub = args.fill_down or r["sub_header"] != last_sub or first
            link_val = r["url"] if args.link_mode == "url" else args.link_label
            ws.append([
                page["header"] if show_header else None,
                r["sub_header"] if show_sub else None,
                r["detail"],
                link_val,
            ])
            row_idx = ws.max_row
            link_cell(ws.cell(row_idx, 3), r["url"])
            link_cell(ws.cell(row_idx, 4), r["url"])
            for c in ws[row_idx]:
                c.alignment = Alignment(wrap_text=True, vertical="top")
            last_sub = r["sub_header"]
            first = False
            added += 1

    out = args.output or args.append
    wb.save(out)
    print(f"saved {out}: {added} rows added, {skipped} duplicates skipped, {len(pages)} pages read")
    if empty_pages:
        print(f"WARNING {len(empty_pages)} page(s) had no URL rows: " + "; ".join(empty_pages), file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text")
    src.add_argument("--json")
    ap.add_argument("--output")
    ap.add_argument("--append")
    ap.add_argument("--fill-down", action="store_true")
    ap.add_argument("--link-mode", choices=["label", "url"], default="label")
    ap.add_argument("--link-label", default="URL")
    args = ap.parse_args()
    if not (args.output or args.append):
        ap.error("give --output or --append")

    if args.text:
        with open(args.text, encoding="utf-8") as f:
            pages = parse_text(f.read())
    else:
        with open(args.json, encoding="utf-8") as f:
            pages = json.load(f)
    write(pages, args)


if __name__ == "__main__":
    main()
