const sourceInput = document.getElementById('sourceInput');
const dropZone = document.getElementById('dropZone');
const fileList = document.getElementById('fileList');
const generateButton = document.getElementById('generateButton');
const resetButton = document.getElementById('resetButton');
const statusBadge = document.getElementById('statusBadge');
const notice = document.getElementById('notice');
const confirmDialog = document.getElementById('confirmDialog');
const confirmEyebrow = document.getElementById('confirmEyebrow');
const confirmTitle = document.getElementById('confirmTitle');
const confirmMessage = document.getElementById('confirmMessage');
const confirmCancel = document.getElementById('confirmCancel');
const confirmAction = document.getElementById('confirmAction');
const pageCount = document.getElementById('pageCount');
const rowCount = document.getElementById('rowCount');
const previewRows = document.getElementById('previewRows');
const uploadToggle = document.getElementById('uploadToggle');
const uploadBody = document.getElementById('uploadBody');
const uploadSummary = document.getElementById('uploadSummary');
const themeToggle = document.getElementById('themeToggle');
const undoButton = document.getElementById('undoButton');
const redoButton = document.getElementById('redoButton');
const exportCheckDialog = document.getElementById('exportCheckDialog');
const exportCheckSummary = document.getElementById('exportCheckSummary');
const exportIssues = document.getElementById('exportIssues');
const linkDialog = document.getElementById('linkDialog');
const linkForm = document.getElementById('linkForm');
const linkUrl = document.getElementById('linkUrl');
const linkError = document.getElementById('linkError');
const restoreLink = document.getElementById('restoreLink');
let editingLinkId = null;

const syncThemeToggle = () => {
  const isDark = document.documentElement.dataset.theme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  themeToggle.setAttribute('aria-label', themeToggle.title);
};

syncThemeToggle();
let themeTransitionRunning = false;
themeToggle.addEventListener('click', async () => {
  if (themeTransitionRunning) return;
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('ikm-theme', theme);
    } catch {}
    syncThemeToggle();
  };
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyTheme();
    return;
  }
  themeTransitionRunning = true;
  document.documentElement.classList.add('theme-crossfading');
  try {
    // Crossfade snapshots so gradients and table surfaces change together.
    await document.startViewTransition(applyTheme).finished;
  } catch (error) {
    console.error('Theme transition failed.', error);
    applyTheme();
  } finally {
    document.documentElement.classList.remove('theme-crossfading');
    themeTransitionRunning = false;
  }
});

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
const progressTrack = document.getElementById('progressTrack');


let requestVersion = 0;
let rows = [];
let nextRowId = 1;
let draggedRowId = null;
let activeRequest = null;
let progressTimer = null;
let confirmResolver = null;
let loadedFiles = [];     // every source file read so far: { name, format, pages, rows, error }
let busy = false;          // a file batch is being uploaded / read
let filterText = '';
const undoStack = [];
const redoStack = [];
let editingSession = null;

const historySnapshot = () => ({ rows: structuredClone(rows), activeSheet });
const updateHistoryButtons = () => {
  undoButton.disabled = busy || !undoStack.length;
  redoButton.disabled = busy || !redoStack.length;
};
const recordHistory = (snapshot = historySnapshot()) => {
  undoStack.push(snapshot);
  redoStack.length = 0;
  updateHistoryButtons();
};
const resetHistory = () => {
  undoStack.length = 0;
  redoStack.length = 0;
  editingSession = null;
  updateHistoryButtons();
};
const restoreHistory = (source, destination, label) => {
  if (busy || !source.length) return;
  destination.push(historySnapshot());
  const snapshot = source.pop();
  rows = structuredClone(snapshot.rows);
  activeSheet = snapshot.activeSheet;
  editingSession = null;
  refreshRows();
  renderFileList();
  refreshUploadSummary();
  updateHistoryButtons();
  setNotice(`${label}.`);
};
undoButton.addEventListener('click', () => restoreHistory(undoStack, redoStack, 'Undone'));
redoButton.addEventListener('click', () => restoreHistory(redoStack, undoStack, 'Redone'));
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
  if (event.target.closest('input, textarea, select') || confirmDialog.open || exportCheckDialog.open || linkDialog.open) return;
  const key = event.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  event.preventDefault();
  if (key === 'y' || event.shiftKey) redoButton.click();
  else undoButton.click();
});

const UPLOAD_SHARE = 30;
const PROCESS_CAP = 95;

