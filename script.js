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
const uploadToggle = document.getElementById('uploadToggle');
const uploadBody = document.getElementById('uploadBody');
const uploadSummary = document.getElementById('uploadSummary');

const setUploadExpanded = (expanded) => {
  uploadToggle.setAttribute('aria-expanded', String(expanded));
  uploadBody.classList.toggle('collapsed', !expanded);
  uploadBody.querySelector('.panel-inner').inert = !expanded;
};

uploadToggle.addEventListener('click', () => {
  setUploadExpanded(uploadToggle.getAttribute('aria-expanded') !== 'true');
});
const sheetTabs = document.getElementById('sheetTabs');
const rowFilter = document.getElementById('rowFilter');
const filterCount = document.getElementById('filterCount');
const copyButton = document.getElementById('copyButton');
let activeSheet = '';
const progress = document.getElementById('progress');
const progressLabel = document.getElementById('progressLabel');
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');


let requestVersion = 0;
let rows = [];
let nextRowId = 1;
let draggedRowId = null;
let activeRequest = null;
let progressTimer = null;
let progressValue = 0;
let loadedFiles = [];     // every PDF read so far: { name, pages, rows, error }
let busy = false;          // a PDF batch is being uploaded / read
let filterText = '';

const UPLOAD_SHARE = 30;   // % of the bar covered by the real upload
const PROCESS_CAP = 95;    // the server gives no progress, so processing creeps toward this and finishes on reply

const setProgress = (value, label, state = '') => {
  progressValue = Math.max(0, Math.min(100, value));
  const shown = Math.round(progressValue);
  progress.hidden = false;
  progress.classList.toggle('done', state === 'done');
  progress.classList.toggle('failed', state === 'failed');
  progress.setAttribute('aria-valuenow', String(shown));
  progressFill.style.width = `${shown}%`;
  progressPercent.textContent = `${shown}%`;
  if (label) progressLabel.textContent = label;
};

const stopProgressTimer = () => {
  window.clearInterval(progressTimer);
  progressTimer = null;
};

const hideProgress = () => {
  stopProgressTimer();
  progress.hidden = true;
};

const startProcessingProgress = (label) => {
  stopProgressTimer();
  setProgress(Math.max(progressValue, UPLOAD_SHARE), label);
  progressTimer = window.setInterval(() => {
    setProgress(progressValue + (PROCESS_CAP - progressValue) * 0.05, label);
  }, 250);
};

const uploadPdfs = (body, onUploadProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeRequest = xhr;
    xhr.open('POST', '/api/convert');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onUploadProgress(event.loaded / event.total);
    });
    xhr.upload.addEventListener('load', () => onUploadProgress(1));
    xhr.addEventListener('load', () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, result: xhr.response || {} }));
    xhr.addEventListener('error', () => reject(new Error('Could not reach the local server.')));
    xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    xhr.send(body);
  });

const setNotice = (message, isError = false) => {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const renderFileList = (pending = []) => {
  fileList.replaceChildren();
  if (!loadedFiles.length && !pending.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-files';
    empty.textContent = 'No files selected';
    fileList.append(empty);
    return;
  }

  const addItem = (fileName, text, isError = false) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = fileName;
    const details = document.createElement('span');
    details.className = 'file-count';
    details.textContent = text;
    if (isError) details.classList.add('error-text');
    item.append(name, details);
    fileList.append(item);
  };

  loadedFiles.forEach((file) =>
    file.error
      ? addItem(file.name, `Error: ${file.error}`, true)
      : addItem(file.name, `${plural(file.pages, 'page')} · ${plural(file.rows, 'link')}`),
  );
  pending.forEach((file) => addItem(file.name, 'Reading…'));
};

const refreshUploadSummary = () => {
  if (!loadedFiles.length) {
    uploadSummary.textContent = 'No files selected';
    return;
  }
  const pages = loadedFiles.reduce((sum, file) => sum + (file.pages || 0), 0);
  uploadSummary.textContent = `${plural(loadedFiles.length, 'PDF')} · ${plural(pages, 'page')} · ${plural(rows.length, 'link')}`;
  pageCount.textContent = String(pages);
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
  sheet: '',
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
  copyButton.disabled = !rows.some((data) => data.sheet === activeSheet);
};

const matchesFilter = (data) =>
  !filterText ||
  data.custom ||    // rows the user just added stay visible even while their fields are still empty
  `${data.header} ${data.subHeader} ${data.detail} ${data.url}`.toLowerCase().includes(filterText);

