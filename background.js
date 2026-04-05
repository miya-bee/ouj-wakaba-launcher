const STORAGE_KEYS = {
  routes: 'routes',
  subjects: 'subjects',
  settings: 'settings',
  pendingLaunch: 'pendingLaunch',
  wakabaCredentials: 'wakabaCredentials',
  wakabaAutoLoginRequest: 'wakabaAutoLoginRequest',
  tempHistory: 'tempHistory',
  episodeHistory: 'episodeHistory'
};

const ENTRY_URL = 'https://www.wakaba.ouj.ac.jp/portal/';
const RELATED_URL_PATTERNS = [
  'https://www.wakaba.ouj.ac.jp/*',
  'https://sso.ouj.ac.jp/*',
  'https://v.ouj.ac.jp/*'
];

const PUBLIC_SYLLABUS_URL = 'https://www.wakaba.ouj.ac.jp/kyoumu/syllabus/';
const LEGACY_TOKENIZED_SYLLABUS_URL = 'https://www.wakaba.ouj.ac.jp/kyoumu/SC02060200201/display.do?taglib.html.TOKEN=db3e476f08e9990ad3719e725d20c55d';

const DEFAULT_ROUTES = {
  wakabaHomeUrl: ENTRY_URL,
  deliveryHomeUrl: 'https://v.ouj.ac.jp/view/ouj/#/navi/home',
  gmailUrl: 'https://mail.google.com/a/campus.ouj.ac.jp',
  syllabusUrl: PUBLIC_SYLLABUS_URL
};

const DEFAULT_SETTINGS = {
  openMode: 'reuseTab',
  subjectRecentCount: 3,
  episodeRecentCount: 3,
  titleCleanup: true
};

const PENDING_LAUNCH_TTL_MS = 30 * 60 * 1000;
const AUTO_LOGIN_TTL_MS = 5 * 60 * 1000;
const MAX_TEMP_HISTORY_ITEMS = 30;
const MAX_EPISODE_HISTORY_ITEMS = 30;
const TEMP_HISTORY_STABLE_DELAY_MS = 1200;
const TEMP_HISTORY_NAME_RETRY_COUNT = 8;
const TEMP_HISTORY_NAME_RETRY_INTERVAL_MS = 800;
const TEMP_HISTORY_FOLLOW_UP_REFRESH_MS = 3000;

const pendingTempHistoryTimers = new Map();
const pendingEpisodeHistoryTimers = new Map();

function normalizeRoutes(routes) {
  const normalizedRoutes = { ...DEFAULT_ROUTES, ...(routes || {}) };
  const syllabusUrl = String(normalizedRoutes.syllabusUrl || '').trim();

  if (
    syllabusUrl === LEGACY_TOKENIZED_SYLLABUS_URL
    || (/https:\/\/www\.wakaba\.ouj\.ac\.jp\/kyoumu\/SC02060200201\/display\.do/i.test(syllabusUrl) && /(?:^|[?&;])taglib\.html\.TOKEN=/i.test(syllabusUrl))
  ) {
    normalizedRoutes.syllabusUrl = PUBLIC_SYLLABUS_URL;
  }

  return normalizedRoutes;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await clearPendingLaunch();
  await chrome.storage.local.remove(STORAGE_KEYS.wakabaAutoLoginRequest);
  await ensureDefaults();

  if (reason === 'install') {
    await chrome.runtime.openOptionsPage().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await clearPendingLaunch();
  await chrome.storage.local.remove(STORAGE_KEYS.wakabaAutoLoginRequest);
  await ensureDefaults();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error('[WAKABA Launcher] Message handler error:', error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const pending = await getPendingLaunch();
  if (!pending || pending.tabId !== details.tabId) return;

  if (isCasLoginUrl(details.url)) {
    pending.sawCasLogin = true;
    pending.lastSeenUrl = details.url;
    await chrome.storage.local.set({ [STORAGE_KEYS.pendingLaunch]: pending });
  }
});

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const currentUrl = stripHash(details.url);
  if (currentUrl) {
    await markObservedSubjectByUrl(currentUrl, details.tabId);
  }

  const pending = await getPendingLaunch();
  if (!pending || pending.tabId !== details.tabId) return;

  const targetUrl = stripHash(pending.url);

  if (!currentUrl) return;

  if (sameUrl(currentUrl, targetUrl)) {
    await markOpenedSubject(targetUrl, { tabId: details.tabId, allowTempHistory: true });
    await clearPendingLaunch();
    return;
  }

  if (pending.type === 'system' && isPortalEntryUrl(targetUrl) && isWakabaUrl(currentUrl)) {
    await clearPendingLaunch();
    return;
  }

  if (await shouldRedirectEntryFlowToTarget(details.tabId, currentUrl, pending, targetUrl)) {
    pending.redirectedAfterLogin = true;
    pending.lastSeenUrl = currentUrl;
    await chrome.storage.local.set({ [STORAGE_KEYS.pendingLaunch]: pending });
    await chrome.tabs.update(details.tabId, { url: targetUrl });
    return;
  }

  if (isCasLoginUrl(currentUrl)) {
    return;
  }

  if (!isLaunchableSubjectUrl(currentUrl) && !isWakabaUrl(currentUrl)) {
    return;
  }

  if (pending.sawCasLogin && !pending.redirectedAfterLogin) {
    pending.redirectedAfterLogin = true;
    pending.lastSeenUrl = currentUrl;
    await chrome.storage.local.set({ [STORAGE_KEYS.pendingLaunch]: pending });
    await chrome.tabs.update(details.tabId, { url: targetUrl });
    return;
  }

  pending.lastSeenUrl = currentUrl;
  await chrome.storage.local.set({ [STORAGE_KEYS.pendingLaunch]: pending });
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await markObservedSubjectByUrl(details.url, details.tabId);
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await markObservedSubjectByUrl(details.url, details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPendingTempHistoryObservation(tabId);
  clearPendingEpisodeHistoryObservation(tabId);
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'GET_POPUP_DATA':
      return await getPopupData();
    case 'LAUNCH_TARGET':
      await launchTarget(message.payload || {});
      return {};
    case 'TOGGLE_FAVORITE':
      await toggleFavorite(message.subjectId);
      return await getPopupData();
    case 'SAVE_CURRENT_TAB_AS_SUBJECT':
      return await saveCurrentTabAsSubject();
    case 'OPEN_OPTIONS_PAGE':
      await chrome.runtime.openOptionsPage();
      return {};
    case 'GET_ACTIVE_TAB_PAGE_INFO':
      return await getActiveTabPageInfo();
    case 'GET_OPTIONS_DATA':
      return await getOptionsData();
    case 'SAVE_OPTIONS_DATA':
      await saveOptionsData(message.payload || {});
      return await getOptionsData();
    case 'DELETE_SUBJECT':
      await deleteSubject(message.subjectId);
      return await getOptionsData();
    case 'MOVE_SUBJECT':
      await moveSubject(message.subjectId, message.direction);
      return await getOptionsData();
    case 'EXPORT_DATA':
      return await exportData();
    case 'IMPORT_DATA':
      await importData(message.payload || {});
      return await getOptionsData();
    case 'CLEAR_CREDENTIALS':
      await clearCredentials();
      return await getOptionsData();
    case 'OPEN_WAKABA_HOME_NOW':
      await openWakabaHomeNow();
      return {};
    case 'OBSERVED_PAGE_INFO':
      await handleObservedPageInfo(sender, message.payload || {});
      return {};
    default:
      throw new Error(`Unknown message type: ${message?.type}`);
  }
}

