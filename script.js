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
let rows = [];
let nextRowId = 1;
let draggedRowId = null;

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

const ROW_ACTIONS = [
  { action: 'insert-above', label: '+↑', title: 'Insert a new row above' },
  { action: 'insert-below', label: '+↓', title: 'Insert a new row below' },
  { action: 'delete', label: '✕', title: 'Delete row' },
];

const createRow = (values = {}) => ({
  id: nextRowId++,
  header: '',
  subHeader: '',
  detail: '',
  url: '',
  page: 0,
  custom: false,
  ...values,
});

const isHttpUrl = (value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const updateSummary = () => {
  rowCount.textContent = String(rows.length);
  generateButton.disabled = rows.length === 0;
};

const editableCell = (row, key, title) => {
  const cell = document.createElement('td');
  cell.textContent = row[key];
  cell.contentEditable = 'true';
  cell.spellcheck = false;
  cell.className = 'editable-cell';
  cell.title = title;
  cell.addEventListener('input', () => {
    row[key] = cell.textContent;
    cell.closest('tr')?.classList.remove('invalid');
  });
  return cell;
};

const actionsCell = () => {
  const cell = document.createElement('td');
  cell.className = 'actions-cell';
  const group = document.createElement('div');
  cell.append(group);
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';
  handle.draggable = true;
  group.append(handle);
  ROW_ACTIONS.forEach(({ action, label, title }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `row-button${action === 'delete' ? ' danger' : ''}`;
    button.dataset.action = action;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    group.append(button);
  });
  return cell;
};

const GROUP_COLUMNS = { header: 0, subHeader: 1 };

// Header / sub header: the first row of a group is editable and its edits flow to the repeated rows below;
// repeated (grey) cells are read-only.
const groupCell = (row, key, title, repeated) => {
  if (repeated) {
    const cell = document.createElement('td');
    cell.textContent = row[key];
    cell.className = 'repeat-cell';
    return cell;
  }
  const cell = editableCell(row, key, title);
  let previous = row[key];
  cell.addEventListener('input', () => {
    const start = rows.indexOf(row);
    for (let i = start + 1; i < rows.length && rows[i][key] === previous; i += 1) {
      rows[i][key] = row[key];
      const target = previewRows.querySelector(`[data-row-id="${rows[i].id}"]`)?.children[GROUP_COLUMNS[key]];
      if (target) target.textContent = row[key];
    }
    previous = row[key];
  });
  return cell;
};

const renderPreview = () => {
  previewRows.replaceChildren();
  if (!rows.length) {
    const row = document.createElement('tr');
    row.className = 'placeholder-row';
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No rows yet. Read a PDF to extract its links.';
    row.append(cell);
    previewRows.append(row);
    return;
  }

  let lastHeader = '';
  let lastSubHeader = '';
  rows.forEach((data) => {
    const row = document.createElement('tr');
    row.dataset.rowId = String(data.id);

    if (data.custom) {
      row.classList.add('custom-row');
      row.append(
        editableCell(data, 'header', 'Header for this row'),
        editableCell(data, 'subHeader', 'Sub header for this row'),
        editableCell(data, 'detail', 'Detail text'),
        editableCell(data, 'url', 'Full URL (https://…) this row links to'),
      );
    } else {
      const header = groupCell(data, 'header', 'Click to edit Header (applies to the rows below that repeat it)', data.header === lastHeader);
      const subHeader = groupCell(data, 'subHeader', 'Click to edit sub header (applies to the rows below that repeat it)', data.subHeader === lastSubHeader);
      const link = document.createElement('td');
      const anchor = document.createElement('a');
      anchor.textContent = 'เปิดลิงก์ ↗';
      anchor.title = data.url;
      anchor.href = data.url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      link.append(anchor);
      row.append(
        header,
        subHeader,
        editableCell(data, 'detail', 'Click to edit extracted detail text before export'),
        link,
      );
    }
    row.append(actionsCell());
    previewRows.append(row);
    lastHeader = data.header;
    lastSubHeader = data.subHeader;
  });
};

const refreshRows = () => {
  renderPreview();
  updateSummary();
};

const setRows = (nextRows) => {
  rows = nextRows.map((data) => createRow(data));
  refreshRows();
};

const rowIndexOf = (id) => rows.findIndex((row) => row.id === Number(id));

const moveRow = (from, to) => {
  if (from < 0 || to < 0 || to >= rows.length || from === to) return;
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  refreshRows();
};

const insertRowAt = (position, inheritFrom) => {
  const row = createRow({
    custom: true,
    header: inheritFrom?.header ?? '',
    subHeader: inheritFrom?.subHeader ?? '',
  });
  rows.splice(position, 0, row);
  refreshRows();
  previewRows.querySelector(`[data-row-id="${row.id}"] .editable-cell:nth-child(3)`)?.focus();
};

const deleteRow = (index) => {
  rows.splice(index, 1);
  refreshRows();
};

previewRows.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  const tr = button?.closest('tr');
  if (!tr) return;
  const index = rowIndexOf(tr.dataset.rowId);
  if (index < 0) return;
  const { action } = button.dataset;
  if (action === 'insert-above') insertRowAt(index, rows[index]);
  else if (action === 'insert-below') insertRowAt(index + 1, rows[index]);
  else if (action === 'delete') deleteRow(index);
});