const insertPlainText = (text) => {
  if (document.execCommand('insertText', false, text)) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

const editableCell = (row, key, title) => {
  const cell = document.createElement('td');
  cell.textContent = row[key];
  cell.contentEditable = 'true';
  cell.spellcheck = false;
  cell.className = 'editable-cell';
  cell.title = title;
  // Pasted HTML would bring its own colours / fonts (e.g. black text on the dark table): keep plain text only.
  cell.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
    insertPlainText(text);
  });
  cell.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      cell.blur();
    }
  });
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

const GROUP_COLUMNS = { header: 1, subHeader: 2 };    // cell index in a row (cell 0 is the row number)

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
    for (let i = start + 1; i < rows.length && rows[i].sheet === row.sheet && rows[i][key] === previous; i += 1) {
      rows[i][key] = row[key];
      const target = previewRows.querySelector(`[data-row-id="${rows[i].id}"]`)?.children[GROUP_COLUMNS[key]];
      if (target) target.textContent = row[key];
    }
    previous = row[key];
  });
  return cell;
};

const renderSheetTabs = () => {
  const sheets = [...new Set(rows.map((data) => data.sheet))];
  if (!sheets.includes(activeSheet)) activeSheet = sheets[0] ?? '';
  sheetTabs.replaceChildren();
  sheetTabs.hidden = sheets.length < 2;
  if (sheets.length < 2) return;
  sheets.forEach((sheet) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'sheet-tab';
    tab.role = 'tab';
    tab.dataset.sheet = sheet;
    tab.title = sheet;
    tab.setAttribute('aria-selected', String(sheet === activeSheet));
    const name = document.createElement('span');
    name.className = 'sheet-tab-name';
    name.textContent = sheet || '(no name)';
    const count = document.createElement('span');
    count.className = 'sheet-tab-count';
    count.textContent = String(rows.filter((data) => data.sheet === sheet).length);
    tab.append(name, count);
    sheetTabs.append(tab);
  });
};

const renderPreview = () => {
  previewRows.replaceChildren();
  renderSheetTabs();
  if (!rows.length) {
    filterCount.hidden = true;
    const row = document.createElement('tr');
    row.className = 'placeholder-row';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No rows yet. Read a PDF to extract its links.';
    row.append(cell);
    previewRows.append(row);
    return;
  }

  // With several PDFs only the selected one is listed; export still writes every one, one sheet each.
  const sheetRows = rows.filter((data) => data.sheet === activeSheet);
  const visibleRows = sheetRows.filter(matchesFilter);
  filterCount.hidden = !filterText;
  filterCount.textContent = `${visibleRows.length} of ${sheetRows.length}`;
  if (!visibleRows.length) {
    const row = document.createElement('tr');
    row.className = 'placeholder-row';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = `No rows match “${rowFilter.value.trim()}”.`;
    row.append(cell);
    previewRows.append(row);
    return;
  }
  let lastHeader = '';
  let lastSubHeader = '';
  // Numbers match the Excel row: the header row is 1, so the first data row is 2. Search never renumbers them.
  const positions = new Map(sheetRows.map((data, index) => [data.id, index + 2]));
  visibleRows.forEach((data) => {
    const row = document.createElement('tr');
    row.dataset.rowId = String(data.id);
    const number = document.createElement('td');
    number.className = 'row-number';
    number.textContent = String(positions.get(data.id));
    number.title = `Row ${positions.get(data.id)} in this sheet of the Excel file (row 1 is the header)`;
    row.append(number);
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
  activeSheet = rows[0]?.sheet ?? '';
  refreshRows();
};

sheetTabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.sheet-tab');
  if (!tab || tab.dataset.sheet === activeSheet) return;
  activeSheet = tab.dataset.sheet;
  refreshRows();
});

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
    sheet: inheritFrom?.sheet ?? '',
  });
  rows.splice(position, 0, row);
  refreshRows();
  previewRows.querySelector(`[data-row-id="${row.id}"] .editable-cell:nth-child(4)`)?.focus();
};

const deleteRow = (index) => {
  rows.splice(index, 1);
  refreshRows();
};

rowFilter.addEventListener('input', () => {
  filterText = rowFilter.value.trim().toLowerCase();
  renderPreview();
});

// ---- Copy the open sheet exactly as the Excel export lays it out -------------------------------------------
const LINK_LABEL = 'URL';

// Same rule as build_xlsx.py: Excel treats a cell starting with = + - @ as a formula, so a space goes in front.
const excelSafe = (text) => (/^[=+\-@]/.test(text) ? ` ${text}` : text);