async function ensureDefaults() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.routes,
    STORAGE_KEYS.subjects,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.tempHistory,
    STORAGE_KEYS.episodeHistory
  ]);

  const patch = {};
  const normalizedSubjects = Array.isArray(data[STORAGE_KEYS.subjects]) ? data[STORAGE_KEYS.subjects] : [];
  const normalizedTempHistory = Array.isArray(data[STORAGE_KEYS.tempHistory]) ? data[STORAGE_KEYS.tempHistory] : [];
  const normalizedEpisodeHistory = Array.isArray(data[STORAGE_KEYS.episodeHistory]) ? data[STORAGE_KEYS.episodeHistory] : [];

  patch[STORAGE_KEYS.routes] = normalizeRoutes(data[STORAGE_KEYS.routes]);

  patch[STORAGE_KEYS.subjects] = normalizedSubjects;
  patch[STORAGE_KEYS.settings] = data[STORAGE_KEYS.settings]
    ? { ...DEFAULT_SETTINGS, ...data[STORAGE_KEYS.settings] }
    : { ...DEFAULT_SETTINGS };

  const rawSettings = data[STORAGE_KEYS.settings] || {};
  if (Object.prototype.hasOwnProperty.call(rawSettings, 'recentCount')) {
    const legacyCount = Math.min(20, Math.max(1, Number(rawSettings.recentCount || 3)));
    if (!Object.prototype.hasOwnProperty.call(rawSettings, 'subjectRecentCount')) {
      patch[STORAGE_KEYS.settings].subjectRecentCount = legacyCount;
    }
    if (!Object.prototype.hasOwnProperty.call(rawSettings, 'episodeRecentCount')) {
      patch[STORAGE_KEYS.settings].episodeRecentCount = legacyCount;
    }
    delete patch[STORAGE_KEYS.settings].recentCount;
  }

  patch[STORAGE_KEYS.settings].subjectRecentCount = Math.min(20, Math.max(1, Number(patch[STORAGE_KEYS.settings].subjectRecentCount ?? DEFAULT_SETTINGS.subjectRecentCount)));
  patch[STORAGE_KEYS.settings].episodeRecentCount = Math.min(20, Math.max(1, Number(patch[STORAGE_KEYS.settings].episodeRecentCount ?? DEFAULT_SETTINGS.episodeRecentCount)));
  patch[STORAGE_KEYS.tempHistory] = pruneTempHistoryForSubjects(normalizedTempHistory, normalizedSubjects);
  patch[STORAGE_KEYS.episodeHistory] = normalizeEpisodeHistoryEntries(normalizedEpisodeHistory);

  await chrome.storage.local.set(patch);
}

async function getPopupData() {
  const { routes, subjects, settings, wakabaCredentials, tempHistory, episodeHistory } = await chrome.storage.local.get([
    STORAGE_KEYS.routes,
    STORAGE_KEYS.subjects,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.wakabaCredentials,
    STORAGE_KEYS.tempHistory,
    STORAGE_KEYS.episodeHistory
  ]);

  const normalizedRoutes = normalizeRoutes(routes);
  const normalizedSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (Object.prototype.hasOwnProperty.call(normalizedSettings, 'recentCount')) {
    const legacyCount = Math.min(20, Math.max(1, Number(normalizedSettings.recentCount || DEFAULT_SETTINGS.subjectRecentCount)));
    normalizedSettings.subjectRecentCount = Math.min(20, Math.max(1, Number(normalizedSettings.subjectRecentCount ?? legacyCount)));
    normalizedSettings.episodeRecentCount = Math.min(20, Math.max(1, Number(normalizedSettings.episodeRecentCount ?? legacyCount)));
    delete normalizedSettings.recentCount;
  }
  normalizedSettings.subjectRecentCount = Math.min(20, Math.max(1, Number(normalizedSettings.subjectRecentCount ?? DEFAULT_SETTINGS.subjectRecentCount)));
  normalizedSettings.episodeRecentCount = Math.min(20, Math.max(1, Number(normalizedSettings.episodeRecentCount ?? DEFAULT_SETTINGS.episodeRecentCount)));
  const normalizedSubjects = sortSubjects(Array.isArray(subjects) ? subjects : []);
  const normalizedTempHistory = normalizeTempHistoryEntries(Array.isArray(tempHistory) ? tempHistory : []);
  const normalizedEpisodeHistory = normalizeEpisodeHistoryEntries(Array.isArray(episodeHistory) ? episodeHistory : []);

  return {
    routes: normalizedRoutes,
    settings: normalizedSettings,
    subjects: normalizedSubjects,
    subjectHistoryItems: buildHistoryItems(normalizedSubjects, normalizedTempHistory, normalizedSettings.subjectRecentCount),
    episodeHistoryItems: buildEpisodeHistoryItems(normalizedEpisodeHistory, normalizedSettings.episodeRecentCount),
    systemLinks: buildSystemLinks(normalizedRoutes),
    hasCredentials: Boolean(wakabaCredentials?.username && wakabaCredentials?.password)
  };
}

async function getOptionsData() {
  const popupData = await getPopupData();
  const { wakabaCredentials } = await chrome.storage.local.get(STORAGE_KEYS.wakabaCredentials);

  return {
    ...popupData,
    credentials: {
      username: wakabaCredentials?.username || '',
      password: wakabaCredentials?.password || ''
    },
    exportFileName: `wakaba-launcher-backup-${new Date().toISOString().slice(0, 10)}.json`
  };
}

function buildSystemLinks(routes) {
  const normalizedRoutes = { ...DEFAULT_ROUTES, ...(routes || {}) };
  const links = [];

  links.push({
    id: 'wakaba_home',
    label: 'WAKABAトップ',
    url: normalizeLaunchUrl(normalizedRoutes.wakabaHomeUrl) || ENTRY_URL,
    kind: 'system'
  });

  if (normalizedRoutes.deliveryHomeUrl) {
    links.push({
      id: 'delivery_home',
      label: '配信トップ',
      url: normalizedRoutes.deliveryHomeUrl,
      kind: 'system'
    });
  }

  if (normalizedRoutes.gmailUrl) {
    links.push({
      id: 'gmail',
      label: 'Gmail',
      url: normalizedRoutes.gmailUrl,
      kind: 'system'
    });
  }

  if (normalizedRoutes.syllabusUrl) {
    links.push({
      id: 'syllabus',
      label: 'シラバス',
      url: normalizedRoutes.syllabusUrl,
      kind: 'system'
    });
  }

  return links;
}