const stopProgressTimer = () => {
  window.clearInterval(progressTimer);
  progressTimer = null;
};

const startProcessingProgress = (onTick = () => {}) => {
  stopProgressTimer();
  let value = UPLOAD_SHARE;
  progressTimer = window.setInterval(() => {
    value += (PROCESS_CAP - value) * 0.05;
    const nextValue = value;
    onTick(nextValue);
  }, 250);
};

const uploadFiles = (body, onUploadProgress) =>
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

const finishConfirmation = (confirmed) => {
  const resolve = confirmResolver;
  confirmResolver = null;
  if (confirmDialog.open) confirmDialog.close();
  resolve?.(confirmed);
};

const askConfirm = ({ eyebrow, title, message, confirmLabel }) => {
  if (confirmDialog.open) return Promise.resolve(false);
  confirmEyebrow.textContent = eyebrow;
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmAction.textContent = confirmLabel;
  return new Promise((resolve) => {
    confirmResolver = resolve;
    confirmDialog.showModal();
    confirmCancel.focus();
  });
};

confirmCancel.addEventListener('click', () => finishConfirmation(false));
confirmAction.addEventListener('click', () => finishConfirmation(true));
confirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  finishConfirmation(false);
});

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const summarizeFileError = (message) => {
  const text = String(message || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Could not read this file.';
  if (/FileDataError|FzErrorFormat|Failed to open file/i.test(text)) return 'Invalid or unreadable source file';
  return text.length > 96 ? `${text.slice(0, 93)}…` : text;
};

const sourceFormat = () => 'PDF';

const renderFileList = () => {
  fileList.replaceChildren();
  const isEmpty = !loadedFiles.length;
  fileList.classList.toggle('is-empty', isEmpty);
  if (isEmpty) {
    // Same icon as the one in index.html: a centred document outline instead of the text "No files selected".
    const empty = document.createElement('span');
    empty.className = 'empty-files';
    empty.setAttribute('role', 'img');
    empty.setAttribute('aria-label', 'No files selected');
    empty.title = 'No files selected';
    empty.innerHTML =
      '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>';
    fileList.append(empty);
    return;
  }

  const addItem = (file, index) => {
    const item = document.createElement('div');
    item.className = `file-item file-item--${file.status || 'success'}`;
    item.dataset.state = file.status || 'success';
    item.dataset.fileIndex = String(index);
    item.setAttribute('aria-busy', String(file.status === 'reading'));
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const details = document.createElement('span');
    details.className = 'file-count';
    if (file.status === 'pending') {
      details.textContent = 'Waiting';
    } else if (file.status === 'reading') {
      details.textContent = `Reading ${file.format || sourceFormat(file.name)}…`;
    } else if (file.status === 'failed') {
      details.textContent = `Failed · ${summarizeFileError(file.error)}`;
      details.title = file.error || 'Could not read this file.';
      details.classList.add('error-text');
    } else {
      const currentRowCount = rows.filter((data) => data.sheet === file.sheet).length;
      const sourceCount = document.createElement('span');
      sourceCount.textContent = `PDF: ${plural(file.rows || 0, 'link')} · ${plural(file.pages || 0, 'page')}`;
      const tableCount = document.createElement('span');
      tableCount.textContent = `Table: ${plural(currentRowCount, 'row')}`;
      details.append(sourceCount, tableCount);
    }
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'file-remove';
    removeButton.dataset.fileIndex = String(index);
    removeButton.disabled = busy;
    removeButton.title = busy ? 'Remove after processing completes' : 'Remove this file';
    removeButton.setAttribute('aria-label', `Remove ${file.name} and its rows`);
    removeButton.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3" /></svg>';
    item.append(name, details, removeButton);

    if (file.status === 'reading') {
      const overlay = document.createElement('div');
      overlay.className = 'file-loading-overlay';
      overlay.setAttribute('role', 'progressbar');
      overlay.setAttribute('aria-label', `Reading ${file.name}`);
      overlay.setAttribute('aria-valuemin', '0');
      overlay.setAttribute('aria-valuemax', '100');
      overlay.setAttribute('aria-valuenow', String(Math.round(file.progress || 0)));
      const heading = document.createElement('span');
      heading.className = 'file-loading-heading';
      const label = document.createElement('span');
      label.className = 'file-loading-label';
      label.textContent = `Reading ${file.format || sourceFormat(file.name)}`;
      const percent = document.createElement('span');
      percent.className = 'file-loading-percent';
      percent.textContent = `${Math.round(file.progress || 0)}%`;
      heading.append(label, percent);
      const track = document.createElement('span');
      track.className = 'file-loading-track';
      for (let segmentIndex = 0; segmentIndex < 7; segmentIndex += 1) {
        const segment = document.createElement('span');
        segment.className = 'file-loading-segment';
        const fill = document.createElement('span');
        fill.className = 'file-loading-segment-fill';
        fill.style.width = `${Math.min(100, Math.max(0, (file.progress || 0) * 7 - segmentIndex * 100))}%`;
        segment.append(fill);
        track.append(segment);
      }
      overlay.append(heading, track);
      item.append(overlay);
    }

    fileList.append(item);
  };

  loadedFiles.forEach(addItem);
};

const updateFileLoadingProgress = (file, value) => {
  file.progress = Math.max(file.progress || 0, Math.max(0, Math.min(100, value)));
  const fileIndex = loadedFiles.indexOf(file);
  const card = fileList.querySelector(`.file-item[data-file-index="${fileIndex}"]`);
  if (!card) return;
  const percent = Math.round(file.progress);
  const overlay = card.querySelector('.file-loading-overlay');
  overlay?.setAttribute('aria-valuenow', String(percent));
  const label = card.querySelector('.file-loading-percent');
  if (label) label.textContent = `${percent}%`;
  card.querySelectorAll('.file-loading-segment-fill').forEach((fill, index) => {
    fill.style.width = `${Math.min(100, Math.max(0, file.progress * 7 - index * 100))}%`;
  });
};

const completeFileLoadingProgress = (file, version) =>
  new Promise((resolve) => {
    const startingProgress = file.progress || 0;
    const startedAt = performance.now();
    const duration = 300;
    const animate = (now) => {
      if (version !== requestVersion) {
        resolve();
        return;
      }
      const fraction = Math.min(1, (now - startedAt) / duration);
      updateFileLoadingProgress(file, startingProgress + (100 - startingProgress) * fraction);
      if (fraction < 1) requestAnimationFrame(animate);
      else resolve();
    };
    requestAnimationFrame(animate);
  });

const refreshUploadSummary = () => {
  if (!loadedFiles.length) {
    uploadSummary.textContent = 'No files selected';
    return;
  }
  const pages = loadedFiles.reduce((sum, file) => sum + (file.pages || 0), 0);
  const pageSummary = pages ? ` · ${plural(pages, 'page')}` : '';
  uploadSummary.textContent = `${plural(loadedFiles.length, 'file')}${pageSummary} · ${plural(rows.length, 'link')}`;
  pageCount.textContent = String(pages);
};

const removeLoadedFile = async (file) => {
  if (busy) return;
  const removedRows = file.sheet ? rows.filter((data) => data.sheet === file.sheet) : [];
  if (
    removedRows.length &&
    !(await askConfirm({
      eyebrow: 'Remove file',
      title: 'Remove this file?',
      message: `“${file.name}” has ${plural(removedRows.length, 'row')}. Removing it will also discard those rows and their edits.`,
      confirmLabel: 'Remove file',
    }))
  ) {
    return;
  }

  resetHistory();
  loadedFiles = loadedFiles.filter((loadedFile) => loadedFile !== file);
  if (file.sheet) rows = rows.filter((data) => data.sheet !== file.sheet);
  if (activeSheet === file.sheet) activeSheet = rows[0]?.sheet ?? '';

  if (!loadedFiles.length) {
    rowFilter.value = '';
    filterText = '';
    pageCount.textContent = '0';
    stopProgressTimer();
    setUploadExpanded(true);
    statusBadge.textContent = 'Waiting for files';
  } else {
    statusBadge.textContent = rows.length ? 'Ready to export' : 'No rows';
  }

  renderFileList();
  refreshRows();
  refreshUploadSummary();
  const removedSummary = removedRows.length ? ` and its ${plural(removedRows.length, 'row')}` : '';
  setNotice(
    loadedFiles.length
      ? `Removed ${file.name}${removedSummary}. ${plural(loadedFiles.length, 'file')} ${loadedFiles.length === 1 ? 'remains' : 'remain'}.`
      : `Removed ${file.name}${removedSummary}. No files remain.`,
  );
};

fileList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-file-index]');
  if (!button || button.disabled) return;
  const file = loadedFiles[Number(button.dataset.fileIndex)];
  if (file) void removeLoadedFile(file);
});