// Mirrors build_xlsx.py: only rows with a URL; Header only on the first row of a group (a run with the same
// Header), sub header only when it changes; Link shows "URL" and carries the hyperlink; the last 4 columns are blank.
const excelRowsForSheet = (sheet) => {
  const out = [];
  let previousHeader = null;
  let lastSub = null;
  rows
    .filter((data) => data.sheet === sheet && data.url.trim())
    .forEach((data) => {
      const header = data.header.trim();
      const sub = data.subHeader.trim();
      const firstOfGroup = previousHeader === null || header !== previousHeader;
      if (firstOfGroup) lastSub = null;
      out.push({
        header: excelSafe(firstOfGroup ? header : ''),
        subHeader: excelSafe(firstOfGroup || sub !== lastSub ? sub : ''),
        detail: excelSafe(data.detail.trim()),
        url: data.url.trim(),
      });
      previousHeader = header;
      lastSub = sub;
    });
  return out;
};

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const oneLine = (text) => text.replace(/\s*[\r\n\t]+\s*/g, ' ');

const sheetClipboard = (sheet) => {
  const data = excelRowsForSheet(sheet);
  const body = data
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.header)}</td><td>${escapeHtml(r.subHeader)}</td><td>${escapeHtml(r.detail)}</td>` +
        `<td><a href="${escapeHtml(r.url)}">${LINK_LABEL}</a></td><td></td><td></td><td></td><td></td><td></td></tr>`,
    )
    .join('');
  const html = `<meta charset="utf-8"><table><tbody>${body}</tbody></table>`;
  // Plain text (for editors that ignore HTML): tab-separated, with the real URL in the Link column.
  const text = data
    .map((r) => [r.header, r.subHeader, r.detail, r.url, '', '', '', '', ''].map(oneLine).join('\t'))
    .join('\n');
  return { html, text, count: data.length };
};

const copyWithSelection = (html) => {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  holder.innerHTML = html;
  document.body.append(holder);
  const range = document.createRange();
  range.selectNodeContents(holder);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const ok = document.execCommand('copy');
  selection.removeAllRanges();
  holder.remove();
  return ok;
};

copyButton.addEventListener('click', async () => {
  const { html, text, count } = sheetClipboard(activeSheet);
  if (!count) return;
  let copied = false;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    copied = true;
  } catch {
    copied = copyWithSelection(html);
  }
  const label = copyButton.textContent;
  if (copied) {
    copyButton.textContent = 'Copied ✓';
    setNotice(`Copied ${count} rows${activeSheet ? ` from “${activeSheet}”` : ''} (no header row). Paste into Excel where you want them; the first row lands in Excel row 2 if you paste at A2.`);
  } else {
    setNotice('The browser blocked copying. Use Export Excel instead.', true);
  }
  window.setTimeout(() => { copyButton.textContent = label; }, 1500);
});

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

const uniqueSheetName = (name, taken) => {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${name} (${n})`;
  taken.add(candidate.toLowerCase());
  return candidate;
};