function buildHistoryItems(subjects, tempHistory, recentCount) {
  const byUrl = new Map();

  for (const subject of subjects) {
    if (!subject.lastOpenedAt) continue;
    const key = canonicalizeUrl(subject.url);
    if (!key) continue;

    byUrl.set(key, {
      id: subject.id,
      name: subject.name,
      url: key,
      lastOpenedAt: subject.lastOpenedAt,
      isTemporary: false
    });
  }

  for (const entry of tempHistory) {
    if (!entry.lastOpenedAt) continue;
    const key = canonicalizeUrl(entry.url);
    if (!key) continue;

    const existing = byUrl.get(key);
    const displayName = String(entry.name || deriveTempSubjectNameFromUrl(key)).trim();
    if (!existing) {
      if (!displayName || isWeakTempHistoryName(displayName)) {
        continue;
      }

      byUrl.set(key, {
        id: entry.id || createTempHistoryId(key),
        name: displayName,
        url: key,
        lastOpenedAt: entry.lastOpenedAt,
        isTemporary: true
      });
      continue;
    }

    if (compareIsoDate(entry.lastOpenedAt, existing.lastOpenedAt) > 0) {
      byUrl.set(key, {
        ...existing,
        lastOpenedAt: entry.lastOpenedAt
      });
    }
  }

  const mergedItems = Array.from(byUrl.values())
    .sort((a, b) => compareIsoDate(b.lastOpenedAt, a.lastOpenedAt));

  const registeredNameKeys = new Set(
    mergedItems
      .filter((item) => !item.isTemporary)
      .map((item) => createHistoryNameKey(item.name))
      .filter(Boolean)
  );
  const seenTempNameKeys = new Set();

  const dedupedItems = mergedItems.filter((item) => {
    if (!item.isTemporary) return true;

    const nameKey = createHistoryNameKey(item.name);
    if (!nameKey) return true;
    if (registeredNameKeys.has(nameKey)) return false;
    if (seenTempNameKeys.has(nameKey)) return false;

    seenTempNameKeys.add(nameKey);
    return true;
  });

  return dedupedItems
    .slice(0, Math.min(20, Math.max(1, Number(recentCount || DEFAULT_SETTINGS.recentCount))));
}

function buildEpisodeHistoryItems(episodeHistory, recentCount) {
  const items = normalizeEpisodeHistoryEntries(Array.isArray(episodeHistory) ? episodeHistory : []);
  const byName = new Map();

  for (const item of items) {
    const nameKey = createHistoryNameKey(item.name || `${item.courseName || ''} ${item.episodeLabel || ''}`);
    if (!nameKey) {
      continue;
    }
    const existing = byName.get(nameKey);
    if (!existing || compareIsoDate(item.lastOpenedAt || item.updatedAt, existing.lastOpenedAt || existing.updatedAt) > 0) {
      byName.set(nameKey, item);
    }
  }

  return Array.from(byName.values())
    .sort((a, b) => compareIsoDate(b.lastOpenedAt || b.updatedAt, a.lastOpenedAt || a.updatedAt))
    .slice(0, Math.min(20, Math.max(1, Number(recentCount || DEFAULT_SETTINGS.recentCount))));
}


function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (Object.prototype.hasOwnProperty.call(merged, 'recentCount')) {
    const legacyCount = Math.min(20, Math.max(1, Number(merged.recentCount || DEFAULT_SETTINGS.subjectRecentCount)));
    merged.subjectRecentCount = Math.min(20, Math.max(1, Number(merged.subjectRecentCount ?? legacyCount)));
    merged.episodeRecentCount = Math.min(20, Math.max(1, Number(merged.episodeRecentCount ?? legacyCount)));
    delete merged.recentCount;
  }
  merged.subjectRecentCount = Math.min(20, Math.max(1, Number(merged.subjectRecentCount ?? DEFAULT_SETTINGS.subjectRecentCount)));
  merged.episodeRecentCount = Math.min(20, Math.max(1, Number(merged.episodeRecentCount ?? DEFAULT_SETTINGS.episodeRecentCount)));
  return merged;
}

function normalizeExportSettings(settings) {
  const normalized = normalizeSettings(settings || {});
  return {
    openMode: normalized.openMode,
    subjectRecentCount: normalized.subjectRecentCount,
    episodeRecentCount: normalized.episodeRecentCount,
    titleCleanup: normalized.titleCleanup
  };
}

function createHistoryNameKey(name) {
  return String(name || '')
    .replace(/\s+/gu, '')
    .trim()
    .toLocaleLowerCase('ja');
}

async function launchTarget(payload) {
  const url = normalizeLaunchUrl(payload.url);
  if (!url) {
    throw new Error('起動先URLが空です。');
  }

  const settings = await loadSettings();
  // WAKABAトップと配信トップは、まず portal/ 入口を踏んでログイン状態を確立してから
  // 目的地へ送る。配信トップは直接URLへ飛ぶより、この順序のほうが安定しやすい。
  const useEntryFlow = isPortalEntryUrl(url) || isDeliveryHomeRouteUrl(url);

  if (isRelatedWakabaUrl(url)) {
    await prepareAutoLoginRequest();
  }

  const tab = useEntryFlow
    ? await openOrRefreshEntryFlow(settings.openMode)
    : await resolveLaunchTab(settings.openMode);

  const pendingLaunch = {
    url,
    label: payload.label || '',
    type: payload.type || 'subject',
    tabId: tab.id,
    createdAt: new Date().toISOString(),
    sawCasLogin: false,
    redirectedAfterLogin: false,
    lastSeenUrl: '',
    useEntryFlow
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.pendingLaunch]: pendingLaunch });

  if (useEntryFlow) {
    return;
  }

  await chrome.tabs.update(tab.id, { active: true, url });
}

async function openWakabaHomeNow() {
  const settings = await loadSettings();
  await prepareAutoLoginRequest();
  const tab = await openOrRefreshEntryFlow(settings.openMode);

  const pendingLaunch = {
    url: ENTRY_URL,
    label: 'WAKABAトップ',
    type: 'system',
    tabId: tab.id,
    createdAt: new Date().toISOString(),
    sawCasLogin: false,
    redirectedAfterLogin: false,
    lastSeenUrl: ''
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.pendingLaunch]: pendingLaunch });
}

async function prepareAutoLoginRequest() {
  const { wakabaCredentials } = await chrome.storage.local.get(STORAGE_KEYS.wakabaCredentials);
  if (!wakabaCredentials?.username || !wakabaCredentials?.password) {
    await chrome.storage.local.remove(STORAGE_KEYS.wakabaAutoLoginRequest);
    return false;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.wakabaAutoLoginRequest]: {
      token: String(Date.now()),
      createdAt: Date.now(),
      entryUrl: ENTRY_URL
    }
  });

  return true;
}

