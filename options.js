const statusArea = document.getElementById('statusArea');
const saveAllButton = document.getElementById('saveAllButton');
const exportButton = document.getElementById('exportButton');
const importInput = document.getElementById('importInput');
const clearFormButton = document.getElementById('clearFormButton');
const clearCredentialsButton = document.getElementById('clearCredentialsButton');
const openWakabaNowButton = document.getElementById('openWakabaNowButton');
const showPassword = document.getElementById('showPassword');
const subjectForm = document.getElementById('subjectForm');
const subjectsTableBody = document.getElementById('subjectsTableBody');
const subjectRowTemplate = document.getElementById('subjectRowTemplate');

const routeInputs = {
  wakabaHomeUrl: document.getElementById('wakabaHomeUrl'),
  deliveryHomeUrl: document.getElementById('deliveryHomeUrl'),
  newsUrl: document.getElementById('newsUrl')
};

const settingsInputs = {
  openMode: document.getElementById('openMode'),
  subjectRecentCount: document.getElementById('subjectRecentCount'),
  episodeRecentCount: document.getElementById('episodeRecentCount'),
  titleCleanup: document.getElementById('titleCleanup')
};

const credentialInputs = {
  username: document.getElementById('credentialUsername'),
  password: document.getElementById('credentialPassword')
};

const subjectInputs = {
  id: document.getElementById('subjectId'),
  name: document.getElementById('subjectName'),
  url: document.getElementById('subjectUrl')
};

let state = null;
let subjectFormManuallyCleared = false;

init().catch((error) => {
  console.error(error);
  showStatus(error.message || String(error), true);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const watchedKeys = ['subjects', 'routes', 'settings', 'wakabaCredentials'];
  if (!watchedKeys.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) return;
  refreshStateFromStorage({ preserveForm: true }).catch((error) => {
    console.error(error);
  });
});

