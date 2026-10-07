const sourceInput = document.getElementById('sourceInput');
const dropZone = document.getElementById('dropZone');
const fileList = document.getElementById('fileList');
const generateButton = document.getElementById('generateButton');
const resetButton = document.getElementById('resetButton');
const statusBadge = document.getElementById('statusBadge');
const notice = document.getElementById('notice');
const pageCount = document.getElementById('pageCount');
const rowCount = document.getElementById('rowCount');
const previewRows = document.getElementById('previewRows');

let workbookData = null;
let requestVersion = 0;

const setNotice = (message, isError = false) => {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
};

const renderFileList = (files, result) => {
  fileList.replaceChildren();
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-files';
    empty.textContent = 'No files selected';
    fileList.append(empty);
    return;
  }

  files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const details = document.createElement('span');
    details.className = 'file-count';

    if (result?.files?.[index]) {
      const summary = result.files[index];
      details.textContent = summary.error
        ? `Error: ${summary.error}`
        : `${summary.pages} pages · ${summary.rows} links`;
      if (summary.error) details.classList.add('error-text');
    } else {
      details.textContent = 'Ready to process';
    }
    item.append(name, details);
    fileList.append(item);
  });
};

const renderPreview = (rows) => {
  previewRows.replaceChildren();
  if (!rows.length) {
    const row = document.createElement('tr');
    row.className = 'placeholder-row';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'No clickable URLs found in the selected PDFs.';
    row.append(cell);
    previewRows.append(row);
    return;
  }

  let lastHeader = '';
  let lastSubHeader = '';
  rows.forEach((data) => {
    const row = document.createElement('tr');
    row.dataset.rowIndex = String(previewRows.children.length);
    const values = [
      data.header === lastHeader ? '' : data.header,
      data.subHeader === lastSubHeader ? '' : data.subHeader,
      data.detail,
      'URL',
    ];

    values.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 2) {
        cell.textContent = value;
        cell.contentEditable = 'true';
        cell.spellcheck = false;
        cell.className = 'editable-cell';
        cell.title = 'Click to edit extracted detail text before export';
      } else if (index === 3 && data.url) {
        const anchor = document.createElement('a');
        anchor.textContent = value || data.url;
        anchor.href = data.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        cell.append(anchor);
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    });
    previewRows.append(row);
    lastHeader = data.header;
    lastSubHeader = data.subHeader;
  });
};

const processFiles = async (files) => {
  const version = ++requestVersion;
  const pdfFiles = Array.from(files).filter(
    (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
  );
  const skippedFiles = files.length - pdfFiles.length;
  workbookData = null;
  generateButton.disabled = true;

  if (!pdfFiles.length) {
    renderFileList([]);
    renderPreview([]);
    pageCount.textContent = '0';
    rowCount.textContent = '0';
    statusBadge.textContent = 'PDF required';
    setNotice('Choose browser-saved PDF files to extract their actual clickable links.', true);
    return;
  }

  renderFileList(pdfFiles);
  renderPreview([]);
  pageCount.textContent = '…';
  rowCount.textContent = '…';
  statusBadge.textContent = 'Reading PDFs';
  setNotice('Reading every page and extracting the links embedded in the PDF. Please keep this page open.');

  const body = new FormData();
  pdfFiles.forEach((file) => body.append('files', file, file.name));

  try {
    const response = await fetch('/api/convert', {
      method: 'POST',
      body,
    });
    const result = await response.json();
    if (version !== requestVersion) return;
    if (!response.ok) throw new Error(result.error || `Conversion failed (${response.status}).`);

    workbookData = result;
    renderFileList(pdfFiles, result);
    renderPreview(result.rows);
    pageCount.textContent = String(result.pages);
    rowCount.textContent = String(result.rowCount);
    generateButton.disabled = result.rowCount === 0;

    const fileErrors = result.errors || [];
    if (fileErrors.length) {
      statusBadge.textContent = 'Some files failed';
      setNotice(
        `${result.rowCount} link rows extracted; ${fileErrors.length} PDF(s) could not be read: ${fileErrors
          .map((error) => `${error.filename}: ${error.message}`)
          .join(' · ')}`,
        true,
      );
    } else if (skippedFiles) {
      statusBadge.textContent = 'Ready to export';
      setNotice(`${result.rowCount} link rows extracted. ${skippedFiles} non-PDF file(s) were ignored.`);
    } else if (result.rowCount === 0) {
      statusBadge.textContent = 'No clickable URLs';
      setNotice(
        'No external clickable links were found. Use a browser-saved PDF (Chrome/Edge → Print → Save as PDF); a visible “Click” label alone does not contain its destination.',
        true,
      );
    } else {
      statusBadge.textContent = 'Ready to export';
      setNotice(
        `${result.rowCount} linked rows from ${pdfFiles.length} PDF(s) and ${result.pages} pages. Navigation links were skipped, as specified by the skill.`,
      );
    }
  } catch (error) {
    if (version !== requestVersion) return;
    console.error('PDF conversion failed:', error);
    workbookData = null;
    pageCount.textContent = '0';
    rowCount.textContent = '0';
    statusBadge.textContent = 'Conversion failed';
    setNotice(error instanceof Error ? error.message : String(error), true);
  }
};

const downloadWorkbook = async () => {
  if (!workbookData?.workbook) {
    statusBadge.textContent = 'No workbook';
    setNotice('Process at least one PDF with clickable links before exporting.', true);
    return;
  }

  generateButton.disabled = true;
  statusBadge.textContent = 'Preparing Excel';
  setNotice('Building the workbook with your reviewed detail text.');

  try {
    const reviewedRows = workbookData.rows.map((data, index) => {
      const detailCell = previewRows.querySelector(
        `[data-row-index="${index}"] .editable-cell`,
      );
      return { ...data, detail: detailCell?.textContent.trim() ?? data.detail };
    });
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: workbookData.files.map((file) => file.filename),
        rows: reviewedRows,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Export failed (${response.status}).`);

    workbookData.filename = result.filename;
    workbookData.workbook = result.workbook;
    const bytes = Uint8Array.from(atob(result.workbook), (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = result.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    statusBadge.textContent = 'Excel downloaded';
    setNotice(`Exported ${result.rowCount} reviewed link rows to ${result.filename}.`);
  } catch (error) {
    console.error('Excel export failed:', error);
    statusBadge.textContent = 'Export failed';
    setNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    generateButton.disabled = false;
  }
};

const clearFiles = () => {
  requestVersion += 1;
  sourceInput.value = '';
  workbookData = null;
  pageCount.textContent = '0';
  rowCount.textContent = '0';
  generateButton.disabled = true;
  statusBadge.textContent = 'Waiting for PDF';
  renderFileList([]);
  renderPreview([]);
  setNotice('Only rows with a real clickable URL are included. PDF text or a visible “Click” label alone is not a URL.');
};

dropZone.addEventListener('click', (event) => {
  if (event.target !== sourceInput) sourceInput.click();
});
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    sourceInput.click();
  }
});
['dragenter', 'dragover'].forEach((eventName) =>
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragover');
  }),
);
['dragleave', 'drop'].forEach((eventName) =>
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragover');
  }),
);
dropZone.addEventListener('drop', (event) => processFiles(event.dataTransfer.files));
sourceInput.addEventListener('change', () => processFiles(sourceInput.files));
generateButton.addEventListener('click', downloadWorkbook);
resetButton.addEventListener('click', clearFiles);