async function openOrRefreshEntryFlow(openMode) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (openMode === 'newTab') {
    const created = await chrome.tabs.create({
      url: ENTRY_URL,
      active: true,
      index: typeof activeTab?.index === 'number' ? activeTab.index + 1 : undefined
    });
    if (typeof created.windowId === 'number') {
      await chrome.windows.update(created.windowId, { focused: true }).catch(() => {});
    }
    return created;
  }

  if (activeTab?.id && isRelatedWakabaUrl(activeTab.url)) {
    await chrome.tabs.update(activeTab.id, { active: true, url: ENTRY_URL });
    if (typeof activeTab.windowId === 'number') {
      await chrome.windows.update(activeTab.windowId, { focused: true }).catch(() => {});
    }
    return activeTab;
  }

  const existingTabs = await chrome.tabs.query({ url: RELATED_URL_PATTERNS });
  const targetTab = existingTabs.find((tab) => isRelatedWakabaUrl(tab.url));

  if (targetTab?.id) {
    await chrome.tabs.update(targetTab.id, { active: true, url: ENTRY_URL });
    if (typeof targetTab.windowId === 'number') {
      await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
    }
    return targetTab;
  }

  const created = await chrome.tabs.create({ url: ENTRY_URL, active: true });
  if (typeof created.windowId === 'number') {
    await chrome.windows.update(created.windowId, { focused: true }).catch(() => {});
  }
  return created;
}

async function resolveLaunchTab(openMode) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (openMode === 'newTab') {
    return await chrome.tabs.create({
      url: 'about:blank',
      active: true,
      index: typeof activeTab?.index === 'number' ? activeTab.index + 1 : undefined
    });
  }

  if (activeTab?.id) {
    return activeTab;
  }

  return await chrome.tabs.create({ url: 'about:blank', active: true });
}

async function toggleFavorite(subjectId) {
  const subjects = await loadSubjects();
  const updated = subjects.map((subject) => {
    if (subject.id !== subjectId) return subject;
    return { ...subject, favorite: !subject.favorite };
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.subjects]: updated });
}

async function saveCurrentTabAsSubject() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.url) {
    throw new Error('現在のタブURLを取得できませんでした。');
  }

  if (!isRegisterableSubjectUrl(activeTab.url)) {
    throw new Error('現在のタブがWAKABA/配信配下ではありません。WAKABAまたは配信授業のページで実行してください。');
  }

  const subjects = await loadSubjects();
  const url = canonicalizeUrl(activeTab.url);
  const existing = subjects.find((subject) => sameUrl(subject.url, url));
  if (existing) {
    return {
      duplicated: true,
      subject: existing
    };
  }

  const settings = await loadSettings();
  const pageInfo = await getCurrentTabPageInfo(activeTab.id);
  const tempHistory = await loadTempHistory();
  const matchedTemp = tempHistory.find((entry) => sameUrl(entry.url, url));

  const suggestedName = makeReasonableSubjectName(
    pageInfo?.subjectName || pageInfo?.title || matchedTemp?.name || activeTab.title || deriveTempSubjectNameFromUrl(url),
    settings.titleCleanup
  );

  if (isDeliveryDomainUrl(url) && !canSaveCurrentDeliveryPage(pageInfo, matchedTemp, suggestedName)) {
    throw new Error('配信授業の科目ページを開いてから実行してください。個別回ページは登録できません。');
  }

  const subject = {
    id: createId(),
    name: suggestedName,
    url,
    favorite: false,
    order: getNextOrder(subjects),
    lastOpenedAt: matchedTemp?.lastOpenedAt || null
  };

  subjects.push(subject);
  await chrome.storage.local.set({
    [STORAGE_KEYS.subjects]: subjects,
    [STORAGE_KEYS.tempHistory]: pruneTempHistoryForSubjects(tempHistory, subjects)
  });

  return {
    duplicated: false,
    subject
  };
}

async function saveOptionsData(payload) {
  const routes = normalizeRoutes(payload.routes);

  if (!normalizeLaunchUrl(routes.wakabaHomeUrl)) {
    throw new Error('WAKABAトップURLは必須です。');
  }

  const incomingSubjects = Array.isArray(payload.subjects) ? payload.subjects : [];
  const subjects = incomingSubjects.map((subject, index) => normalizeSubject(subject, index));
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(payload.settings || {})
  };
  if (Object.prototype.hasOwnProperty.call(settings, 'recentCount')) {
    const legacyCount = Math.min(20, Math.max(1, Number(settings.recentCount || DEFAULT_SETTINGS.subjectRecentCount)));
    settings.subjectRecentCount = Math.min(20, Math.max(1, Number(settings.subjectRecentCount ?? legacyCount)));
    settings.episodeRecentCount = Math.min(20, Math.max(1, Number(settings.episodeRecentCount ?? legacyCount)));
    delete settings.recentCount;
  }
  settings.subjectRecentCount = Math.min(20, Math.max(1, Number(settings.subjectRecentCount ?? DEFAULT_SETTINGS.subjectRecentCount)));
  settings.episodeRecentCount = Math.min(20, Math.max(1, Number(settings.episodeRecentCount ?? DEFAULT_SETTINGS.episodeRecentCount)));
  const tempHistory = pruneTempHistoryForSubjects(await loadTempHistory(), subjects);

  const patch = {
    [STORAGE_KEYS.routes]: routes,
    [STORAGE_KEYS.subjects]: subjects,
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.tempHistory]: tempHistory
  };

  if (payload.credentials) {
    const username = String(payload.credentials.username || '').trim();
    const password = String(payload.credentials.password || '');

    if (username || password) {
      if (!username || !password) {
        throw new Error('自動ログイン情報を保存する場合は、ログインIDとパスワードの両方を入力してください。');
      }
      patch[STORAGE_KEYS.wakabaCredentials] = {
        username,
        password,
        updatedAt: new Date().toISOString()
      };
    }
  }

  await chrome.storage.local.set(patch);
}

async function handleObservedPageInfo(sender, payload) {
  const tabId = sender?.tab?.id;
  const senderUrl = normalizeLaunchUrl(sender?.tab?.url || payload?.href || '');
  if (!Number.isFinite(Number(tabId)) || !senderUrl || !isDeliveryDomainUrl(senderUrl)) {
    return;
  }

  const pageInfo = {
    href: normalizeLaunchUrl(payload?.href || senderUrl),
    title: String(payload?.title || '').trim(),
    subjectName: String(payload?.subjectName || '').trim(),
    subjectSource: String(payload?.subjectSource || '').trim(),
    hasStrongCourseEvidence: Boolean(payload?.hasStrongCourseEvidence),
    episodeLabel: String(payload?.episodeLabel || '').trim(),
    episodeTitle: String(payload?.episodeTitle || '').trim(),
    episodeDisplayName: String(payload?.episodeDisplayName || '').trim(),
    hasEpisodeEvidence: Boolean(payload?.hasEpisodeEvidence)
  };

  if (!sameUrl(pageInfo.href || senderUrl, senderUrl)) {
    pageInfo.href = senderUrl;
  }

  if (!shouldKeepEpisodeHistoryPageInfo(pageInfo)) {
    return;
  }

  await upsertEpisodeHistoryFromPageInfo(pageInfo.href || senderUrl, pageInfo);
}


async function clearCredentials() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.wakabaCredentials,
    STORAGE_KEYS.wakabaAutoLoginRequest
  ]);
}

