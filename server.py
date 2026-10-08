from __future__ import annotations

import base64
import errno
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from email.parser import BytesParser
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parent
EXTRACTOR = ROOT / "scripts" / "extract_pdf_links.py"
WORKBOOK_BUILDER = ROOT / "scripts" / "build_xlsx.py"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8000"))
EXPORT_SUFFIX = "_links.xlsx"
MAX_EXPORT_FILENAME_LENGTH = 31


class AppHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def export_filename(source_names):
    if len(source_names) == 1:
        base_name = Path(source_names[0]).stem
    else:
        base_name = "ikm_pages"

    base_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", base_name)
    base_name = re.sub(r"\s+", " ", base_name).strip(" .-_")
    max_base_length = MAX_EXPORT_FILENAME_LENGTH - len(EXPORT_SUFFIX)
    if len(base_name) > max_base_length:
        base_name = base_name[:max_base_length]
        if " " in base_name:
            base_name = base_name.rsplit(" ", 1)[0]
    base_name = base_name.rstrip(" .-_")
    if not base_name:
        base_name = "ikm_export"
    return f"{base_name}{EXPORT_SUFFIX}"


def unique_sheet_name(stem, used):
    """The PDF's name as its Excel sheet / preview tab; a repeated name gets " (2)", " (3)" ..."""
    base = stem.strip() or "PDF"
    name, n = base, 1
    while name.lower() in used:
        n += 1
        name = f"{base} ({n})"
    used.add(name.lower())
    return name