// New PDFs are added to the ones already loaded; a repeated PDF name becomes "name (2)".
const processFiles = async (files) => {
  const pdfFiles = Array.from(files).filter(
    (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
  );
  const skippedFiles = files.length - pdfFiles.length;

  if (busy) {
    setNotice('Still reading the previous PDFs. Add more files when it finishes.', true);
    return;
  }

  if (!pdfFiles.length) {
    if (!loadedFiles.length) {
      hideProgress();
      setUploadExpanded(true);
      uploadSummary.textContent = 'No PDF selected';
      statusBadge.textContent = 'PDF required';
    }
    setNotice('Choose browser-saved PDF files to extract their actual clickable links.', true);
    return;
  }

  busy = true;
  const version = ++requestVersion;
  generateButton.disabled = true;
  renderFileList(pdfFiles);
  uploadSummary.textContent = `Reading ${pdfFiles.length} PDF${pdfFiles.length > 1 ? 's' : ''}…`;
  statusBadge.textContent = 'Reading PDFs';
  setNotice('Reading every page and extracting the links embedded in the PDF. Please keep this page open.');

  const body = new FormData();
  pdfFiles.forEach((file) => body.append('files', file, file.name));

  setProgress(0, 'Uploading PDF…');

  try {
    const { ok, status, result } = await uploadPdfs(body, (fraction) => {
      if (version !== requestVersion) return;
      if (fraction < 1) setProgress(fraction * UPLOAD_SHARE, 'Uploading PDF…');
      else startProcessingProgress('Reading pages and extracting links…');
    });
    if (version !== requestVersion) return;
    if (!ok) throw new Error(result.error || `Conversion failed (${status}).`);
    stopProgressTimer();
    setProgress(100, 'Done', 'done');
    window.setTimeout(() => {
      if (version === requestVersion) hideProgress();
    }, 1200);

    const taken = new Set(rows.map((data) => data.sheet.toLowerCase()));
    const renamed = new Map();
    const added = (result.rows || []).map((data) => {
      if (!renamed.has(data.sheet)) renamed.set(data.sheet, uniqueSheetName(data.sheet || 'PDF', taken));
      return createRow({ ...data, sheet: renamed.get(data.sheet) });
    });
    rows = rows.concat(added);
    if (added.length) activeSheet = added[0].sheet;
    loadedFiles = loadedFiles.concat(
      (result.files || []).map((file) => ({
        name: file.filename,
        pages: file.pages,
        rows: file.rows,
        error: file.error,
      })),
    );
    renderFileList();
    refreshRows();
    refreshUploadSummary();
    setUploadExpanded(false);

    const fileErrors = result.errors || [];
    if (fileErrors.length) {
      statusBadge.textContent = 'Some files failed';
      setNotice(
        `${added.length} link rows added; ${fileErrors.length} PDF(s) could not be read: ${fileErrors
          .map((error) => `${error.filename}: ${error.message}`)
          .join(' · ')}`,
        true,
      );
    } else if (skippedFiles) {
      statusBadge.textContent = 'Ready to export';
      setNotice(`${added.length} link rows added. ${skippedFiles} non-PDF file(s) were ignored.`);
    } else if (!rows.length) {
      statusBadge.textContent = 'No clickable URLs';
      setNotice(
        'No external clickable links were found. Use a browser-saved PDF (Chrome/Edge → Print → Save as PDF); a visible “Click” label alone does not contain its destination.',
        true,
      );
    } else {
      statusBadge.textContent = 'Ready to export';
      setNotice(
        `${added.length} linked rows added from ${pdfFiles.length} PDF(s) (${rows.length} rows in ${loadedFiles.length} PDF(s) now). Navigation links were skipped, as specified by the skill.${
          loadedFiles.length > 1 ? ' Pick a PDF tab to view or edit it; Export Excel combines all of them into one workbook, one sheet per PDF.' : ''
        }`,
      );
    }
  } catch (error) {
    if (version !== requestVersion) return;
    console.error('PDF conversion failed:', error);
    stopProgressTimer();
    setProgress(progressValue, 'Failed', 'failed');
    setUploadExpanded(true);
    renderFileList();
    refreshUploadSummary();
    if (!loadedFiles.length) uploadSummary.textContent = 'Could not read the PDF';
    statusBadge.textContent = 'Conversion failed';
    setNotice(error instanceof Error ? error.message : String(error), true);
  } finally {
    if (version === requestVersion) busy = false;
    updateSummary();
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
    if (rows[invalidIndex].sheet !== activeSheet) {
      activeSheet = rows[invalidIndex].sheet;
      refreshRows();
    }
    const invalidRow = previewRows.querySelector(`[data-row-id="${rows[invalidIndex].id}"]`);
    invalidRow?.classList.add('invalid');
    invalidRow?.scrollIntoView({ block: 'center' });
    statusBadge.textContent = 'Check rows';
    const where = rows[invalidIndex].sheet ? ` in “${rows[invalidIndex].sheet}”` : '';
    const position = rows.filter((data) => data.sheet === rows[invalidIndex].sheet).indexOf(rows[invalidIndex]) + 1;
    setNotice(`Row ${position}${where} needs a full URL starting with http:// or https://, or delete the row.`, true);
    return;
  }

  generateButton.disabled = true;
  statusBadge.textContent = 'Preparing Excel';
  setNotice('Building the workbook with your reviewed rows.');

  try {
    const reviewedRows = rows.map(({ header, subHeader, detail, url, sheet }) => ({
      header: header.trim(),
      subHeader: subHeader.trim(),
      detail: detail.trim(),
      url: url.trim(),
      sheet: (sheet || '').trim(),
    }));
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: loadedFiles.map((file) => file.name),
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
  if (rows.length && !window.confirm('Clear all files and rows? Your edits will be lost.')) return;
  requestVersion += 1;
  busy = false;
  activeRequest?.abort();
  hideProgress();
  setUploadExpanded(true);
  sourceInput.value = '';
  loadedFiles = [];
  rowFilter.value = '';
  filterText = '';
  pageCount.textContent = '0';
  statusBadge.textContent = 'Waiting for PDF';
  renderFileList();
  setRows([]);
  refreshUploadSummary();
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
sourceInput.addEventListener('change', () => {
  const picked = Array.from(sourceInput.files);
  sourceInput.value = '';    // so choosing the same file again still fires `change`
  processFiles(picked);
});
generateButton.addEventListener('click', downloadWorkbook);
resetButton.addEventListener('click', clearFiles);