async function deleteSubject(subjectId) {
  const subjects = await loadSubjects();
  const updated = subjects.filter((subject) => subject.id !== subjectId);
  await chrome.storage.local.set({ [STORAGE_KEYS.subjects]: updated });
}

async function moveSubject(subjectId, direction) {
  const subjects = sortSubjects(await loadSubjects());
  const index = subjects.findIndex((subject) => subject.id === subjectId);
  if (index < 0) return;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= subjects.length) return;

  const clone = [...subjects];
  const [item] = clone.splice(index, 1);
  clone.splice(targetIndex, 0, item);

  const reOrdered = clone.map((subject, i) => ({
    ...subject,
    order: (i + 1) * 10
  }));

  await chrome.storage.local.set({ [STORAGE_KEYS.subjects]: reOrdered });
}

async function exportData() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.routes,
    STORAGE_KEYS.subjects,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.wakabaCredentials
  ]);

  return {
    json: JSON.stringify({
      routes: normalizeRoutes(data.routes),
      settings: normalizeExportSettings(data.settings || {}),
      subjects: sortSubjects(Array.isArray(data.subjects) ? data.subjects : []),
      credentials: {
        username: data.wakabaCredentials?.username || '',
        password: data.wakabaCredentials?.password || ''
      }
    }, null, 2)
  };
}

async function importData(payload) {
  const parsed = typeof payload.json === 'string' ? JSON.parse(payload.json) : payload;
  await saveOptionsData(parsed);
}

async function loadSubjects() {
  const { subjects } = await chrome.storage.local.get(STORAGE_KEYS.subjects);
  return Array.isArray(subjects) ? subjects : [];
}

async function loadTempHistory() {
  const { tempHistory } = await chrome.storage.local.get(STORAGE_KEYS.tempHistory);
  return normalizeTempHistoryEntries(Array.isArray(tempHistory) ? tempHistory : []);
}

async function loadEpisodeHistory() {
  const { episodeHistory } = await chrome.storage.local.get(STORAGE_KEYS.episodeHistory);
  return normalizeEpisodeHistoryEntries(Array.isArray(episodeHistory) ? episodeHistory : []);
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return normalizeSettings(settings || {});
}

async function getPortalLoginState(tabId) {
  if (!Number.isFinite(Number(tabId))) {
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PORTAL_LOGIN_STATE' });
    if (!response?.ok) {
      return null;
    }

    return {
      isPortalPage: Boolean(response.isPortalPage),
      hasLoginForm: Boolean(response.hasLoginForm)
    };
  } catch {
    return null;
  }
}

async function shouldRedirectEntryFlowToTarget(tabId, currentUrl, pending, targetUrl) {
  if (!pending?.useEntryFlow || pending.redirectedAfterLogin) {
    return false;
  }

  if (isCasLoginUrl(currentUrl)) {
    return false;
  }

  if (isPortalEntryUrl(currentUrl)) {
    const portalState = await getPortalLoginState(tabId);
    if (portalState?.isPortalPage && portalState.hasLoginForm) {
      return false;
    }
    return true;
  }

  if (isWakabaUrl(currentUrl)) {
    return true;
  }

  return false;
}

async function getCurrentTabPageInfo(tabId) {
  if (!Number.isFinite(Number(tabId))) {
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_CURRENT_PAGE_INFO' });
    if (!response?.ok) {
      return null;
    }

    return {
      title: String(response.title || '').trim(),
      subjectName: String(response.subjectName || '').trim(),
      subjectSource: String(response.subjectSource || '').trim(),
      hasStrongCourseEvidence: Boolean(response.hasStrongCourseEvidence),
      href: String(response.href || '').trim(),
      episodeLabel: String(response.episodeLabel || '').trim(),
      episodeTitle: String(response.episodeTitle || '').trim(),
      episodeDisplayName: String(response.episodeDisplayName || '').trim(),
      hasEpisodeEvidence: Boolean(response.hasEpisodeEvidence),
      episodeInteractionActive: Boolean(response.episodeInteractionActive)
    };
  } catch {
    return null;
  }
}

async function getActiveTabPageInfo() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !activeTab?.url) {
    return { pageInfo: null, url: '' };
  }

  const pageInfo = await getCurrentTabPageInfo(activeTab.id);
  return {
    url: normalizeLaunchUrl(activeTab.url),
    pageInfo
  };
}

async function getPendingLaunch() {
  const { pendingLaunch } = await chrome.storage.local.get(STORAGE_KEYS.pendingLaunch);
  if (!pendingLaunch) return null;

  if (!pendingLaunch.url || !Number.isFinite(Number(pendingLaunch.tabId))) {
    await clearPendingLaunch();
    return null;
  }

  if (isPendingLaunchExpired(pendingLaunch)) {
    await clearPendingLaunch();
    return null;
  }

  return pendingLaunch;
}

function isPendingLaunchExpired(pendingLaunch) {
  const createdAt = Date.parse(String(pendingLaunch?.createdAt || ''));
  if (!Number.isFinite(createdAt)) {
    return true;
  }

  return Date.now() - createdAt > PENDING_LAUNCH_TTL_MS;
}

async function clearPendingLaunch() {
  await chrome.storage.local.remove(STORAGE_KEYS.pendingLaunch);
}

async function markObservedSubjectByUrl(url, tabId) {
  const currentUrl = normalizeLaunchUrl(url);
  if (!currentUrl || !isLaunchableSubjectUrl(currentUrl)) {
    clearPendingTempHistoryObservation(tabId);
    clearPendingEpisodeHistoryObservation(tabId);
    return;
  }

  clearPendingEpisodeHistoryObservation(tabId);

  const matched = await markOpenedSubject(currentUrl, { tabId, allowTempHistory: false, allowEpisodeHistory: false });
  if (matched) {
    clearPendingTempHistoryObservation(tabId);
    return;
  }

  if (shouldCollectTempHistoryForUrl(currentUrl)) {
    scheduleTempHistoryObservation(currentUrl, tabId);
    return;
  }

  clearPendingTempHistoryObservation(tabId);
}

async function markOpenedSubject(targetUrl, options = {}) {
  const subjects = await loadSubjects();
  const currentIso = new Date().toISOString();
  let changed = false;
  const updated = subjects.map((subject) => {
    if (!sameUrl(subject.url, targetUrl)) return subject;
    changed = true;
    return {
      ...subject,
      lastOpenedAt: currentIso
    };
  });

  if (changed) {
    const tempHistory = pruneTempHistoryForSubjects(await loadTempHistory(), updated);
    await chrome.storage.local.set({
      [STORAGE_KEYS.subjects]: updated,
      [STORAGE_KEYS.tempHistory]: tempHistory
    });
    clearPendingEpisodeHistoryObservation(options.tabId);
    return true;
  }

  if (options.allowTempHistory && shouldCollectTempHistoryForUrl(targetUrl)) {
    scheduleTempHistoryObservation(targetUrl, options.tabId, currentIso);
  }
    return false;
}