def print_startup_banner(url):
    width = max(46, len(f"  URL      {url}"))
    use_color = sys.stdout.isatty() and "NO_COLOR" not in os.environ
    cyan = "\033[96m" if use_color else ""
    green = "\033[92m" if use_color else ""
    dim = "\033[2m" if use_color else ""
    reset = "\033[0m" if use_color else ""

    def row(text, color=""):
        print(f"| {color}{text:<{width}}{reset} |")

    border = f"+{'-' * (width + 2)}+"
    print()
    print(border)
    row("iKM PDF to Excel".center(width), cyan)
    row("PDF conversion  |  Local server", dim)
    print(border)
    row("STATUS   Ready", green)
    row(f"URL      {url}", cyan)
    row("STOP     Press Ctrl+C", dim)
    print(border, flush=True)


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        if self.path == "/api/export":
            try:
                result, status_code = self.export_rows()
                body = json.dumps(result, ensure_ascii=False).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:
                traceback.print_exc(file=sys.stderr)
                body = json.dumps(
                    {"error": f"Excel export failed: {error}"},
                    ensure_ascii=False,
                ).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            return
        if self.path != "/api/convert":
            self.send_error(404, "Not found")
            return

        try:
            result, status_code = self.convert_files()
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            body = json.dumps(
                {"error": f"PDF conversion failed: {error}"},
                ensure_ascii=False,
            ).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    def convert_files(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            return {"error": "No files were uploaded."}, 400

        content_type = self.headers.get("Content-Type", "")
        envelope = (
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
            + self.rfile.read(content_length)
        )
        message = BytesParser(policy=default).parsebytes(envelope)
        uploaded = []
        for part in message.iter_parts():
            if part.get_content_disposition() != "form-data" or part.get_param("name", header="content-disposition") != "files":
                continue
            filename = unquote(part.get_filename() or "document.pdf")
            payload = part.get_payload(decode=True) or b""
            if filename.lower().endswith(".pdf") and payload:
                uploaded.append((Path(filename).name, payload))

        if not uploaded:
            return {"error": "Select at least one non-empty PDF file."}, 400

        all_pages = []
        used_sheet_names = set()
        file_summaries = []
        errors = []
        with tempfile.TemporaryDirectory(prefix="ikm-pdf-excel-") as temp_dir:
            temp_path = Path(temp_dir)
            for index, (filename, payload) in enumerate(uploaded, start=1):
                pdf_path = temp_path / f"input-{index}.pdf"
                json_path = temp_path / f"links-{index}.json"
                pdf_path.write_bytes(payload)
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(EXTRACTOR),
                        str(pdf_path),
                        "--out",
                        str(json_path),
                    ],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                    check=False,
                )
                if completed.returncode != 0:
                    errors.append(
                        {
                            "filename": filename,
                            "message": completed.stderr.strip() or completed.stdout.strip() or "Could not extract PDF links.",
                        }
                    )
                    file_summaries.append(
                        {"filename": filename, "pages": 0, "rows": 0, "error": errors[-1]["message"]}
                    )
                    continue

                extracted = json.loads(json_path.read_text(encoding="utf-8"))
                sheet_name = unique_sheet_name(Path(filename).stem, used_sheet_names)
                for page in extracted:
                    page["sheet"] = sheet_name
                    for row in page.get("rows", []):
                        if row.get("page") == 1 and not row.get("sub_header"):
                            row["sub_header"] = "เมนูหลัก (หน้าแรก)"
                            break
                    all_pages.append(page)
                source_rows = sum(len(page.get("rows", [])) for page in extracted)
                summary = re.search(
                    r"from\s+(\d+)\s+pages\s+\((\d+)\s+raw links\)",
                    completed.stdout,
                )
                file_summaries.append(
                    {
                        "filename": filename,
                        "sheet": sheet_name,
                        "pages": int(summary.group(1)) if summary else 0,
                        "rows": source_rows,
                        "rawLinks": int(summary.group(2)) if summary else source_rows,
                    }
                )

            output_path = temp_path / "converted.xlsx"
            json_path = temp_path / "all-links.json"
            json_path.write_text(json.dumps(all_pages, ensure_ascii=False), encoding="utf-8")
            built = subprocess.run(
                [
                    sys.executable,
                    str(WORKBOOK_BUILDER),
                    "--json",
                    str(json_path),
                    "--output",
                    str(output_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                check=False,
            )
            if built.returncode != 0:
                raise RuntimeError(built.stderr.strip() or built.stdout.strip() or "Could not create the Excel workbook.")

            workbook_bytes = output_path.read_bytes()
            total_pages = sum(item["pages"] for item in file_summaries)
            total_rows = sum(item["rows"] for item in file_summaries)
            rows = [
                {
                    "header": page.get("header", ""),
                    "sheet": page.get("sheet", ""),
                    "subHeader": item.get("sub_header", ""),
                    "detail": item.get("detail", ""),
                    "url": item.get("url", ""),
                    "page": item.get("page", 0),
                }
                for page in all_pages
                for item in page.get("rows", [])
                if item.get("url")
            ]
            return (
                {
                    "filename": export_filename([name for name, _ in uploaded]),
                    "pages": total_pages,
                    "rowCount": total_rows,
                    "files": file_summaries,
                    "errors": errors,
                    "rows": rows,
                    "workbook": base64.b64encode(workbook_bytes).decode("ascii"),
                },
                200,
            )

    def export_rows(self):
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            return {"error": "There are no rows to export."}, 400

        payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        source_names = payload.get("files", [])
        rows = payload.get("rows", [])
        pages = []
        for row in rows:
            url = row.get("url", "")
            if not url:
                continue
            header = str(row.get("header", "")).strip()
            sheet = str(row.get("sheet", "")).strip()
            if not pages or pages[-1]["header"] != header or pages[-1]["sheet"] != sheet:
                pages.append({"header": header, "sheet": sheet, "rows": []})
            pages[-1]["rows"].append(
                {
                    "sub_header": str(row.get("subHeader", "")).strip(),
                    "detail": str(row.get("detail", "")).strip(),
                    "url": url,
                }
            )

        if not pages:
            return {"error": "There are no clickable-link rows to export."}, 400

        with tempfile.TemporaryDirectory(prefix="ikm-excel-export-") as temp_dir:
            temp_path = Path(temp_dir)
            json_path = temp_path / "reviewed-links.json"
            output_path = temp_path / "reviewed.xlsx"
            json_path.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(WORKBOOK_BUILDER),
                    "--json",
                    str(json_path),
                    "--output",
                    str(output_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                check=False,
            )
            if completed.returncode != 0:
                raise RuntimeError(
                    completed.stderr.strip() or completed.stdout.strip() or "Could not create the Excel workbook."
                )

            workbook_bytes = output_path.read_bytes()
            return (
                {
                    "filename": export_filename(source_names),
                    "rowCount": sum(len(page["rows"]) for page in pages),
                    "workbook": base64.b64encode(workbook_bytes).decode("ascii"),
                },
                200,
            )


def main():
    if not EXTRACTOR.is_file() or not WORKBOOK_BUILDER.is_file():
        raise SystemExit("The bundled iKM PDF extractor or Excel builder is missing from scripts/.")
    try:
        import openpyxl  # noqa: F401
        import pymupdf  # noqa: F401
    except ImportError as error:
        raise SystemExit(f"Missing dependency: {error.name}. Install requirements.txt first.")

    bind_port = PORT
    server = None
    for candidate in range(PORT, PORT + 20):
        try:
            server = AppHTTPServer((HOST, candidate), AppHandler)
            bind_port = candidate
            break
        except OSError as error:
            if error.errno not in (errno.EADDRINUSE, errno.EACCES):
                raise
            if candidate == PORT:
                print(f"Port {PORT} is already in use; trying {PORT + 1}.", file=sys.stderr)
            if candidate == PORT + 19:
                raise SystemExit(f"Could not start the app because ports {PORT}-{PORT + 19} are unavailable.") from error

    if server is None:
        raise SystemExit(f"Could not start the app on {HOST}:{PORT}.")

    print_startup_banner(f"http://{HOST}:{bind_port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
