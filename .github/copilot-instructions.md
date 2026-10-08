# Copilot instructions for iKM PDF to Excel

## Purpose
This repository is a local web app that converts browser-saved iKM PDFs into Excel workbooks. The app is intentionally lightweight: a static frontend (`index.html`, `styles.css`, `script.js`) talks to a local Python server (`server.py`) that extracts clickable PDF links and builds an `.xlsx` workbook.

## Commands
### Local setup
```powershell
python -m pip install -r requirements.txt
python server.py
```

The server prints the URL to open after startup. It honors the `PORT` env var (default `8000`) and tries up to 19 following ports if that one is busy.

### Missing helper scripts (important)
`server.py` shells out to `scripts/extract_pdf_links.py` and `scripts/build_xlsx.py` and exits immediately with `The bundled iKM PDF extractor or Excel builder is missing from scripts/.` if either is absent. In this checkout `scripts/` and `tests/` contain only stale `__pycache__` files, and the sources are not tracked in git. The originals are bundled in `ikm-page-to-excel.skill` (a zip) under `ikm-page-to-excel/scripts/` (and `ikm-page-to-excel/app/scripts/`); its `SKILL.md` documents their CLI and options. Restore them from there rather than rewriting them:
```powershell
Expand-Archive ikm-page-to-excel.skill -DestinationPath $env:TEMP\ikm-skill -Force
Copy-Item $env:TEMP\ikm-skill\ikm-page-to-excel\scripts\*.py scripts\
```

The helper CLIs the server relies on:
- `extract_pdf_links.py <pdf> --out <json>` (prints a summary matching `from N pages (M raw links)`, which `server.py` parses with a regex; nav links are skipped unless `--include-nav`).
- `build_xlsx.py --json <json> --output <xlsx>`

### Test and lint commands
There is no test runner, linter, or task config. `tests/` only has stale `.pyc` files from `test_build_xlsx`, `test_extract_pdf_links`, and `test_server` (the sources are gone), so there is no single-test command.

If you need a smoke check while changing behavior, run the app locally and validate the end-to-end flow with a real browser-saved PDF using the UI:
1. Start the server with `python server.py`.
2. Upload a PDF created via Chrome/Edge `Print -> Save as PDF`.
3. Confirm the preview shows clickable rows and that the Excel export downloads successfully.

## Architecture
- `server.py` is the core of the app. It serves static files from the repo root (`SimpleHTTPRequestHandler`, so every file in the repo root is publicly readable locally) and exposes two HTTP endpoints:
  - `POST /api/convert` takes multipart `files` (PDFs only), writes each to a temp dir, runs the extractor subprocess per file, then runs the workbook builder once over all pages. Returns `rows`, per-file `files` summaries, `errors`, `pages`, `rowCount`, a suggested `filename`, and the base64 `workbook`. A failing PDF is reported in `errors` without failing the others.
  - `POST /api/export` takes JSON `{files, rows}` (rows keyed `header`, `subHeader`, `detail`, `url`), regroups consecutive rows by `header` into the extractor's JSON shape (`[{header, rows:[{sub_header, detail, url}]}]`), rebuilds the workbook with the builder, and returns base64.
- The extractor/builder JSON uses snake_case (`sub_header`); the HTTP API and browser use camelCase (`subHeader`). `server.py` is where the two are translated.
- `script.js` owns the client-side workflow: file selection, drag-and-drop handling, preview rendering, inline editing of the `Detail` column, and the final Excel download. Preview rows are tracked by a per-row `id` (`data-row-id`); Header/sub header text is blanked in the preview when it repeats the previous extracted row (display only, the data keeps the values). `requestVersion` discards stale responses when a new upload starts.
- `index.html` provides the single-page UI shell and preview table. The actual UI logic lives in `script.js`.
- `requirements.txt` contains the runtime dependencies: `openpyxl` and `PyMuPDF`.
- The PDF extraction and workbook generation steps are delegated to helper scripts that the server calls via subprocesses; they are expected to be available under `scripts/` for the local app to start.

The important design boundary is: frontend uploads + preview, Python server orchestrates extraction + export, the generated Excel workbook is produced from the extracted page/link data rather than from a database or server-side model.

## Key conventions and repository-specific behavior
- Only rows with a real clickable URL are included. Text in the PDF or a visible `Click` label is not treated as a valid URL.
- The app expects browser-saved PDFs, not screenshots or PDFs printed as images. URL destinations are embedded in the PDF; a rasterized image or screenshot does not preserve the original link targets.
- The preview is intentionally editable: the `Detail` cell can be changed before export, but the `Link` value remains the original URL target. Rows can also be inserted above/below (`+↑`/`+↓`), reordered by dragging the ⠿ handle, and deleted (✕). `script.js` keeps the rows in a `rows` array (source of truth, re-rendered after each structural change). User-added rows (`custom: true`) have editable Header/sub header/Detail/URL cells, must have an `http(s)` URL, and are validated client-side before export; extracted rows keep their original URL.
- Export filenames are sanitized and limited to 31 characters including the `.xlsx` suffix; multi-file exports use a shared base name.
- The server binds to `127.0.0.1` only and is meant to run locally for private PDF processing.
- Output workbook has nine columns: Header, sub header, Detail, Link, Link D, PRC, NLP, common, Web points. Detail and Link (literal text `URL`) are hyperlinked; Link D and the last four columns stay blank. Header is written once per page group and sub header only when it changes (`--fill-down` is opt-in).
- Keep Thai text exactly as extracted (including original misspellings) and never invent or guess a URL.
- On `/api/convert`, the first page-1 row with no sub header gets `เมนูหลัก (หน้าแรก)` injected by `server.py`.
- `.gitignore` excludes `*.pdf` and `*.xlsx`, so sample files are never committed.
- Keep changes aligned with the existing pipeline: user-facing rules live in the browser layer, while extraction/export correctness remains in the Python server subprocess path.

## Repository-specific guidance
- Do not assume this repo has a Node.js or Python package structure beyond the local app server.
- Prefer small, direct changes that preserve the static + Python split rather than introducing a new framework or build system.
- If you extend the conversion logic, keep the user-facing requirement in mind: the tool is built around preserving actual browser-saved PDF link destinations and allowing review/editing before export.
- When making changes around PDF parsing or Excel output, validate against a real PDF rather than only unit-level assumptions, because the correctness depends on preserved link metadata from the source document.