function scheduleTempHistoryObservation(url, tabId, openedAtIso) {
  const currentUrl = canonicalizeUrl(url);
  if (!shouldCollectTempHistoryForUrl(currentUrl)) {
    clearPendingTempHistoryObservation(tabId);
    return;
  }

  if (!Number.isFinite(Number(tabId))) {
    upsertTempHistoryEntry(currentUrl, tabId, openedAtIso).catch((error) => {
      console.warn('[WAKABA Launcher] 仮履歴の更新に失敗しました。', error);
    });
    return;
  }

  const key = String(tabId);
  clearPendingTempHistoryObservation(tabId);

  const timerId = setTimeout(async () => {
    pendingTempHistoryTimers.delete(key);

    try {
      const tab = await chrome.tabs.get(tabId);
      const latestUrl = normalizeLaunchUrl(tab?.url || '');
      if (!latestUrl || !sameUrl(latestUrl, currentUrl)) {
        return;
      }

      if (!shouldCollectTempHistoryForUrl(latestUrl)) {
        return;
      }

      await upsertTempHistoryEntry(latestUrl, tabId, openedAtIso);
    } catch (error) {
      console.warn('[WAKABA Launcher] 仮履歴の安定待ち中にタブを確認できませんでした。', error);
    }
  }, TEMP_HISTORY_STABLE_DELAY_MS);

  pendingTempHistoryTimers.set(key, {
    timerId,
    url: currentUrl
  });
}

function clearPendingTempHistoryObservation(tabId) {
  const key = String(tabId);
  const pending = pendingTempHistoryTimers.get(key);
  if (!pending) return;

  clearTimeout(pending.timerId);
  pendingTempHistoryTimers.delete(key);
}

function shouldKeepTempHistoryPageInfo(pageInfo, candidateName) {
  const name = String(candidateName || '').trim();
  if (!name || isWeakTempHistoryName(name) || isFallbackTempHistoryName(name)) {
    return false;
  }

  const isDirectoryLike = /(?:コース|学部|研究科|専攻|プログラム|資格取得に資する科目|基盤科目|外国語科目)$/u.test(name);
  if (isDirectoryLike) {
    return false;
  }

  if (pageInfo?.href && isDeliveryDomainUrl(pageInfo.href)) {
    if (!pageInfo?.hasStrongCourseEvidence) {
      return false;
    }

    const source = String(pageInfo?.subjectSource || '').trim();
    return /preferred-breadcrumb-rightmost-3digit|preferred-detail-three-digit-label/u.test(source);
  }

  if (pageInfo?.hasStrongCourseEvidence) {
    return true;
  }

  return true;
}

