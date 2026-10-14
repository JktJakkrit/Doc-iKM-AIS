# Copilot instructions for iKM PDF to Excel

## Project map
- This repository is a local static web app with a Python server; do not introduce a frontend build system, database, or a second app shell for routine changes.
- The browser UI lives in `index.html`, `styles.css`, and `script.js`. `server.py` serves the app and translates between HTTP JSON and the helper scripts.
- The actual PDF work happens in helper scripts under `scripts/`: `extract_pdf_links.py` reads link annotations, text, and image tags from each PDF, while `build_xlsx.py` writes the workbook used for export.
- The supported import flow is PDF-only. Do not restore or add MHTML support unless a clear product requirement demands it.
- This repo's source of truth for workflows and edge cases is `README.md`; follow it instead of inventing UI or export behavior.

## Build, test, and validation commands
```powershell
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python -m unittest tests.test_extract_pdf_links -v
python -m unittest tests.test_extract_pdf_links.LinkedTableMappingTests.test_maps_action_links_to_menu_text_in_the_same_table_row -v
python server.py
```
- There is no dedicated linter configured for this repository.
- The app binds to `127.0.0.1` only and defaults to port `8000`; `PORT` can override it and the server increments ports if needed.
- For PDF/extraction/export changes, run the full unittest suite and then do a smoke test with a real browser-saved PDF to confirm both the preview and the downloaded workbook match the expected behavior.
- When diagnosing startup problems, account for the existing `bs4` reference in `server.py` even though it is not in `requirements.txt`.

## High-level architecture
- Browser upload flow: the user selects or drops PDFs in the UI, `script.js` sends them to `POST /api/convert`, and `server.py` parses the multipart upload.
- Conversion step: `server.py` writes each PDF to a temp file, invokes `scripts/extract_pdf_links.py` as a subprocess, and then normalizes the resulting JSON for the browser.
- Review flow: the browser stores the extracted rows in its in-memory `rows` array, lets the user edit/search them, and treats the table as the source of truth for preview behavior.
- Export flow: `script.js` sends the edited rows to `POST /api/export`; `server.py` calls `scripts/build_xlsx.py`, which writes one sheet per source PDF and returns the workbook as base64 data.
- The app is intentionally local-only and does not use a database or build pipeline. Keep that boundary intact for new work.

## Key conventions and repo-specific invariants
- Preserve the static UI → Python API → subprocess helper boundary. HTTP uses camelCase (`subHeader`) and the helper JSON uses snake_case (`sub_header`); `server.py` owns that translation.
- Only include actual clickable PDF URLs. Never fabricate or translate destinations; preservation of extracted URLs is important.
- Keep browser copy/export behavior and workbook generation consistent when changing layout or formula-safety logic. The `rows` array in `script.js` is the source of truth, and search only filters the preview rather than changing the export dataset.
- Maintain the preview's constrained scrolling: `.table-wrap` is the scrollable table area, while page scrolling is only a fallback for very short windows.
- The workbook layout is fixed: one sheet per PDF, with columns for Header, sub header, Detail, Link, Link D, PRC, NLP, common, and Web points.
- Formula safety matters in Excel: if a value starts with `=`, `+`, `-`, or `@`, Excel treats it as a formula; exported/copy text should prepend a leading space when needed while keeping the preview text unchanged.
- User-added URLs must validate as `http://` or `https://`; rows with invalid URLs block export until fixed.
- `README.md` documents the CLI helper commands and user workflows, including `scripts/extract_pdf_links.py` and `scripts/build_xlsx.py`; prefer those exact semantics when patching extractor or export logic.

## Project layout reference
- `server.py` — serves the app, parses uploads, runs helper scripts, and exposes the local conversion/export endpoints
- `scripts/extract_pdf_links.py` — extracts links and row context from PDFs using PyMuPDF
- `scripts/build_xlsx.py` — writes the final workbook, one sheet per PDF
- `index.html` / `styles.css` / `script.js` — browser interface, preview table, search, tabs, copy, and export
- `tests/` — automated checks for extraction logic and PDF mapping behavior
- `docs/images/` — screenshots used by the project documentation
- `requirements.txt` — Python dependencies (`openpyxl`, `PyMuPDF`)