const ROW_ACTIONS = [
  { action: 'delete', label: '✕', title: 'Delete row' },
];

const createRow = (values = {}) => ({
  id: nextRowId++,
  header: '',
  subHeader: '',
  sheet: '',
  detail: '',
  url: '',
  originalUrl: values.custom ? null : (values.url ?? ''),
  page: 0,
  custom: false,
  headerMode: 'auto',
  subHeaderMode: 'auto',
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

const openLinkEditor = (row) => {
  editingLinkId = row.id;
  linkUrl.value = row.url;
  linkError.textContent = '';
  linkUrl.removeAttribute('aria-invalid');
  document.getElementById('linkContext').textContent = `${row.sheet || '(no name)'} · ${row.detail}`;
  restoreLink.hidden = row.originalUrl === null;
  restoreLink.title = row.originalUrl ?? '';
  linkDialog.showModal();
  linkUrl.focus();
  linkUrl.select();
};

restoreLink.addEventListener('click', () => {
  const row = rows.find((item) => item.id === editingLinkId);
  linkUrl.value = row.originalUrl;
  linkError.textContent = '';
  linkUrl.removeAttribute('aria-invalid');
  linkUrl.focus();
});
document.getElementById('cancelLink').addEventListener('click', () => linkDialog.close());
linkDialog.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    linkDialog.close();
  }
});
linkDialog.addEventListener('close', () => {
  previewRows.querySelector(`[data-row-id="${editingLinkId}"] [data-action="edit-link"]`)?.focus();
  editingLinkId = null;
});
linkUrl.addEventListener('input', () => {
  linkError.textContent = '';
  linkUrl.removeAttribute('aria-invalid');
});
linkForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const row = rows.find((item) => item.id === editingLinkId);
  const value = linkUrl.value.trim();
  // Original PDF destinations may use schemes other than HTTP; restoration must preserve them.
  const original = row.originalUrl !== null && linkUrl.value === row.originalUrl;
  if (!original && !isHttpUrl(value)) {
    linkError.textContent = 'Enter a valid full URL starting with http:// or https://.';
    linkUrl.setAttribute('aria-invalid', 'true');
    linkUrl.focus();
    return;
  }
  const nextUrl = original ? row.originalUrl : value;
  if (nextUrl !== row.url) {
    recordHistory();
    row.url = nextUrl;
    refreshRows();
    setNotice('Link updated. You can undo this change.');
  }
  linkDialog.close();
});