async function upsertTempHistoryEntry(url, tabId, openedAtIso) {
  const currentUrl = canonicalizeUrl(url);
  if (!shouldCollectTempHistoryForUrl(currentUrl)) {
    return;
  }

  const settings = await loadSettings();
  const pageInfo = await getReliableTempHistoryPageInfo(tabId, currentUrl, settings);
  const tempHistory = await loadTempHistory();
  const fallbackName = deriveTempSubjectNameFromUrl(currentUrl);
  const rawName = makeReasonableSubjectName(
    pageInfo?.subjectName || pageInfo?.title || fallbackName,
    settings.titleCleanup
  );
  const candidateName = normalizeTempHistoryName(rawName, currentUrl);
  if (!shouldKeepTempHistoryPageInfo(pageInfo, candidateName)) {
    return;
  }

  let found = false;
  const updated = tempHistory.map((entry) => {
    if (!sameUrl(entry.url, currentUrl)) return entry;
    found = true;
    return {
      ...entry,
      name: chooseTempHistoryName(candidateName, entry.name, currentUrl),
      lastOpenedAt: openedAtIso || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });

  if (!found) {
    updated.push({
      id: createTempHistoryId(currentUrl),
      url: currentUrl,
      name: chooseTempHistoryName(candidateName, '', currentUrl),
      lastOpenedAt: openedAtIso || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  const subjects = await loadSubjects();
  const pruned = pruneTempHistoryForSubjects(updated, subjects);
  await chrome.storage.local.set({ [STORAGE_KEYS.tempHistory]: pruned });

  if (Number.isFinite(Number(tabId)) && isFallbackTempHistoryName(candidateName)) {
    setTimeout(() => {
      upsertTempHistoryEntry(currentUrl, tabId).catch((error) => {
        console.warn('[WAKABA Launcher] 仮履歴名の再取得に失敗しました。', error);
      });
    }, TEMP_HISTORY_FOLLOW_UP_REFRESH_MS);
  }
}

async function getReliableTempHistoryPageInfo(tabId, url, settings) {
  const fallbackName = deriveTempSubjectNameFromUrl(url);
  let latestInfo = null;
  let latestName = fallbackName;

  if (!Number.isFinite(Number(tabId))) {
    return {
      title: fallbackName,
      subjectName: fallbackName,
      hasStrongCourseEvidence: false,
      href: url,
      subjectSource: ''
    };
  }

  for (let attempt = 0; attempt < TEMP_HISTORY_NAME_RETRY_COUNT; attempt += 1) {
    const pageInfo = await getCurrentTabPageInfo(tabId);
    if (pageInfo) {
      latestInfo = pageInfo;
      const candidate = normalizeTempHistoryName(
        makeReasonableSubjectName(pageInfo.subjectName || pageInfo.title || fallbackName, settings.titleCleanup),
        url
      );
      if (candidate) {
        latestName = candidate;
      }
      if (!isFallbackTempHistoryName(candidate) && !isWeakTempHistoryName(candidate)) {
        return pageInfo;
      }
    }

    if (attempt < TEMP_HISTORY_NAME_RETRY_COUNT - 1) {
      await sleep(TEMP_HISTORY_NAME_RETRY_INTERVAL_MS);
    }
  }

  if (latestInfo) {
    return {
      ...latestInfo,
      subjectName: latestName || latestInfo.subjectName || latestInfo.title || fallbackName,
      hasStrongCourseEvidence: Boolean(latestInfo.hasStrongCourseEvidence) && !isWeakTempHistoryName(latestName || latestInfo.subjectName || latestInfo.title || fallbackName)
    };
  }

  return {
    title: latestName || fallbackName,
    subjectName: latestName || fallbackName,
    hasStrongCourseEvidence: false,
    href: url
  };
}

function shouldCollectEpisodeHistoryForUrl(url) {
  return isDeliveryDomainUrl(url);
}

function scheduleEpisodeHistoryObservation(url, tabId, openedAtIso) {
  const currentUrl = canonicalizeUrl(url);
  if (!shouldCollectEpisodeHistoryForUrl(currentUrl)) {
    clearPendingEpisodeHistoryObservation(tabId);
    return;
  }

  if (!Number.isFinite(Number(tabId))) {
    return;
  }

  const key = String(tabId);
  clearPendingEpisodeHistoryObservation(tabId);

  const timerId = setTimeout(async () => {
    pendingEpisodeHistoryTimers.delete(key);

    try {
      const tab = await chrome.tabs.get(tabId);
      const latestUrl = normalizeLaunchUrl(tab?.url || '');
      if (!latestUrl || !sameUrl(latestUrl, currentUrl)) {
        return;
      }

      await upsertEpisodeHistoryEntry(latestUrl, tabId, openedAtIso);
    } catch (error) {
      console.warn('[WAKABA Launcher] 個別履歴の安定待ち中にタブを確認できませんでした。', error);
    }
  }, TEMP_HISTORY_STABLE_DELAY_MS);

  pendingEpisodeHistoryTimers.set(key, { timerId, url: currentUrl });
}

function clearPendingEpisodeHistoryObservation(tabId) {
  const key = String(tabId);
  const pending = pendingEpisodeHistoryTimers.get(key);
  if (!pending) return;

  clearTimeout(pending.timerId);
  pendingEpisodeHistoryTimers.delete(key);
}

function shouldKeepEpisodeHistoryPageInfo(pageInfo) {
  if (!pageInfo?.hasEpisodeEvidence) return false;

  const subjectName = String(pageInfo?.subjectName || '').trim();
  const episodeLabel = String(pageInfo?.episodeLabel || '').trim();
  if (!subjectName || !episodeLabel) return false;
  if (isWeakTempHistoryName(subjectName) || isFallbackTempHistoryName(subjectName)) return false;
  return true;
}

async function upsertEpisodeHistoryEntry(url, tabId, openedAtIso) {
  const currentUrl = canonicalizeUrl(url);
  if (!shouldCollectEpisodeHistoryForUrl(currentUrl)) {
    return;
  }

  const pageInfo = await getReliableEpisodePageInfo(tabId, currentUrl);
  await upsertEpisodeHistoryFromPageInfo(currentUrl, pageInfo, openedAtIso);
}

async function upsertEpisodeHistoryFromPageInfo(url, pageInfo, openedAtIso) {
  const currentUrl = canonicalizeUrl(url || pageInfo?.href || '');
  if (!shouldCollectEpisodeHistoryForUrl(currentUrl) || !shouldKeepEpisodeHistoryPageInfo(pageInfo)) {
    return;
  }

  const episodeHistory = await loadEpisodeHistory();
  const displayName = buildEpisodeHistoryDisplayName(pageInfo);
  const lastOpenedAt = openedAtIso || new Date().toISOString();
  let found = false;
  const normalizedEpisodeLabel = String(pageInfo?.episodeLabel || '').trim();
  const updated = episodeHistory.map((entry) => {
    const sameEpisode = sameUrl(entry.url, currentUrl)
      && String(entry.episodeLabel || '').trim() === normalizedEpisodeLabel;
    if (!sameEpisode) return entry;
    found = true;
    return {
      ...entry,
      id: createEpisodeHistoryId(currentUrl, normalizedEpisodeLabel),
      name: displayName,
      courseName: pageInfo.subjectName,
      episodeLabel: normalizedEpisodeLabel,
      episodeTitle: pageInfo.episodeTitle || '',
      lastOpenedAt,
      updatedAt: new Date().toISOString()
    };
  });

  if (!found) {
    updated.push({
      id: createEpisodeHistoryId(currentUrl, normalizedEpisodeLabel),
      url: currentUrl,
      name: displayName,
      courseName: pageInfo.subjectName,
      episodeLabel: normalizedEpisodeLabel,
      episodeTitle: pageInfo.episodeTitle || '',
      lastOpenedAt,
      updatedAt: new Date().toISOString()
    });
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.episodeHistory]: normalizeEpisodeHistoryEntries(updated) });
}

async function getReliableEpisodePageInfo(tabId, url) {
  if (!Number.isFinite(Number(tabId))) {
    return null;
  }

  let latestInfo = null;
  for (let attempt = 0; attempt < TEMP_HISTORY_NAME_RETRY_COUNT; attempt += 1) {
    const pageInfo = await getCurrentTabPageInfo(tabId);
    if (pageInfo) {
      latestInfo = pageInfo;
      if (shouldKeepEpisodeHistoryPageInfo(pageInfo)) {
        return pageInfo;
      }
    }

    if (attempt < TEMP_HISTORY_NAME_RETRY_COUNT - 1) {
      await sleep(TEMP_HISTORY_NAME_RETRY_INTERVAL_MS);
    }
  }

  return latestInfo;
}

function buildEpisodeHistoryDisplayName(pageInfo) {
  const courseName = String(pageInfo?.subjectName || '').trim();
  const episodeLabel = String(pageInfo?.episodeLabel || '').trim();
  const episodeTitle = String(pageInfo?.episodeTitle || '').trim();
  const tail = [episodeLabel, episodeTitle].filter(Boolean).join(' ');
  return [courseName, tail].filter(Boolean).join(' / ').trim();
}

function normalizeEpisodeHistoryEntries(entries) {
  const byEpisode = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const url = normalizeLaunchUrl(entry?.url);
    if (!url) continue;

    const normalizedEpisodeLabel = String(entry.episodeLabel || '').trim();
    const normalized = {
      id: entry.id || createEpisodeHistoryId(url, normalizedEpisodeLabel),
      url,
      name: String(entry.name || '').trim(),
      courseName: String(entry.courseName || '').trim(),
      episodeLabel: normalizedEpisodeLabel,
      episodeTitle: String(entry.episodeTitle || '').trim(),
      lastOpenedAt: entry.lastOpenedAt || null,
      updatedAt: entry.updatedAt || null
    };

    if (!normalized.name) {
      normalized.name = [normalized.courseName, [normalized.episodeLabel, normalized.episodeTitle].filter(Boolean).join(' ')].filter(Boolean).join(' / ').trim();
    }

    if (!normalized.name || !normalized.courseName || !normalized.episodeLabel) {
      continue;
    }

    const key = `${createHistoryNameKey(normalized.courseName)}|${normalizedEpisodeLabel}`;
    const existing = byEpisode.get(key);
    if (!existing || compareIsoDate(normalized.lastOpenedAt || normalized.updatedAt, existing.lastOpenedAt || existing.updatedAt) > 0) {
      byEpisode.set(key, normalized);
    }
  }

  return Array.from(byEpisode.values())
    .sort((a, b) => compareIsoDate(b.lastOpenedAt || b.updatedAt, a.lastOpenedAt || a.updatedAt))
    .slice(0, MAX_EPISODE_HISTORY_ITEMS);
}

function createEpisodeHistoryId(url, episodeLabel = '') {
  const safeUrl = encodeURIComponent(canonicalizeUrl(url)).replace(/%/g, '_').slice(0, 80);
  const safeEpisode = encodeURIComponent(String(episodeLabel || '').trim()).replace(/%/g, '_').slice(0, 40);
  return `episode_${safeUrl}${safeEpisode ? `_${safeEpisode}` : ''}`;
}

function normalizeSubject(subject, index) {
  const id = subject.id || createId();
  const url = normalizeLaunchUrl(subject.url);

  if (!url) {
    throw new Error(`科目「${subject.name || '(名称未設定)'}」のURLが無効です。`);
  }

  return {
    id,
    name: String(subject.name || '').trim() || `科目 ${index + 1}`,
    url,
    favorite: Boolean(subject.favorite),
    order: Number.isFinite(Number(subject.order)) ? Number(subject.order) : (index + 1) * 10,
    lastOpenedAt: subject.lastOpenedAt || null
  };
}


function canSaveCurrentDeliveryPage(pageInfo, matchedTemp, suggestedName) {
  if (pageInfo?.hasEpisodeEvidence) {
    return false;
  }

  const directName = String(pageInfo?.subjectName || '').trim();
  const tempName = String(matchedTemp?.name || '').trim();
  const candidateNames = [directName, tempName, String(suggestedName || '').trim()]
    .map((name) => makeReasonableSubjectName(name, true))
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  if (candidateNames.some((name) => !isWeakTempHistoryName(name) && !isFallbackTempHistoryName(name))) {
    return true;
  }

  return Boolean(pageInfo?.hasStrongCourseEvidence && directName && !isWeakTempHistoryName(directName));
}
function normalizeTempHistoryName(name, url) {
  const text = String(name || '').trim();
  if (!text || isWeakTempHistoryName(text)) {
    return deriveTempSubjectNameFromUrl(url);
  }
  return text;
}

function isFallbackTempHistoryName(name) {
  const text = String(name || '').trim();
  return /^配信ページ[（(]\d+[)）]$/u.test(text);
}

function chooseTempHistoryName(candidateName, existingName, url) {
  const fallbackName = deriveTempSubjectNameFromUrl(url);
  const candidate = String(candidateName || '').trim();
  const existing = String(existingName || '').trim();

  if (candidate && !isWeakTempHistoryName(candidate)) {
    return candidate;
  }

  if (existing && !isWeakTempHistoryName(existing)) {
    return existing;
  }

  return candidate || existing || fallbackName;
}

function isWeakTempHistoryName(name) {
  const text = String(name || '').trim();
  if (!text) return true;

  return /^(?:動画|放送大学|WAKABA)$/u.test(text)
    || /^未登録の配信ページ(?:\s*[（(]\d+[)）])?$/u.test(text)
    || /^配信ページ[（(]\d+[)）]$/u.test(text)
    || /(?:コース|学部|研究科|専攻|プログラム|資格取得に資する科目|基盤科目|外国語科目)$/u.test(text);
}

function normalizeTempHistoryEntries(entries) {
  return entries
    .map((entry) => {
      const url = normalizeLaunchUrl(entry?.url);
      if (!url) return null;

      return {
        id: entry.id || createTempHistoryId(url),
        url,
        name: normalizeTempHistoryName(String(entry.name || '').trim() || deriveTempSubjectNameFromUrl(url), url),
        lastOpenedAt: entry.lastOpenedAt || null,
        updatedAt: entry.updatedAt || null
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareIsoDate(b.lastOpenedAt || b.updatedAt, a.lastOpenedAt || a.updatedAt))
    .slice(0, MAX_TEMP_HISTORY_ITEMS);
}

function pruneTempHistoryForSubjects(tempHistory, subjects) {
  const registeredUrls = new Set(
    subjects
      .map((subject) => canonicalizeUrl(subject.url))
      .filter(Boolean)
  );

  return normalizeTempHistoryEntries(tempHistory).filter((entry) => !registeredUrls.has(canonicalizeUrl(entry.url)));
}

function sortSubjects(subjects) {
  return [...subjects].sort((a, b) => {
    const orderDiff = Number(a.order || 0) - Number(b.order || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

function makeReasonableSubjectName(title, cleanupEnabled) {
  const text = String(title || '').trim();
  if (!cleanupEnabled || !text) return text || '新しい科目';

  return text
    .replace(/\s*[-｜|].*$/u, '')
    .replace(/\s*\|.*$/u, '')
    .replace(/\s*【.*?】/gu, '')
    .trim() || '新しい科目';
}

function getNextOrder(subjects) {
  return subjects.reduce((max, subject) => Math.max(max, Number(subject.order || 0)), 0) + 10;
}

function createId() {
  return `subj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTempHistoryId(url) {
  const safe = encodeURIComponent(canonicalizeUrl(url)).replace(/%/g, '_').slice(0, 80);
  return `temp_${safe}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLaunchUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';

  try {
    const parsed = new URL(value);
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    return canonicalizeUrl(parsed.toString());
  } catch {
    return '';
  }
}

function isCasLoginUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'sso.ouj.ac.jp' && parsed.pathname.startsWith('/cas/login');
  } catch {
    return false;
  }
}

function isPortalEntryUrl(url) {
  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    return parsed.hostname === 'www.wakaba.ouj.ac.jp' && normalizedPath === '/portal/';
  } catch {
    return false;
  }
}

function isWakabaUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.wakaba.ouj.ac.jp';
  } catch {
    return false;
  }
}

function isVideoDeliveryUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'v.ouj.ac.jp';
  } catch {
    return false;
  }
}