window.addEventListener('focus', () => {
  refreshStateFromStorage({ preserveForm: true }).catch((error) => {
    console.error(error);
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshStateFromStorage({ preserveForm: true }).catch((error) => {
    console.error(error);
  });
});

async function init() {
  state = await sendMessage({ type: 'GET_OPTIONS_DATA' });
  fillFormFromState();
  renderTable();
  await prefillSubjectFormFromActiveTab();

  saveAllButton.addEventListener('click', handleSaveAll);
  exportButton.addEventListener('click', () =>
    handleExport().catch(err => showStatus(err.message || String(err), true))
  );
  importInput.addEventListener('change', handleImport);
  clearFormButton.addEventListener('click', clearSubjectForm);
  clearCredentialsButton.addEventListener('click', handleClearCredentials);
  openWakabaNowButton.addEventListener('click', handleOpenWakabaNow);
  showPassword.addEventListener('change', () => {
    credentialInputs.password.type = showPassword.checked ? 'text' : 'password';
  });
  subjectForm.addEventListener('submit', handleSaveSubject);
  subjectInputs.name.addEventListener('input', () => { if (subjectInputs.name.value || subjectInputs.url.value) subjectFormManuallyCleared = false; });
  subjectInputs.url.addEventListener('input', () => { if (subjectInputs.name.value || subjectInputs.url.value) subjectFormManuallyCleared = false; });
}



async function refreshStateFromStorage(options = {}) {
  const nextState = await sendMessage({ type: 'GET_OPTIONS_DATA' });
  const preserveForm = Boolean(options.preserveForm);
  const draft = preserveForm ? {
    id: subjectInputs.id.value,
    name: subjectInputs.name.value,
    url: subjectInputs.url.value,
    activeElementId: document.activeElement?.id || ''
  } : null;

  state = nextState;
  fillFormFromState();
  renderTable();

  if (preserveForm && subjectFormManuallyCleared) {
    subjectInputs.id.value = '';
    subjectInputs.name.value = '';
    subjectInputs.url.value = '';
    return;
  }

  if (preserveForm && draft && (draft.id || draft.name || draft.url)) {
    subjectInputs.id.value = draft.id;
    subjectInputs.name.value = draft.name;
    subjectInputs.url.value = draft.url;

    const activeInput = draft.activeElementId ? document.getElementById(draft.activeElementId) : null;
    if (activeInput && typeof activeInput.focus === 'function') {
      activeInput.focus();
    }
  }
}

function fillFormFromState() {
  for (const [key, input] of Object.entries(routeInputs)) {
    input.value = state.routes[key] || '';
  }

  settingsInputs.openMode.value = state.settings.openMode || 'reuseTab';
  const subjectCount = Number(state.settings.subjectRecentCount ?? state.settings.recentCount ?? 3);
  const episodeCount = Number(state.settings.episodeRecentCount ?? state.settings.recentCount ?? 3);
  settingsInputs.subjectRecentCount.value = subjectCount;
  settingsInputs.episodeRecentCount.value = episodeCount;
  settingsInputs.titleCleanup.checked = Boolean(state.settings.titleCleanup);

  credentialInputs.username.value = state.credentials?.username || '';
  credentialInputs.password.value = state.credentials?.password || '';
  showPassword.checked = false;
  credentialInputs.password.type = 'password';
}

async function prefillSubjectFormFromActiveTab() {
  if (subjectFormManuallyCleared || subjectInputs.id.value || subjectInputs.name.value || subjectInputs.url.value) {
    return;
  }

  try {
    const result = await sendMessage({ type: 'GET_ACTIVE_TAB_PAGE_INFO' });
    const url = String(result?.url || '').trim();
    const pageInfo = result?.pageInfo || null;
    if (!url) return;

    const alreadyRegistered = Array.isArray(state?.subjects) && state.subjects.some((subject) => String(subject.url || '').trim() === url);
    if (alreadyRegistered) {
      return;
    }

    const suggestedName = String(pageInfo?.subjectName || pageInfo?.title || '').trim();
    if (suggestedName && !subjectInputs.name.value) {
      subjectInputs.name.value = suggestedName;
    }
    if (!subjectInputs.url.value) {
      subjectInputs.url.value = url;
    }
  } catch (error) {
    console.warn('[WAKABA Launcher] 科目名の初期入力に失敗しました。', error);
  }
}

function renderTable() {
  subjectsTableBody.textContent = '';

  if (!state.subjects.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'まだ科目が登録されていません。';
    row.appendChild(cell);
    subjectsTableBody.appendChild(row);
    return;
  }

  state.subjects.forEach((subject, index) => {
    const fragment = subjectRowTemplate.content.cloneNode(true);
    const row = fragment.querySelector('tr');
    row.dataset.subjectId = subject.id;
    fragment.querySelector('.order-cell').textContent = String(index + 1);
    fragment.querySelector('.name-cell').textContent = subject.name;
    fragment.querySelector('.url-cell').textContent = subject.url;
    
    for (const button of fragment.querySelectorAll('[data-action]')) {
      button.addEventListener('click', () =>
        handleRowAction(subject, button.dataset.action)
          .catch(err => showStatus(err.message || String(err), true))
      );
    }

    subjectsTableBody.appendChild(fragment);
  });
}

async function handleRowAction(subject, action) {
  if (action === 'edit') {
    subjectFormManuallyCleared = false;
    subjectInputs.id.value = subject.id;
    subjectInputs.name.value = subject.name;
    subjectInputs.url.value = subject.url;
    subjectInputs.name.focus();
    return;
  }

  if (action === 'delete') {
    if (!confirm(`削除しますか？\n${subject.name}`)) return;
    state = await sendMessage({ type: 'DELETE_SUBJECT', subjectId: subject.id });
    fillFormFromState();
    clearSubjectForm();
    renderTable();
    showStatus(`削除しました: ${subject.name}`);
    return;
  }

  if (action === 'up' || action === 'down') {
    state = await sendMessage({
      type: 'MOVE_SUBJECT',
      subjectId: subject.id,
      direction: action
    });
    fillFormFromState();
    renderTable();
  }
}

async function handleSaveSubject(event) {
  event.preventDefault();

  subjectFormManuallyCleared = false;
  const currentSubjects = [...state.subjects];
  const draft = {
    id: subjectInputs.id.value || null,
    name: subjectInputs.name.value.trim(),
    url: subjectInputs.url.value.trim(),
  };

  if (!draft.name || !draft.url) {
    showStatus('科目名とURLは必須です。', true);
    return;
  }

  if (draft.id) {
    const index = currentSubjects.findIndex((subject) => subject.id === draft.id);
    if (index >= 0) {
      currentSubjects[index] = {
        ...currentSubjects[index],
        ...draft
      };
    }
  } else {
    currentSubjects.push({
      ...draft,
      id: `subj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      order: getNextOrder(currentSubjects),
      favorite: false,
      lastOpenedAt: null
    });
  }

  await saveWholeState(currentSubjects);
  clearSubjectForm();
  showStatus(`保存しました: ${draft.name}`);
}

async function handleSaveAll() {
  await saveWholeState(state.subjects);
  showStatus('設定を保存しました。');
}

async function handleClearCredentials() {
  const confirmed = confirm('保存済みのログイン情報を削除します。よろしいですか？');
  if (!confirmed) return;

  state = await sendMessage({ type: 'CLEAR_CREDENTIALS' });
  fillFormFromState();
  renderTable();
  showStatus('保存情報を削除しました。');
}

async function handleOpenWakabaNow() {
  await saveWholeState(state.subjects, { silent: true });
  await sendMessage({ type: 'OPEN_WAKABA_HOME_NOW' });
  showStatus('WAKABAトップを開きました。');
}

async function saveWholeState(subjects, options = {}) {
  const payload = {
    routes: {
      wakabaHomeUrl: routeInputs.wakabaHomeUrl.value.trim(),
      deliveryHomeUrl: routeInputs.deliveryHomeUrl.value.trim(),
      newsUrl: routeInputs.newsUrl.value.trim()
    },
    settings: {
      openMode: settingsInputs.openMode.value,
      subjectRecentCount: Math.min(20, Math.max(1, Number(settingsInputs.subjectRecentCount.value ?? 3))),
      episodeRecentCount: Math.min(20, Math.max(1, Number(settingsInputs.episodeRecentCount.value ?? 3))),
      titleCleanup: settingsInputs.titleCleanup.checked
    },
    credentials: {
      username: credentialInputs.username.value.trim(),
      password: credentialInputs.password.value
    },
    subjects
  };

  state = await sendMessage({ type: 'SAVE_OPTIONS_DATA', payload });
  fillFormFromState();
  renderTable();

  if (!options.silent) {
    showStatus('設定を保存しました。');
  }
}

async function handleExport() {
  const result = await sendMessage({ type: 'EXPORT_DATA' });
  const blob = new Blob([result.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.exportFileName || 'wakaba-launcher-backup.json';
  a.click();
  URL.revokeObjectURL(url);
  showStatus('設定をエクスポートしました。');
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    state = await sendMessage({
      type: 'IMPORT_DATA',
      payload: { json: text }
    });
    fillFormFromState();
    clearSubjectForm();
    renderTable();
    showStatus('設定をインポートしました。');
  } catch (error) {
    showStatus(error.message || String(error), true);
  } finally {
    importInput.value = '';
  }
}

function clearSubjectForm() {
  subjectFormManuallyCleared = true;
  subjectInputs.id.value = '';
  subjectInputs.name.value = '';
  subjectInputs.url.value = '';
  subjectInputs.name.focus();
}

function getNextOrder(subjects) {
  return subjects.reduce((max, subject) => Math.max(max, Number(subject.order || 0)), 0) + 10;
}

function showStatus(text, isError = false) {
  statusArea.textContent = text;
  statusArea.classList.remove('hidden', 'is-error');
  if (isError) {
    statusArea.classList.add('is-error');
  }
}

async function sendMessage(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) {
    throw new Error(response?.error || '処理に失敗しました。');
  }
  const { ok, ...rest } = response;
  return rest;
}
