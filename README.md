# iKM PDF to Excel

A local web app that turns iKM pages into an Excel workbook with the nine columns of the sample file (Header, sub header, Detail, Link, Link D, PRC, NLP, common, Web points). Only rows with a real clickable URL are kept.

You can start from a browser-saved PDF.

## Run locally

```powershell
python -m pip install -r requirements.txt
python server.py
```

The terminal shows the server address after startup (it uses a nearby port if 8000 is busy). Open it in a browser. The server listens only on the local computer. Press Ctrl+C in the terminal to stop it.

## Using it

### 1. Convert one or more PDFs

In Chrome or Edge, open the iKM page and use Print → Save as PDF, then drop the file(s) into the app. You can select several PDFs at once, and you can add more PDFs later: new files are added to the ones already loaded, and a repeated file name becomes `name (2)`.

- A screenshot, or a PDF printed as an image, has no link destinations, so nothing can be extracted from it.
- Image-only buttons have no text in the PDF. The app describes them from the surrounding date / "Week N" label and card text. A button that is just a picture is described by its image name (read from the PDF's tags). The PDF does not keep the full image address, so that name is what you get.
- A progress bar shows the upload and reading steps. The upload area is an expansion panel: when reading finishes it folds up to a header line (`1 PDF · 22 pages · 57 links`) and the preview moves up. Click the header to open it again to add files; **Clear** also reopens it.
- With several PDFs, the Output preview shows one tab per PDF (with its row count). Click a tab to view or edit just that PDF.

### 2. Review and export

Edit the preview before exporting (with several PDFs, edit each tab separately):

- **#:** the row number as it will be in the Excel sheet: the header row is 1, so the first data row is 2 (each tab/sheet counts on its own, and the search never renumbers rows). It is only for the web view and is never written to the Excel file.
- **Detail:** editable on every row.
- **Header / sub header:** editable on the first row of each group. The grey repeated cells follow it and are read-only.
- **Link:** the original URL and not editable. In Excel only the Link column carries the hyperlink, shown as `URL`. Detail is plain text.
- **Rows:** insert above or below (`+↑` / `+↓`), reorder by dragging `⠿`, delete with `✕`. A row you add needs a full `http(s)` URL.
- **Copy table:** copies the rows of the open tab exactly as the Excel file lays them out, without the header row (Header once per group, sub header only when it changes, `URL` hyperlink in Link, the other columns blank). Paste at `A2` to line the rows up with the `#` numbers. It copies every row of the tab even while the search is on. Excel receives the rich HTML version (hyperlinks kept); plain-text editors get tab-separated text with the real URL in the Link column.
- **Text starting with `=`, `+`, `-` or `@`:** Excel would read such a cell as a formula when you paste or open it, so Header, sub header and Detail get one space in front of that symbol (e.g. ` + บันทึกข้อมูล`). This applies to both Copy table and Export Excel; the preview keeps the original text.
- **Undo:** the **↶ Undo** button (or `Ctrl+Z` when you are not typing in a cell) steps back through deleted, inserted and moved rows. Text you typed in a cell is undone with the browser's normal `Ctrl+Z` while the cell is focused.
- **Search:** the search box filters the rows of the open tab (Header, sub header, Detail and URL) and shows `N of M`. It only changes what you see; export always includes every row.
- **Clear** asks for confirmation first, because it removes all files and edits.

Click **Export Excel**. All PDFs are combined into one `.xlsx` with one sheet per PDF, named after the PDF (a repeated name gets ` (2)`, and Excel limits sheet names to 31 characters). Export names are sanitized and limited to 31 characters, including the `.xlsx` extension.

## Project layout

| Path | Purpose |
| --- | --- |
| `server.py` | Serves the page and the two endpoints: `POST /api/convert` (PDF → rows) and `POST /api/export` (reviewed rows → `.xlsx`) |
| `scripts/extract_pdf_links.py` | Reads link annotations, text and image tags from a PDF (PyMuPDF) |
| `scripts/build_xlsx.py` | Writes the workbook (openpyxl) |
| `index.html`, `styles.css`, `script.js` | The browser interface |

There are no automated tests. To check a change, run the app and convert a real browser-saved PDF.