function isDeliveryDomainUrl(url) {
  return isVideoDeliveryUrl(url);
}


function isDeliveryHomeRouteUrl(url) {
  const route = parseVideoDeliveryRoute(url);
  if (!route) return false;
  return route.path === '/login' || route.path === '/navi/home';
}

function parseVideoDeliveryRoute(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'v.ouj.ac.jp') {
      return null;
    }

    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
    if (!hash) return null;

    const routeUrl = new URL(hash.startsWith('/') ? `https://dummy.invalid${hash}` : `https://dummy.invalid/${hash}`);
    return {
      path: routeUrl.pathname,
      ca: routeUrl.searchParams.get('ca') || '',
      searchParams: routeUrl.searchParams
    };
  } catch {
    return null;
  }
}

function shouldCollectTempHistoryForUrl(url) {
  const route = parseVideoDeliveryRoute(url);
  if (!route) return false;
  return route.path.startsWith('/navi/vod') && Boolean(route.ca);
}

function deriveTempSubjectNameFromUrl(url) {
  const route = parseVideoDeliveryRoute(url);
  if (route?.ca) {
    return `配信ページ（${route.ca}）`;
  }
  return '配信ページ';
}

function isRegisterableSubjectUrl(url) {
  return isWakabaUrl(url) || isVideoDeliveryUrl(url);
}

function isLaunchableSubjectUrl(url) {
  return isRegisterableSubjectUrl(url);
}

function isRelatedWakabaUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.wakaba.ouj.ac.jp' || parsed.hostname === 'sso.ouj.ac.jp' || parsed.hostname === 'v.ouj.ac.jp';
  } catch {
    return false;
  }
}

function shouldPreserveHash(url) {
  return isVideoDeliveryUrl(url);
}

function canonicalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!shouldPreserveHash(url)) {
      parsed.hash = '';
    } else if (parsed.hash === '#') {
      parsed.hash = '';
    }
    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

function stripHash(url) {
  return canonicalizeUrl(url);
}

function sameUrl(a, b) {
  return canonicalizeUrl(a) === canonicalizeUrl(b);
}

function compareIsoDate(a, b) {
  const left = Date.parse(String(a || ''));
  const right = Date.parse(String(b || ''));
  const safeLeft = Number.isFinite(left) ? left : 0;
  const safeRight = Number.isFinite(right) ? right : 0;
  return safeLeft - safeRight;
}