const linkCell = (row) => {
  const cell = document.createElement('td');
  const controls = document.createElement('div');
  controls.className = 'link-controls';
  if (row.url) {
    const anchor = document.createElement('a');
    anchor.textContent = 'เปิดลิงก์ ↗';
    anchor.title = row.url;
    anchor.href = row.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    controls.append(anchor);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'row-button link-edit-button';
  button.dataset.action = 'edit-link';
  button.title = row.url ? 'Edit URL' : 'Add URL';
  button.setAttribute('aria-label', button.title);
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5"/></svg>';
  controls.append(button);
  cell.append(controls);
  return cell;
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

const highlightFilterMatches = () => {
  if (!CSS.highlights) return;
  CSS.highlights.delete('filter-match');
  if (!filterText) return;
  const highlight = new Highlight();
  const pattern = new RegExp(filterText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  previewRows.querySelectorAll('tr[data-row-id]').forEach((row) => {
    // Use ranges rather than markup so editing, copying and stored values stay unchanged.
    [...row.cells].slice(2, 6).forEach((cell) => {
      const walker = document.createTreeWalker(cell.querySelector('.heading-text') || cell, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let text = '';
      while (walker.nextNode()) {
        const node = walker.currentNode;
        nodes.push({ node, start: text.length, end: text.length + node.length });
        text += node.textContent;
      }
      for (const match of text.matchAll(pattern)) {
        const start = nodes.find((part) => part.end > match.index);
        const endOffset = match.index + match[0].length;
        const end = nodes.find((part) => part.end >= endOffset);
        const range = document.createRange();
        range.setStart(start.node, match.index - start.start);
        range.setEnd(end.node, endOffset - end.start);
        highlight.add(range);
      }
    });
  });
  CSS.highlights.set('filter-match', highlight);
};

previewRows.addEventListener('input', highlightFilterMatches);

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

const editableCell = (row, key, title, tag = 'td') => {
  const cell = document.createElement(tag);
  cell.textContent = row[key];
  cell.contentEditable = 'true';
  cell.spellcheck = false;
  cell.className = 'editable-cell';
  cell.title = title;
  cell.addEventListener('focus', () => {
    editingSession = { cell, snapshot: historySnapshot(), recorded: false };
  });
  cell.addEventListener('beforeinput', (event) => {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      (event.inputType === 'historyUndo' ? undoButton : redoButton).click();
    }
  });
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
    if (!editingSession || editingSession.cell !== cell) {
      editingSession = { cell, snapshot: historySnapshot(), recorded: false };
    }
    if (!editingSession.recorded) {
      recordHistory(editingSession.snapshot);
      editingSession.recorded = true;
    }
    redoStack.length = 0;
    updateHistoryButtons();
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

const headingCell = (row, key) => {
  const cell = document.createElement('td');
  cell.className = 'heading-cell';
  const mode = row[`${key}Mode`];
  const previousRow = rows.slice(0, rows.indexOf(row)).findLast((item) => item.sheet === row.sheet);
  const repeated = previousRow ? previousRow[key] === row[key] : !row[key];
  const editable = mode === 'unlocked' || (mode === 'auto' && !repeated);
  const text = editable
    ? editableCell(row, key, mode === 'auto' ? 'Edit heading for this group' : 'Edit this heading only', 'div')
    : document.createElement('div');
  text.classList.add('heading-text');
  if (!editable) {
    text.textContent = row[key] ? '~' : '';
    text.classList.add('repeat-cell');
    text.title = row[key];
    text.setAttribute('aria-label', row[key]);
  }
  if (editable && mode === 'auto') {
    let previous = row[key];
    text.addEventListener('input', () => {
      const start = rows.indexOf(row);
      for (let i = start + 1; i < rows.length && rows[i].sheet === row.sheet && rows[i][key] === previous; i += 1) {
        if (rows[i][`${key}Mode`] === 'auto') rows[i][key] = row[key];
      }
      previous = row[key];
    });
  }
  if (editable) {
    text.addEventListener('input', () => {
      rows.forEach((item) => {
        if (item === row) return;
        const target = previewRows.querySelector(`[data-row-id="${item.id}"] .heading-cell[data-key="${key}"]`);
        if (target) target.replaceWith(headingCell(item, key));
      });
    });
  }
  cell.dataset.key = key;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'heading-mode';
  toggle.dataset.action = 'heading-mode';
  toggle.dataset.key = key;
  toggle.dataset.mode = mode;
  const label = `${key === 'header' ? 'Header' : 'Sub header'}: ${mode === 'auto' ? 'Locked / Auto. Unlock this cell' : 'Unlocked. Restore Locked / Auto'}`;
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  const paths = {
    auto: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    unlocked: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M9 10V6a4 4 0 0 1 8 0M12 14v3"/>',
  };
  toggle.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[mode]}</svg>`;
  cell.append(text, toggle);
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

const insertionBoundary = (data, excelRow, below = false) => {
  const boundary = document.createElement('tr');
  boundary.className = 'insert-boundary';
  const cell = document.createElement('td');
  cell.colSpan = 7;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'insert-row-button';
  button.dataset.action = below ? 'insert-below' : 'insert-above';
  button.dataset.anchorId = String(data.id);
  const label = `Insert a new row ${below ? 'below' : 'above'} Excel row ${excelRow}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = document.createElement('span');
  icon.className = 'insert-row-icon';
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon);
  cell.append(button);
  boundary.append(cell);
  return boundary;
};

const renderPreview = () => {
  CSS.highlights?.delete('filter-match');
  previewRows.replaceChildren();
  renderSheetTabs();
  if (!rows.length) {
    filterCount.hidden = true;
    const row = document.createElement('tr');
    row.className = 'placeholder-row';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = 'No rows yet. Read a PDF file to extract its links.';
    row.append(cell);
    previewRows.append(row);
    return;
  }

  // With several source files only the selected one is listed; export still writes each one on its own sheet.
  const sheetRows = rows.filter((data) => data.sheet === activeSheet);
  const visibleRows = sheetRows.filter(matchesFilter);
  filterCount.hidden = !filterText;
  filterCount.textContent = `${visibleRows.length} of ${sheetRows.length}`;
  if (!visibleRows.length) {
    const row = document.createElement('tr');
    row.className = 'placeholder-row';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = `No rows match “${rowFilter.value.trim()}”.`;
    row.append(cell);
    previewRows.append(row);
    return;
  }
  // Numbers match the Excel row: the header row is 1, so the first data row is 2. Search never renumbers them.
  const positions = new Map(sheetRows.map((data, index) => [data.id, index + 2]));
  visibleRows.forEach((data) => {
    previewRows.append(insertionBoundary(data, positions.get(data.id)));
    const row = document.createElement('tr');
    row.dataset.rowId = String(data.id);
    const number = document.createElement('td');
    number.className = 'row-number';
    const reorder = document.createElement('td');
    reorder.className = 'reorder-cell';
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder';
    handle.draggable = true;
    reorder.append(handle);
    number.textContent = String(positions.get(data.id));
    number.title = `Row ${positions.get(data.id)} in this sheet of the Excel file (row 1 is the header)`;
    row.append(reorder, number);
    if (data.custom) {
      row.classList.add('custom-row');
      row.append(
        headingCell(data, 'header'),
        headingCell(data, 'subHeader'),
        editableCell(data, 'detail', 'Detail text'),
        linkCell(data),
      );
    } else {
      const header = headingCell(data, 'header');
      const subHeader = headingCell(data, 'subHeader');
      const link = linkCell(data);
      row.append(
        header,
        subHeader,
        editableCell(data, 'detail', 'Click to edit extracted detail text before export'),
        link,
      );
    }
    row.append(actionsCell());
    previewRows.append(row);
  });
  const lastVisible = visibleRows[visibleRows.length - 1];
  previewRows.append(insertionBoundary(lastVisible, positions.get(lastVisible.id), true));
  highlightFilterMatches();
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
  recordHistory();
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved);
  refreshRows();
};

const insertRowAt = (position, inheritFrom) => {
  recordHistory();
  const sheet = inheritFrom?.sheet ?? '';
  const previousRow = rows.slice(0, position).findLast((item) => item.sheet === sheet);
  const headingSource = previousRow ?? inheritFrom;
  const row = createRow({
    custom: true,
    header: headingSource?.header ?? '',
    subHeader: headingSource?.subHeader ?? '',
    sheet,
  });
  rows.splice(position, 0, row);
  refreshRows();
  renderFileList();
  previewRows.querySelector(`[data-row-id="${row.id}"] > td:nth-child(5)`)?.focus();
};

const deleteRow = (index) => {
  recordHistory();
  rows.splice(index, 1);
  refreshRows();
  renderFileList();
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
  if (button?.dataset.anchorId) {
    const index = rowIndexOf(button.dataset.anchorId);
    if (index >= 0) insertRowAt(index + (button.dataset.action === 'insert-below' ? 1 : 0), rows[index]);
    return;
  }
  const tr = button?.closest('tr');
  if (!tr) return;
  const index = rowIndexOf(tr.dataset.rowId);
  if (index < 0) return;
  const { action } = button.dataset;
  if (action === 'delete') deleteRow(index);
  else if (action === 'edit-link') openLinkEditor(rows[index]);
  else if (action === 'heading-mode') {
    recordHistory();
    const row = rows[index];
    const { key } = button.dataset;
    const modeKey = `${key}Mode`;
    row[modeKey] = row[modeKey] === 'auto' ? 'unlocked' : 'auto';
    renderPreview();
    previewRows.querySelector(`[data-row-id="${row.id}"] .heading-mode[data-key="${key}"]`)?.focus();
    setNotice(`${key === 'header' ? 'Header' : 'Sub header'} mode: ${row[modeKey]}. ${row[modeKey] === 'auto' ? 'Automatic grouping restored.' : 'This setting affects only this cell.'} Your edits are kept.`);
  }
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

// New source files are added to the ones already loaded; repeated names get a numbered suffix.
const processFiles = async (files) => {
  const sourceFiles = Array.from(files).filter((file) => /\.pdf$/i.test(file.name));
  const skippedFiles = files.length - sourceFiles.length;

  if (busy) {
    setNotice('Still reading the previous files. Add more when it finishes.', true);
    return;
  }

  if (!sourceFiles.length) {
    if (!loadedFiles.length) {
      stopProgressTimer();
      setUploadExpanded(true);
      uploadSummary.textContent = 'No source file selected';
      statusBadge.textContent = 'File required';
    }
    setNotice('Choose PDF files to extract their clickable links.', true);
    return;
  }

  busy = true;
  resetHistory();
  const version = ++requestVersion;
  const batchFiles = sourceFiles.map((file) => ({
    name: file.name,
    format: sourceFormat(file.name),
    pages: 0,
    rows: 0,
    sheet: '',
    progress: 0,
    status: 'pending',
    error: '',
  }));
  loadedFiles = loadedFiles.concat(batchFiles);
  generateButton.disabled = true;
  renderFileList();
  statusBadge.textContent = 'Reading files';
  setNotice('Reading source files and extracting their clickable links. Please keep this page open.');
  const fileErrors = [];
  let addedCount = 0;
  let firstAddedSheet = '';

  try {
    for (let index = 0; index < sourceFiles.length; index += 1) {
      if (version !== requestVersion) return;
      const sourceFile = sourceFiles[index];
      const fileRecord = batchFiles[index];
      const fileLabel = `${index + 1}/${sourceFiles.length}`;
      let processingProgressStarted = false;

      fileRecord.status = 'reading';
      uploadSummary.textContent = `Reading ${fileLabel}: ${sourceFile.name}`;
      statusBadge.textContent = `Reading file ${fileLabel}`;
      renderFileList();

      const body = new FormData();
      body.append('files', sourceFile, sourceFile.name);

      let response;
      try {
        response = await uploadFiles(body, (fraction) => {
          if (version !== requestVersion) return;
          if (fraction >= 1) {
            if (!processingProgressStarted) {
              processingProgressStarted = true;
              updateFileLoadingProgress(fileRecord, UPLOAD_SHARE);
              startProcessingProgress((value) => updateFileLoadingProgress(fileRecord, value));
            }
          } else if (!processingProgressStarted) {
            updateFileLoadingProgress(fileRecord, fraction * UPLOAD_SHARE);
          }
        });
      } catch (error) {
        if (version !== requestVersion) return;
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        stopProgressTimer();
        await completeFileLoadingProgress(fileRecord, version);
        if (version !== requestVersion) return;
        fileRecord.status = 'failed';
        fileRecord.error = error instanceof Error ? error.message : String(error);
        fileErrors.push({ filename: sourceFile.name, message: fileRecord.error });
        renderFileList();
        continue;
      }

      if (version !== requestVersion) return;
      stopProgressTimer();
      await completeFileLoadingProgress(fileRecord, version);
      if (version !== requestVersion) return;
      const { ok, status, result } = response;
      const fileSummary = result.files?.[0];
      const failure = !ok
        ? result.error || `Conversion failed (${status}).`
        : (result.errors || [])[0]?.message || fileSummary?.error || (!fileSummary ? 'No file result was returned.' : '');

      fileRecord.name = fileSummary?.filename || sourceFile.name;
      fileRecord.format = fileSummary?.format || fileRecord.format;
      fileRecord.pages = fileSummary?.pages || 0;
      fileRecord.rows = fileSummary?.rows || 0;

      if (failure) {
        fileRecord.status = 'failed';
        fileRecord.error = failure;
        fileErrors.push({ filename: fileRecord.name, message: failure });
      } else {
        const taken = new Set(
          [...rows.map((data) => data.sheet), ...loadedFiles.filter((file) => file !== fileRecord).map((file) => file.sheet)]
            .filter(Boolean)
            .map((sheet) => sheet.toLowerCase()),
        );
        const sheetName = uniqueSheetName(sourceFile.name.replace(/\.pdf$/i, '') || 'Source', taken);
        fileRecord.sheet = sheetName;
        fileRecord.status = 'success';
        const added = (result.rows || []).map((data) => createRow({ ...data, sheet: sheetName }));
        rows = rows.concat(added);
        addedCount += added.length;
        if (!firstAddedSheet && added.length) firstAddedSheet = sheetName;
      }

      stopProgressTimer();
      renderFileList();
    }

    if (version !== requestVersion) return;
    if (firstAddedSheet) activeSheet = firstAddedSheet;
    refreshRows();
    refreshUploadSummary();
    setUploadExpanded(false);
    stopProgressTimer();
    if (fileErrors.length) {
      statusBadge.textContent = 'Some files failed';
      setNotice(
        `${addedCount} link rows added; ${fileErrors.length} source file(s) could not be read: ${fileErrors
          .map((error) => `${error.filename}: ${summarizeFileError(error.message)}`)
          .join(' · ')}`,
        true,
      );
    } else if (skippedFiles) {
      statusBadge.textContent = 'Ready to export';
      setNotice(`${addedCount} link rows added. ${skippedFiles} unsupported file(s) were ignored.`);
    } else if (!rows.length) {
      statusBadge.textContent = 'No clickable URLs';
      setNotice(
        'No clickable web links were found. Use a browser-saved PDF; visible text alone does not contain its destination.',
        true,
      );
    } else {
      statusBadge.textContent = 'Ready to export';
      setNotice(
        `${addedCount} linked rows added from ${sourceFiles.length} file(s) (${rows.length} rows in ${loadedFiles.length} file(s) now). Navigation links were skipped.${
          loadedFiles.length > 1 ? ' Pick a file tab to view or edit it; Export Excel combines all of them into one workbook, one sheet per file.' : ''
        }`,
      );
    }
  } catch (error) {
    if (version !== requestVersion) return;
    console.error('File conversion failed:', error);
    stopProgressTimer();
    const message = error instanceof Error ? error.message : String(error);
    batchFiles.forEach((file) => {
      if (file.status === 'pending' || file.status === 'reading') {
        file.status = 'failed';
        file.error = message;
      }
    });
    setUploadExpanded(true);
    renderFileList();
    refreshUploadSummary();
    statusBadge.textContent = 'Conversion failed';
    setNotice(message, true);
  } finally {
    if (version === requestVersion) {
      busy = false;
      resetHistory();
      renderFileList();
    }
    updateSummary();
  }
};

const showExportIssues = (invalidRows) => {
  exportIssues.replaceChildren();
  exportCheckSummary.textContent = `${plural(invalidRows.length, 'row')} need a valid URL before export. Fix or delete these rows, then export again.`;
  const positions = new Map();
  const counts = new Map();
  rows.forEach((row) => {
    const position = (counts.get(row.sheet) ?? 1) + 1;
    counts.set(row.sheet, position);
    positions.set(row.id, position);
  });
  invalidRows.forEach((row) => {
    const item = document.createElement('li');
    const description = document.createElement('p');
    const reason = row.url.trim() ? 'Invalid URL — use a full http:// or https:// URL.' : 'URL is empty.';
    description.textContent = `${row.sheet || '(no name)'} · Excel row ${positions.get(row.id)} · ${reason}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button tool-button';
    button.textContent = 'Go to URL';
    button.setAttribute('aria-label', `Fix URL in ${row.sheet || '(no name)'}, Excel row ${positions.get(row.id)}`);
    button.addEventListener('click', () => {
      exportCheckDialog.close();
      activeSheet = row.sheet;
      rowFilter.value = '';
      filterText = '';
      refreshRows();
      const target = previewRows.querySelector(`[data-row-id="${row.id}"]`);
      target.classList.add('invalid');
      target.scrollIntoView({ block: 'center' });
      openLinkEditor(row);
      setNotice(`Excel row ${positions.get(row.id)}: ${reason}`, true);
    });
    item.append(description, button);
    exportIssues.append(item);
  });
  exportCheckDialog.showModal();
};

const downloadWorkbook = async () => {
  if (!rows.length) {
    statusBadge.textContent = 'No rows';
    setNotice('Add at least one row with a URL before exporting.', true);
    return;
  }

  const invalidRows = rows.filter((data) =>
    (data.custom || data.url !== data.originalUrl) && !isHttpUrl(data.url.trim()));
  if (invalidRows.length) {
    statusBadge.textContent = 'Check rows';
    setNotice(`${plural(invalidRows.length, 'row')} need valid URLs before export.`, true);
    showExportIssues(invalidRows);
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

const clearFiles = async () => {
  if (
    rows.length &&
    !(await askConfirm({
      eyebrow: 'Clear workspace',
      title: 'Clear all files?',
      message: 'All loaded files, preview rows, and edits will be removed.',
      confirmLabel: 'Clear all',
    }))
  ) {
    return;
  }
  requestVersion += 1;
  busy = false;
  activeRequest?.abort();
  stopProgressTimer();
  setUploadExpanded(true);
  sourceInput.value = '';
  loadedFiles = [];
  rowFilter.value = '';
  filterText = '';
  pageCount.textContent = '0';
  statusBadge.textContent = 'Waiting for files';
  renderFileList();
  setRows([]);
  resetHistory();
  refreshUploadSummary();
  setNotice('Only rows with an actual clickable link are included. Visible text alone is not a URL.');
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
