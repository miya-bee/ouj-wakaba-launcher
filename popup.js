const messageArea = document.getElementById('messageArea');
const systemLinksContainer = document.getElementById('systemLinks');
const subjectsContainer = document.getElementById('subjectsContainer');
const addCurrentButton = document.getElementById('addCurrentButton');
const openOptionsButton = document.getElementById('openOptionsButton');
const template = document.getElementById('subjectItemTemplate');

let popupData = null;

init().catch((error) => {
  console.error(error);
  showMessage(error.message || String(error), true);
});

async function init() {
  popupData = await sendMessage({ type: 'GET_POPUP_DATA' });
  render();

  addCurrentButton.addEventListener('click', handleAddCurrent);
  openOptionsButton.addEventListener('click', async () => {
    try {
      await sendMessage({ type: 'OPEN_OPTIONS_PAGE' });
      window.close();
    } catch (error) {
      showMessage(error.message || String(error), true);
    }
  });
}

function render() {
  renderSystemLinks();
  renderSubjects();
}

function renderSystemLinks() {
  systemLinksContainer.textContent = '';

  for (const link of popupData.systemLinks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'system-link';
    button.textContent = link.label;
    button.addEventListener('click', async () => {
      await launch(link.url, link.label, 'system');
    });
    systemLinksContainer.appendChild(button);
  }
}

function renderSubjects() {
  subjectsContainer.textContent = '';

  const subjects = Array.isArray(popupData.subjects) ? popupData.subjects : [];
  const subjectHistoryItems = Array.isArray(popupData.subjectHistoryItems) ? popupData.subjectHistoryItems : [];
  const episodeHistoryItems = Array.isArray(popupData.episodeHistoryItems) ? popupData.episodeHistoryItems : [];

  appendGroup('個別履歴', episodeHistoryItems, 'group-episode-history');
  appendGroup('科目履歴', subjectHistoryItems, 'group-subject-history');
  appendGroup('登録科目', subjects, 'group-registered-subjects');
}

function appendGroup(title, items, extraClass = '') {
  const group = document.createElement('section');
  group.className = `group-panel ${extraClass}`.trim();

  const heading = document.createElement('h3');
  heading.className = 'group-title';
  heading.textContent = title;
  group.appendChild(heading);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-text';
    empty.textContent = 'まだありません';
    group.appendChild(empty);
    subjectsContainer.appendChild(group);
    return;
  }

  const list = document.createElement('div');
  list.className = 'subject-list';

  for (const item of items) {
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector('.subject-item');
    const openButton = fragment.querySelector('.subject-open');

    openButton.textContent = item.name;
    openButton.title = item.url;
    openButton.addEventListener('click', async () => {
      await launch(item.url, item.name, 'subject');
    });

    row.dataset.subjectId = item.id || '';
    list.appendChild(fragment);
  }

  group.appendChild(list);
  subjectsContainer.appendChild(group);
}

async function launch(url, label, type) {
  await sendMessage({
    type: 'LAUNCH_TARGET',
    payload: { url, label, type }
  });
  window.close();
}

async function handleAddCurrent() {
  try {
    const result = await sendMessage({ type: 'SAVE_CURRENT_TAB_AS_SUBJECT' });
    popupData = await sendMessage({ type: 'GET_POPUP_DATA' });
    render();

    if (result.duplicated) {
      showMessage(`すでに登録済みです: ${result.subject?.name || ''}`);
    } else {
      showMessage(`登録しました: ${result.subject?.name || ''}`);
    }
  } catch (error) {
    showMessage(error.message || String(error), true);
  }
}

function showMessage(text, isError = false) {
  messageArea.textContent = text;
  messageArea.classList.remove('hidden', 'is-error');
  if (isError) {
    messageArea.classList.add('is-error');
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