previewRows.addEventListener('dragstart', (event) => {
  const tr = event.target.closest?.('tr');
  if (!tr || !event.target.classList?.contains('drag-handle')) return;
  draggedRowId = Number(tr.dataset.rowId);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(draggedRowId));
  tr.classList.add('dragging');
});

previewRows.addEventListener('dragover', (event) => {
  if (draggedRowId === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  previewRows.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  event.target.closest('tr[data-row-id]')?.classList.add('drop-target');
});

previewRows.addEventListener('drop', (event) => {
  if (draggedRowId === null) return;
  event.preventDefault();
  const target = event.target.closest('tr[data-row-id]');
  const from = rowIndexOf(draggedRowId);
  const to = target ? rowIndexOf(target.dataset.rowId) : -1;
  draggedRowId = null;
  moveRow(from, to);
});

previewRows.addEventListener('dragend', () => {
  draggedRowId = null;
  previewRows.querySelectorAll('.dragging, .drop-target').forEach((el) => el.classList.remove('dragging', 'drop-target'));
});

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
    setRows([]);
    pageCount.textContent = '0';
    rowCount.textContent = '0';
    statusBadge.textContent = 'PDF required';
    setNotice('Choose browser-saved PDF files to extract their actual clickable links.', true);
    return;
  }

  renderFileList(pdfFiles);
  setRows([]);
  generateButton.disabled = true;
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
    setRows(result.rows);
    pageCount.textContent = String(result.pages);
    rowCount.textContent = String(result.rowCount);
    generateButton.disabled = rows.length === 0;

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
  if (!rows.length) {
    statusBadge.textContent = 'No rows';
    setNotice('Add at least one row with a URL before exporting.', true);
    return;
  }

  const invalidIndex = rows.findIndex((data) => data.custom && !isHttpUrl(data.url.trim()));
  if (invalidIndex >= 0) {
    const invalidRow = previewRows.querySelector(`[data-row-id="${rows[invalidIndex].id}"]`);
    invalidRow?.classList.add('invalid');
    invalidRow?.scrollIntoView({ block: 'center' });
    statusBadge.textContent = 'Check rows';
    setNotice(`Row ${invalidIndex + 1} needs a full URL starting with http:// or https://, or delete the row.`, true);
    return;
  }

  generateButton.disabled = true;
  statusBadge.textContent = 'Preparing Excel';
  setNotice('Building the workbook with your reviewed rows.');

  try {
    const reviewedRows = rows.map(({ header, subHeader, detail, url }) => ({
      header: header.trim(),
      subHeader: subHeader.trim(),
      detail: detail.trim(),
      url: url.trim(),
    }));
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: (workbookData?.files ?? []).map((file) => file.filename),
        rows: reviewedRows,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Export failed (${response.status}).`);

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
    updateSummary();
  }
};

const clearFiles = () => {
  requestVersion += 1;
  sourceInput.value = '';
  workbookData = null;
  pageCount.textContent = '0';
  statusBadge.textContent = 'Waiting for PDF';
  renderFileList([]);
  setRows([]);
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
