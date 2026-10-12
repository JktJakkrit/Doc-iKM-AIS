# Copilot instructions for iKM PDF to Excel

## Project map
- This is a local static web app with a Python server; do not introduce a frontend build system or database for routine changes.
- `index.html`, `styles.css`, and `script.js` own the browser UI. `server.py` serves the UI and translates the HTTP API to the helper scripts' JSON. `scripts/extract_pdf_links.py` extracts PDF links and `scripts/build_xlsx.py` writes the workbook.
- Read [README.md](../README.md) for user workflows, CLI options, workbook layout, and detailed UI behavior; link to it rather than duplicating those details here.

## Commands and checks
```powershell
python -m pip install -r requirements.txt
python server.py
```
- The server binds to `127.0.0.1`, defaults to port `8000`, and tries later ports if needed. It serves files from the repository root, so keep it local and do not expose it on another interface without reviewing the security implications.
- The helper scripts are present under `scripts/`; do not restore over them from the bundled archive. There is no automated test suite or configured linter. For PDF/extraction/export changes, smoke-test with a real browser-saved PDF and verify the preview and downloaded workbook; image-only PDFs do not preserve link targets.

## Behavioral invariants
- Preserve the static UI → Python API → subprocess helper boundary. The API uses camelCase (`subHeader`) while helper JSON uses snake_case (`sub_header`); `server.py` owns that translation.
- Only include actual clickable PDF URLs. Preserve extracted Thai text exactly and never infer or invent destinations. Extracted URLs remain unchanged; validate user-added URLs as `http(s)`.
- The browser's `rows` array is the source of truth. Search only filters the preview; export and copy include all rows. If workbook layout or formula-safety handling changes, keep `scripts/build_xlsx.py` and the browser copy/export behavior in `script.js` consistent.
- Preserve the preview's constrained scrolling: `.table-wrap` is the table scroll area, with page scrolling only as a fallback for very short windows.
