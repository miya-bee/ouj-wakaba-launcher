const AUTO_LOGIN_TTL_MS = 5 * 60 * 1000;
const MAX_WAIT_CYCLES = 24;
const WAIT_MS = 250;
const TARGET_SERVICE_KEYWORD = "wakaba.ouj.ac.jp/portal/login/login/initCasLogin";
const TARGET_SERVICE_URL = "https://sso.ouj.ac.jp/cas/login?service=https%3A%2F%2Fwww.wakaba.ouj.ac.jp%2Fportal%2Flogin%2Flogin%2FinitCasLogin";

(async function init() {
  if (!isPortalPage() && !isTargetSsoPage()) {
    return;
  }

  const request = await getValidAutoLoginRequest();
  if (!request) {
    return;
  }

  const { wakabaCredentials } = await chrome.storage.local.get("wakabaCredentials");
  if (!wakabaCredentials?.username || !wakabaCredentials?.password) {
    return;
  }

  if (isPortalPage()) {
    await handlePortalPage(request, wakabaCredentials);
    return;
  }

  if (isTargetSsoPage()) {
    await handleSsoPage(request, wakabaCredentials);
  }
})();


async function handlePortalPage(request, credentials) {
  const pageKey = `portal:${location.pathname}${location.search}`;
  const attemptKey = `wakaba-auto-login:${request.token}:${pageKey}`;
  const clickKey = `${attemptKey}:click-login-control`;
  const submitKey = `${attemptKey}:submit-credentials`;

  for (let cycle = 0; cycle < MAX_WAIT_CYCLES; cycle += 1) {
    const loginControl = findPortalLoginControl();

    // portal/ では、既存のログイン状態が残っている場合、
    // ログインボタンを押すだけでトップページへ進めることがある。
    // そのため、まずはボタンクリックを優先し、遷移しない場合のみ
    // 保存済みID/パスワードの入力へフォールバックする。
    if (loginControl && sessionStorage.getItem(clickKey) !== "1") {
      sessionStorage.setItem(clickKey, "1");

      const navigated = tryPortalLoginNavigation(loginControl);
      if (!navigated) {
        clickElement(loginControl);
      }
      await sleep(1200);

      if (!isPortalPage()) {
        return;
      }
    }

    const usernameInput = findPortalUsernameInput();
    const passwordInput = findPortalPasswordInput();

    if (usernameInput && passwordInput) {
      if (sessionStorage.getItem(submitKey) === "1") {
        return;
      }

      sessionStorage.setItem(submitKey, "1");
      fillInput(usernameInput, credentials.username);
      fillInput(passwordInput, credentials.password);
      await clearAutoLoginRequestIfMatches(request.token);
      setTimeout(() => submitLogin(usernameInput, passwordInput), 200);
      return;
    }

    await sleep(WAIT_MS);
  }

  console.warn("[WAKABA Auto Login] portal/ ページでログイン導線を見つけられませんでした。");
}

async function handleSsoPage(request, credentials) {
  const pageKey = `sso:${location.pathname}${location.search}`;
  const attemptKey = `wakaba-auto-login:${request.token}:${pageKey}`;

  if (sessionStorage.getItem(attemptKey) === "1") {
    return;
  }

  const { usernameInput, passwordInput } = await waitForSsoInputs();
  if (!usernameInput || !passwordInput) {
    console.warn("[WAKABA Auto Login] SSO入力欄を検出できませんでした。");
    return;
  }

  sessionStorage.setItem(attemptKey, "1");
  fillInput(usernameInput, credentials.username);
  fillInput(passwordInput, credentials.password);
  await clearAutoLoginRequestIfMatches(request.token);
  setTimeout(() => submitLogin(usernameInput, passwordInput), 250);
}

async function getValidAutoLoginRequest() {
  const { wakabaAutoLoginRequest } = await chrome.storage.local.get("wakabaAutoLoginRequest");
  if (!wakabaAutoLoginRequest?.token || !wakabaAutoLoginRequest?.createdAt) {
    return null;
  }

  if (Date.now() - wakabaAutoLoginRequest.createdAt > AUTO_LOGIN_TTL_MS) {
    await chrome.storage.local.remove("wakabaAutoLoginRequest");
    return null;
  }

  return wakabaAutoLoginRequest;
}

async function clearAutoLoginRequestIfMatches(token) {
  const { wakabaAutoLoginRequest } = await chrome.storage.local.get("wakabaAutoLoginRequest");
  if (wakabaAutoLoginRequest?.token === token) {
    await chrome.storage.local.remove("wakabaAutoLoginRequest");
  }
}

async function waitForSsoInputs() {
  for (let attempt = 0; attempt < MAX_WAIT_CYCLES; attempt += 1) {
    const usernameInput = findSsoUsernameInput();
    const passwordInput = findSsoPasswordInput();

    if (usernameInput && passwordInput) {
      return { usernameInput, passwordInput };
    }

    await sleep(WAIT_MS);
  }

  return { usernameInput: null, passwordInput: null };
}

function isPortalPage() {
  if (location.hostname !== "www.wakaba.ouj.ac.jp") {
    return false;
  }

  const normalizedPath = location.pathname.endsWith("/")
    ? location.pathname
    : `${location.pathname}/`;

  return normalizedPath === "/portal/";
}

function isTargetSsoPage() {
  if (location.hostname !== "sso.ouj.ac.jp") {
    return false;
  }

  if (!location.pathname.startsWith("/cas/login")) {
    return false;
  }

  const service = new URLSearchParams(location.search).get("service") || "";
  return service.includes(TARGET_SERVICE_KEYWORD) || !service;
}

function findPortalUsernameInput() {
  const selectors = [
    'input[name="account"]',
    'input[id="account"]',
    'input[name="username"]',
    'input[id="username"]',
    'input[name="loginId"]',
    'input[id="loginId"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="email"]'
  ];

  return findInputBySelectors(selectors, looksLikeUsernameField);
}

function findPortalPasswordInput() {
  return Array.from(document.querySelectorAll('input[type="password"]')).find(isUsableInput) || null;
}

function findPortalLoginControl() {
  const directSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name="login"]',
    'a[href*="cas/login"]',
    'a[href*="/portal/login/"]'
  ];

  for (const selector of directSelectors) {
    const match = Array.from(document.querySelectorAll(selector)).find(isClickableLoginElement);
    if (match) {
      return match;
    }
  }

  return Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
    .find((el) => isClickableLoginElement(el) && /ログイン|login/i.test(getElementText(el))) || null;
}

function findSsoUsernameInput() {
  const selectors = [
    'input[name="username"]',
    'input[id="username"]',
    'input[name="loginId"]',
    'input[id="loginId"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="email"]'
  ];

  return findInputBySelectors(selectors, looksLikeUsernameField);
}

function findSsoPasswordInput() {
  return Array.from(document.querySelectorAll('input[type="password"]')).find(isUsableInput) || null;
}

function findInputBySelectors(selectors, matcher) {
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector)).filter(isUsableInput);
    const match = candidates.find(matcher) || candidates[0];
    if (match) {
      return match;
    }
  }

  return Array.from(document.querySelectorAll("input")).find(
    (el) => isUsableInput(el) && matcher(el)
  ) || null;
}

function isUsableInput(el) {
  return !!el && !el.disabled && !el.readOnly && el.type !== "hidden" && isVisible(el);
}

function isVisible(el) {
  if (!el) {
    return false;
  }

  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function looksLikeUsernameField(el) {
  const fingerprint = [
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute("aria-label"),
    el.autocomplete,
    el.labels ? Array.from(el.labels).map((label) => label.textContent).join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!fingerprint) {
    return ["text", "email", "search"].includes((el.type || "text").toLowerCase());
  }

  return /(user|login|account|id|アカウント|ユーザー)/i.test(fingerprint);
}

function isClickableLoginElement(el) {
  if (!el || !isVisible(el)) {
    return false;
  }

  if (el.disabled) {
    return false;
  }

  return true;
}

function getElementText(el) {
  return [el.textContent, el.value, el.getAttribute("aria-label"), el.title]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function fillInput(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  input.focus();

  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitLogin(usernameInput, passwordInput) {
  const form = passwordInput.form || usernameInput.form || document.querySelector("form");
  if (!form) {
    clickFallbackSubmitButton();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"], input[type="submit"], button[name="submit"], button[name="login"]');
  if (submitButton) {
    clickElement(submitButton);
    return;
  }

  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return;
  }

  form.submit();
}

function clickFallbackSubmitButton() {
  const submitButton = document.querySelector('button[type="submit"], input[type="submit"], button[name="submit"], button[name="login"]');
  if (submitButton) {
    clickElement(submitButton);
  }
}


function tryPortalLoginNavigation(el) {
  const href = typeof el?.getAttribute === "function" ? String(el.getAttribute("href") || "").trim() : "";
  const actionCandidates = [
    href,
    typeof el?.dataset?.href === "string" ? el.dataset.href : "",
    typeof el?.dataset?.url === "string" ? el.dataset.url : "",
    typeof el?.getAttribute === "function" ? String(el.getAttribute("data-href") || "") : "",
    typeof el?.getAttribute === "function" ? String(el.getAttribute("data-url") || "") : ""
  ].map((value) => String(value || "").trim()).filter(Boolean);

  const resolved = actionCandidates
    .map((value) => toAbsoluteUrl(value))
    .find((value) => value && !/^\s*javascript\s*:/i.test(value));

  const targetUrl = resolved || TARGET_SERVICE_URL;
  if (!targetUrl) {
    return false;
  }

  window.location.assign(targetUrl);
  return true;
}

function toAbsoluteUrl(value) {
  const text = String(value || "").trim();
  if (!text || /^\s*javascript\s*:/i.test(text)) {
    return "";
  }

  try {
    return new URL(text, location.href).toString();
  } catch {
    return "";
  }
}

function clickElement(el) {
  el.focus?.();
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));

  const href = typeof el?.getAttribute === "function" ? String(el.getAttribute("href") || "") : "";
  if (/^\s*javascript\s*:/i.test(href)) {
    return;
  }

  el.click();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}



const EPISODE_INTERACTION_ACTIVE_MS = 15000;

let lastObservedEpisodeKey = '';
let episodeHistoryNotifyTimer = null;
let episodeHistoryMutationObserver = null;
let lastEpisodeInteractionAt = 0;
let lastEpisodeInteractionHint = null;
let lastEpisodeInteractionUrl = '';

initEpisodeHistoryNotifier();

function initEpisodeHistoryNotifier() {
  if (!isVideoDeliveryPage()) {
    return;
  }

  const schedule = () => {
    if (isEpisodeInteractionActive()) {
      scheduleEpisodeHistoryNotification();
    }
  };

  const observeInteraction = (event) => {
    const hint = extractEpisodeInteractionHint(event?.target);
    if (!hint?.label) {
      return;
    }

    lastEpisodeInteractionAt = Date.now();
    lastEpisodeInteractionHint = hint;
    lastEpisodeInteractionUrl = canonicalizeEpisodePageUrl(location.href);
    scheduleEpisodeHistoryNotification();
  };

  document.addEventListener('click', observeInteraction, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      observeInteraction(event);
    }
  }, true);

  window.addEventListener('hashchange', schedule, true);
  window.addEventListener('popstate', schedule, true);
  window.addEventListener('pageshow', schedule, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      schedule();
    }
  }, true);

  const startObserver = () => {
    if (!document.body || episodeHistoryMutationObserver) {
      return;
    }
    episodeHistoryMutationObserver = new MutationObserver(() => {
      if (isEpisodeInteractionActive()) {
        scheduleEpisodeHistoryNotification();
      }
    });
    episodeHistoryMutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  };

  if (document.body) {
    startObserver();
  } else {
    window.addEventListener('DOMContentLoaded', startObserver, { once: true });
  }
}

function scheduleEpisodeHistoryNotification() {
  if (!isVideoDeliveryPage() || !isEpisodeInteractionActive()) {
    return;
  }
  if (episodeHistoryNotifyTimer) {
    clearTimeout(episodeHistoryNotifyTimer);
  }
  episodeHistoryNotifyTimer = setTimeout(() => {
    episodeHistoryNotifyTimer = null;
    notifyObservedEpisodePageInfo().catch(() => {});
  }, 700);
}

async function notifyObservedEpisodePageInfo() {
  const subjectInfo = extractCurrentSubjectInfo();
  const episodeInfo = extractCurrentEpisodeInfo(subjectInfo, {
    requireActivation: true,
    allowPreferredFallback: true,
    passiveMode: false
  });
  if (!subjectInfo?.hasStrongCourseEvidence || !episodeInfo?.hasEpisodeEvidence) {
    return;
  }

  const episodeKey = [canonicalizeEpisodePageUrl(location.href), subjectInfo.name, episodeInfo.label, episodeInfo.title].join('|');
  if (episodeKey === lastObservedEpisodeKey) {
    return;
  }
  lastObservedEpisodeKey = episodeKey;

  await chrome.runtime.sendMessage({
    type: 'OBSERVED_PAGE_INFO',
    payload: {
      href: location.href,
      title: document.title || '',
      subjectName: subjectInfo.name,
      subjectSource: subjectInfo.source,
      hasStrongCourseEvidence: subjectInfo.hasStrongCourseEvidence,
      episodeLabel: episodeInfo.label,
      episodeTitle: episodeInfo.title,
      episodeDisplayName: episodeInfo.displayName,
      hasEpisodeEvidence: episodeInfo.hasEpisodeEvidence
    }
  }).catch(() => {});
}

function isEpisodeInteractionActive() {
  if (!lastEpisodeInteractionAt) {
    return false;
  }
  if (Date.now() - lastEpisodeInteractionAt > EPISODE_INTERACTION_ACTIVE_MS) {
    lastEpisodeInteractionAt = 0;
    lastEpisodeInteractionHint = null;
    lastEpisodeInteractionUrl = '';
    return false;
  }

  return true;
}

function sameEpisodeBaseUrl(left, right) {
  return deriveEpisodeInteractionContextKey(left) === deriveEpisodeInteractionContextKey(right);
}

function canonicalizeEpisodePageUrl(url) {
  return String(url || '').trim();
}

function deriveEpisodeInteractionContextKey(url) {
  const text = String(url || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = new URL(text, location.href);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
}

function extractEpisodeInteractionHint(target) {
  const seen = new Set();
  let el = target instanceof Element ? target : null;

  for (let depth = 0; el && depth < 6; depth += 1, el = el.parentElement) {
    if (seen.has(el)) {
      break;
    }
    seen.add(el);

    const text = compactWhitespace([
      el.textContent || '',
      typeof el.getAttribute === 'function' ? (el.getAttribute('aria-label') || '') : '',
      typeof el.getAttribute === 'function' ? (el.getAttribute('title') || '') : ''
    ].filter(Boolean).join(' '));

    if (!text) {
      continue;
    }

    const matches = extractEpisodeMatches(text);
    if (!matches.length) {
      continue;
    }

    matches.sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || a.label.localeCompare(b.label, 'ja'));
    return matches[0];
  }

  return null;
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'GET_CURRENT_PAGE_INFO') {
    return;
  }

  const subjectInfo = extractCurrentSubjectInfo();
  const episodeInfo = extractCurrentEpisodeInfo(subjectInfo, {
    requireActivation: true,
    allowPreferredFallback: true,
    passiveMode: true
  });
  sendResponse({
    ok: true,
    href: location.href,
    title: document.title || '',
    subjectName: subjectInfo.name,
    subjectSource: subjectInfo.source,
    hasStrongCourseEvidence: subjectInfo.hasStrongCourseEvidence,
    episodeLabel: episodeInfo.label,
    episodeTitle: episodeInfo.title,
    episodeDisplayName: episodeInfo.displayName,
    hasEpisodeEvidence: episodeInfo.hasEpisodeEvidence,
    episodeInteractionActive: isEpisodeInteractionActive()
  });
});

function extractCurrentSubjectName() {
  return extractCurrentSubjectInfo().name;
}

function extractCurrentEpisodeInfo(subjectInfo = extractCurrentSubjectInfo(), options = {}) {
  if (!isVideoDeliveryPage() || !subjectInfo?.hasStrongCourseEvidence) {
    return { label: '', title: '', displayName: '', hasEpisodeEvidence: false };
  }

  const requireActivation = Boolean(options.requireActivation);
  const passiveMode = Boolean(options.passiveMode);
  const allowPreferredFallback = Boolean(options.allowPreferredFallback);

  if (requireActivation && !isEpisodeInteractionActive()) {
    return { label: '', title: '', displayName: '', hasEpisodeEvidence: false };
  }

  const preferredHint = lastEpisodeInteractionHint;
  const candidates = collectEpisodeCandidates(preferredHint, { passiveMode, allowPreferredFallback });
  if (!candidates.length) {
    return { label: '', title: '', displayName: '', hasEpisodeEvidence: false };
  }

  candidates.sort((a, b) => b.score - a.score || b.label.localeCompare(a.label, 'ja'));
  const best = candidates[0];
  const displayName = [subjectInfo.name, [best.label, best.title].filter(Boolean).join(' ')].filter(Boolean).join(' / ');
  return {
    label: best.label,
    title: best.title,
    displayName,
    hasEpisodeEvidence: true
  };
}

function collectEpisodeCandidates(preferredHint = null, options = {}) {
  const selectedSelectors = [
    '[aria-selected="true"]',
    '[aria-current="page"]',
    '[aria-current="true"]',
    '.selected',
    '.current',
    '.active',
    '[class*="selected"]',
    '[class*="current"]',
    '[class*="active"]'
  ].join(', ');

  const headingSelectors = [
    '[role="heading"]',
    '.list-title-span',
    'h1, h2, h3, h4',
    '[class*="title"]',
    '[class*="heading"]'
  ].join(', ');

  const contextSelectors = [
    '.text-area',
    '[class*="text-area"]',
    '[class*="player"]',
    '[class*="movie"]',
    '[class*="video"]',
    '[class*="content"]',
    'main'
  ].join(', ');

  const collectMatchesFromSelectors = (selector, baseScore) => {
    const results = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(selector)) {
      if (!isElementReadable(el)) continue;
      const text = compactWhitespace(el.textContent || '');
      if (!text) continue;
      for (const match of extractEpisodeMatches(text)) {
        const key = `${match.label}|${match.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ ...match, score: baseScore + (match.title ? 20 : 0) });
      }
    }
    return results;
  };

  const selectedMatches = collectMatchesFromSelectors(selectedSelectors, 260);
  const headingMatches = collectMatchesFromSelectors(headingSelectors, 220);
  const contextMatches = collectMatchesFromSelectors(contextSelectors, 160);
  const titleMatches = extractEpisodeMatches(compactWhitespace(document.title || '')).map((match) => ({ ...match, score: 200 + (match.title ? 20 : 0) }));

  const chosenLabel = chooseEpisodeLabel([
    selectedMatches,
    headingMatches,
    contextMatches,
    titleMatches
  ], preferredHint);

  if (!chosenLabel) {
    if (allowPreferredFallback && preferredHint?.label) {
      return [{
        label: preferredHint.label,
        title: String(preferredHint.title || '').trim(),
        score: 320
      }];
    }
    return [];
  }

  const combined = [...selectedMatches, ...headingMatches, ...contextMatches, ...titleMatches]
    .filter((item) => item.label === chosenLabel)
    .map((item) => ({ ...item, score: item.score + 80 }));

  if (!combined.length) {
    return [];
  }

  return combined;
}

function chooseEpisodeLabel(candidateGroups, preferredHint = null) {
  const scoreByLabel = new Map();
  const groupCountByLabel = new Map();

  for (const group of candidateGroups) {
    const seenInGroup = new Set();
    for (const item of group) {
      if (!item?.label) continue;
      scoreByLabel.set(item.label, (scoreByLabel.get(item.label) || 0) + Number(item.score || 0));
      if (!seenInGroup.has(item.label)) {
        groupCountByLabel.set(item.label, (groupCountByLabel.get(item.label) || 0) + 1);
        seenInGroup.add(item.label);
      }
    }
  }

  const preferredLabel = String(preferredHint?.label || '').trim();
  if (preferredLabel && scoreByLabel.has(preferredLabel)) {
    return preferredLabel;
  }

  const viable = Array.from(scoreByLabel.keys())
    .filter((label) => (groupCountByLabel.get(label) || 0) >= 2);

  viable.sort((a, b) => (scoreByLabel.get(b) || 0) - (scoreByLabel.get(a) || 0) || a.localeCompare(b, 'ja'));
  return viable[0] || '';
}

function extractEpisodeMatches(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) return [];

  const matches = [];
  const regex = /第\s*([0-9０-９]+)\s*回(?:\s*[-–—:：]\s*|\s+)?([^\n\r]{0,80})?/gu;
  let m;
  while ((m = regex.exec(normalized)) !== null) {
    const num = normalizeDigits(m[1] || '');
    if (!num) continue;
    let title = compactWhitespace(m[2] || '');
    title = title.replace(/^(?:動画|放送大学|WAKABA)$/u, '').trim();
    title = title.replace(/^(?:\||｜|:|：|-|－|—)\s*/u, '').trim();
    title = title.replace(/\s*(?:再生|視聴|時間).*$/u, '').trim();
    if (/^(?:第\s*[0-9０-９]+\s*回|動画)$/u.test(title)) {
      title = '';
    }
    matches.push({ label: `第${num}回`, title });
  }
  return matches;
}

function normalizeDigits(text) {
  return String(text || '').replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248));
}

function extractCurrentSubjectInfo() {
  if (isVideoDeliveryPage()) {
    return extractStrictVideoDeliverySubjectInfo();
  }

  const scoredCandidates = [];
  scoredCandidates.push(...collectGenericSubjectCandidates());

  if (document.title) {
    scoredCandidates.push({
      raw: document.title,
      score: 10,
      source: 'document-title'
    });
  }

  return selectBestSubjectCandidateDetailed(scoredCandidates);
}

function extractStrictVideoDeliverySubjectInfo() {
  const breadcrumb = extractPreferredBreadcrumbSubjectInfo();
  if (breadcrumb?.name) {
    return breadcrumb;
  }

  const detail = extractPreferredDetailCourseInfo();
  if (detail?.name) {
    return detail;
  }

  return {
    name: '',
    score: 0,
    source: 'video-no-strong-subject',
    hasStrongCourseEvidence: false
  };
}

function extractPreferredBreadcrumbSubjectInfo() {
  const selectorGroups = [
    {
      selector: [
        '[class*="breadcrumb"] a',
        '[class*="breadcrumb"] li',
        '[class*="topicpath"] a',
        '[class*="topicpath"] li',
        '.breadcrumb a',
        '.breadcrumb li',
        '.topicpath a',
        '.topicpath li',
        'nav[aria-label*="breadcrumb" i] a',
        'nav[aria-label*="breadcrumb" i] li'
      ].join(', '),
      score: 1500,
      source: 'preferred-breadcrumb-rightmost-3digit'
    },
    {
      selector: [
        '[class*="breadcrumb"]',
        '[class*="topicpath"]',
        '.breadcrumb',
        '.topicpath',
        'nav[aria-label*="breadcrumb" i]'
      ].join(', '),
      score: 1450,
      source: 'preferred-breadcrumb-container-rightmost-3digit'
    }
  ];

  const matches = [];

  for (const group of selectorGroups) {
    for (const el of document.querySelectorAll(group.selector)) {
      if (!isElementReadable(el)) {
        continue;
      }

      const text = compactWhitespace(el.textContent || '');
      if (!text) {
        continue;
      }

      const label = extractRightmostThreeDigitBreadcrumbLabel(text);
      if (!label || !/^[0-9０-９]{3}\s+/u.test(label)) {
        continue;
      }

      const name = extractSubjectTitleFromCourseLabel(label) || cleanSubjectNameCandidate(label);
      if (!name || isWeakSubjectName(name) || looksLikeThreeDigitBreadcrumbDirectory(name)) {
        continue;
      }

      matches.push({
        name,
        score: group.score + name.length,
        source: group.source,
        hasStrongCourseEvidence: true
      });
    }
  }

  if (!matches.length) {
    return null;
  }

  matches.sort((a, b) => b.score - a.score || b.name.length - a.name.length || a.name.localeCompare(b.name, 'ja'));
  return matches[0];
}

function extractPreferredDetailCourseInfo() {
  if (looksLikeVideoDeliveryListPage()) {
    return null;
  }

  const selectorGroups = [
    {
      selector: [
        '.text-area',
        '[class*="text-area"]',
        '[class*="detail"] .text-area',
        '[class*="course"] .text-area',
        '[class*="subject"] .text-area'
      ].join(', '),
      score: 1325,
      source: 'preferred-detail-three-digit-label'
    }
  ];

  const uniqueLabels = collectDedicatedCourseLabels();
  if (uniqueLabels.length !== 1) {
    return null;
  }

  const preferredLabel = uniqueLabels[0];
  const preferredName = extractSubjectTitleFromCourseLabel(preferredLabel);
  if (!preferredName || isWeakSubjectName(preferredName) || looksLikeThreeDigitBreadcrumbDirectory(preferredName)) {
    return null;
  }

  for (const group of selectorGroups) {
    for (const el of document.querySelectorAll(group.selector)) {
      if (!isElementReadable(el)) {
        continue;
      }

      const text = compactWhitespace(el.textContent || '');
      if (!text) {
        continue;
      }

      const label = extractStrictThreeDigitCourseLabel(text);
      if (!label || compactWhitespace(label) !== compactWhitespace(preferredLabel)) {
        continue;
      }

      return {
        name: preferredName,
        score: group.score + preferredName.length,
        source: group.source,
        hasStrongCourseEvidence: true
      };
    }
  }

  return null;
}

function collectDedicatedCourseLabels() {
  const labels = new Set();
  const selectors = [
    '.text-area',
    '[class*="text-area"]',
    '[class*="detail"] .text-area',
    '[class*="course"] .text-area',
    '[class*="subject"] .text-area',
    '[class*="breadcrumb"] a',
    '[class*="topicpath"] a',
    '.breadcrumb a',
    '.topicpath a',
    'nav[aria-label*="breadcrumb" i] a'
  ];

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!isElementReadable(el)) {
        continue;
      }
      const text = compactWhitespace(el.textContent || '');
      if (!text) {
        continue;
      }
      const label = extractStrictThreeDigitCourseLabel(text) || extractRightmostThreeDigitBreadcrumbLabel(text);
      if (!label || !/^[0-9０-９]{3}\s+/u.test(label)) {
        continue;
      }
      labels.add(compactWhitespace(label));
    }
  }

  return Array.from(labels);
}

function looksLikeVideoDeliveryListPage() {
  const breadcrumbTexts = [
    ...document.querySelectorAll('[class*="breadcrumb"], [class*="topicpath"], .breadcrumb, .topicpath, nav[aria-label*="breadcrumb" i]')
  ].map((el) => compactWhitespace(el.textContent || '')).filter(Boolean);

  for (const text of breadcrumbTexts) {
    const parts = text.split(/\s*(?:>|＞|›|»|\/|／)\s*/u).map((part) => compactWhitespace(part)).filter(Boolean);
    const rightmost = parts[parts.length - 1] || '';
    if (rightmost && !/^[0-9０-９]{3}\s+/u.test(rightmost)) {
      if (/(?:コース|学部|研究科|専攻|プログラム|資格取得に資する科目|基盤科目|外国語科目)$/u.test(rightmost)) {
        return true;
      }
    }
  }

  const mainText = compactWhitespace(document.body?.innerText || '');
  if (!mainText) {
    return false;
  }

  const labelMatches = extractEmbeddedCourseLabels(mainText);
  return labelMatches.length >= 3;
}
function isVideoDeliveryPage() {
  return location.hostname === 'v.ouj.ac.jp';
}

function extractStrictThreeDigitCourseLabel(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return '';
  }

  const exact = normalized.match(/(?:^|[>＞›»/／\s])([0-9０-９]{3}\s+[^><\n\r]{1,120}?[（(][’'＇`\s]?[0-9０-９]{2}[)）]\s+[0-9０-９]{5,})(?=$|[>＞›»/／\s])/u);
  if (exact && exact[1]) {
    return compactWhitespace(exact[1]);
  }

  return '';
}

function extractRightmostThreeDigitBreadcrumbLabel(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return '';
  }

  const separators = /\s*(?:>|＞|›|»|\/|／)\s*/u;
  const parts = separators.test(normalized)
    ? normalized.split(separators).map((part) => compactWhitespace(part)).filter(Boolean)
    : [normalized];

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const strict = extractStrictThreeDigitCourseLabel(part) || (part.match(/^([0-9０-９]{3}\s+.+)$/u)?.[1] || '');
    if (strict) {
      return compactWhitespace(strict);
    }
  }

  return '';
}

function looksLikeThreeDigitBreadcrumbDirectory(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return false;
  }
  if (!/^[0-9０-９]{2,3}\s+/u.test(normalized)) {
    return false;
  }
  return /(?:コース|学部|研究科|専攻|プログラム|資格取得に資する科目|基盤科目|外国語科目)$/u.test(normalized);
}

function collectVideoDeliveryCandidates() {
  const candidates = [];
  const selectorGroups = [
    {
      selector: [
        '[class*="breadcrumb"] a',
        '[class*="topicpath"] a',
        '.breadcrumb a',
        '.topicpath a',
        'nav a[aria-current="page"]'
      ].join(', '),
      score: 320,
      source: 'breadcrumb-link'
    },
    {
      selector: [
        '.text-area',
        '[class*="text-area"]',
        '[class*="breadcrumb"] .text-area',
        '[class*="topicpath"] .text-area'
      ].join(', '),
      score: 300,
      source: 'course-text-area'
    },
    {
      selector: [
        '[class*="breadcrumb"]',
        '[class*="topicpath"]',
        '.breadcrumb',
        '.topicpath',
        'nav[aria-label*="breadcrumb" i]'
      ].join(', '),
      score: 270,
      source: 'breadcrumb-container'
    },
    {
      selector: [
        'a[href="javascript:void(0);"]',
        'a[href^="javascript:void(0)"]'
      ].join(', '),
      score: 250,
      source: 'course-anchor'
    },
    {
      selector: [
        '[class*="course"]',
        '[class*="subject"]',
        '[class*="lecture"]',
        '[data-course]',
        '[data-subject]'
      ].join(', '),
      score: 180,
      source: 'course-container'
    },
    {
      selector: 'h1, h2, h3, h4',
      score: 140,
      source: 'heading'
    },
    {
      selector: [
        '[class*="title"]',
        '[aria-current="page"]',
        'a'
      ].join(', '),
      score: 100,
      source: 'generic-element'
    }
  ];

  for (const group of selectorGroups) {
    for (const el of document.querySelectorAll(group.selector)) {
      if (!isElementReadable(el)) {
        continue;
      }

      const text = compactWhitespace(el.textContent || '');
      if (!text) {
        continue;
      }

      const strictBreadcrumbLabel = extractRightmostThreeDigitBreadcrumbLabel(text);
      if (strictBreadcrumbLabel) {
        candidates.push({
          raw: strictBreadcrumbLabel,
          score: group.score + 180,
          source: `${group.source}:strict-breadcrumb-rightmost`
        });
      }

      const strictThreeDigitLabel = extractStrictThreeDigitCourseLabel(text);
      if (strictThreeDigitLabel) {
        candidates.push({
          raw: strictThreeDigitLabel,
          score: group.score + 150,
          source: `${group.source}:strict-three-digit-label`
        });
      }

      const canonicalLabel = extractCanonicalCourseLabel(text);
      if (canonicalLabel) {
        candidates.push({
          raw: canonicalLabel,
          score: group.score + 90,
          source: `${group.source}:canonical-label`
        });
      }

      const directLabelMatches = extractEmbeddedCourseLabels(text);
      if (directLabelMatches.length) {
        for (const match of directLabelMatches) {
          candidates.push({
            raw: match,
            score: group.score + 40,
            source: `${group.source}:full-label`
          });
        }
      }

      const breadcrumbTail = extractCourseLabelFromBreadcrumb(text);
      if (breadcrumbTail) {
        candidates.push({
          raw: breadcrumbTail,
          score: group.score + 25,
          source: `${group.source}:breadcrumb-tail`
        });
      }

      if (looksLikePotentialSubjectName(text)) {
        candidates.push({
          raw: text,
          score: group.score,
          source: group.source
        });
      }
    }
  }

  return candidates;
}

function collectVideoDeliveryBodyCandidates() {
  const candidates = [];
  const bodyText = compactWhitespace(document.body?.innerText || '');
  if (!bodyText) {
    return candidates;
  }

  const strictBodyBreadcrumbLabel = extractRightmostThreeDigitBreadcrumbLabel(bodyText);
  if (strictBodyBreadcrumbLabel) {
    candidates.push({
      raw: strictBodyBreadcrumbLabel,
      score: 280,
      source: 'body-strict-breadcrumb-rightmost'
    });
  }

  for (const match of extractEmbeddedCourseLabels(bodyText)) {
    candidates.push({
      raw: match,
      score: 170,
      source: 'body-full-label'
    });
  }

  const bodyCanonicalLabel = extractCanonicalCourseLabel(bodyText);
  if (bodyCanonicalLabel) {
    candidates.push({
      raw: bodyCanonicalLabel,
      score: 210,
      source: 'body-canonical-label'
    });
  }

  for (const line of (document.body?.innerText || '').split(/\n+/u)) {
    const text = compactWhitespace(line);
    if (!text) {
      continue;
    }

    const strictLineBreadcrumb = extractRightmostThreeDigitBreadcrumbLabel(text);
    if (strictLineBreadcrumb) {
      candidates.push({
        raw: strictLineBreadcrumb,
        score: 250,
        source: 'body-line-strict-breadcrumb-rightmost'
      });
      continue;
    }

    if (looksLikeCourseLabel(text)) {
      candidates.push({
        raw: text,
        score: 165,
        source: 'body-line-full-label'
      });
      continue;
    }

    const breadcrumbTail = extractCourseLabelFromBreadcrumb(text);
    if (breadcrumbTail) {
      candidates.push({
        raw: breadcrumbTail,
        score: 145,
        source: 'body-line-breadcrumb-tail'
      });
    }
  }

  return candidates;
}

function collectGenericSubjectCandidates() {
  const candidates = [];
  const selectorGroups = [
    {
      selector: 'h1, h2, h3, h4',
      score: 70,
      source: 'generic-heading'
    },
    {
      selector: [
        '[class*="page-title"]',
        '[class*="title"]',
        '[class*="subject"]',
        '[class*="course"]',
        '[aria-current="page"]'
      ].join(', '),
      score: 55,
      source: 'generic-title'
    }
  ];

  for (const group of selectorGroups) {
    for (const el of document.querySelectorAll(group.selector)) {
      if (!isElementReadable(el)) {
        continue;
      }

      const text = compactWhitespace(el.textContent || '');
      if (!text || !looksLikePotentialSubjectName(text)) {
        continue;
      }

      candidates.push({
        raw: text,
        score: group.score,
        source: group.source
      });
    }
  }

  return candidates;
}

function selectBestSubjectCandidateDetailed(candidates) {
  const bestByName = new Map();

  for (const candidate of candidates) {
    const cleaned = cleanSubjectNameCandidate(candidate?.raw || '');
    if (!cleaned || isWeakSubjectName(cleaned)) {
      continue;
    }

    let score = Number(candidate?.score || 0);
    score += scoreSubjectName(cleaned);

    const existing = bestByName.get(cleaned);
    if (!existing || score > existing.score) {
      bestByName.set(cleaned, {
        name: cleaned,
        score,
        source: String(candidate?.source || '').trim(),
        hasStrongCourseEvidence: hasStrongCourseCandidate(candidate, cleaned)
      });
    }
  }

  const sorted = Array.from(bestByName.values())
    .sort((a, b) => b.score - a.score || Number(b.hasStrongCourseEvidence) - Number(a.hasStrongCourseEvidence) || b.name.length - a.name.length || a.name.localeCompare(b.name, 'ja'));

  return sorted[0] || {
    name: '',
    score: 0,
    source: '',
    hasStrongCourseEvidence: false
  };
}

function hasStrongCourseCandidate(candidate, cleanedName) {
  const source = String(candidate?.source || '').trim();
  const raw = compactWhitespace(candidate?.raw || '');
  if (!cleanedName || isWeakSubjectName(cleanedName)) {
    return false;
  }

  if (/strict-breadcrumb-rightmost|strict-three-digit-label|canonical-label|full-label|breadcrumb-tail/u.test(source)) {
    return true;
  }

  if (extractStrictThreeDigitCourseLabel(raw) || extractRightmostThreeDigitBreadcrumbLabel(raw) || extractCanonicalCourseLabel(raw) || extractCourseLabelFromBreadcrumb(raw)) {
    return true;
  }

  return false;
}

function selectBestSubjectCandidate(candidates) {
  const bestByName = new Map();

  for (const candidate of candidates) {
    const cleaned = cleanSubjectNameCandidate(candidate?.raw || '');
    if (!cleaned || isWeakSubjectName(cleaned)) {
      continue;
    }

    let score = Number(candidate?.score || 0);
    score += scoreSubjectName(cleaned);

    const existing = bestByName.get(cleaned);
    if (!existing || score > existing.score) {
      bestByName.set(cleaned, {
        name: cleaned,
        score,
        source: candidate?.source || ''
      });
    }
  }

  const sorted = Array.from(bestByName.values())
    .sort((a, b) => b.score - a.score || b.name.length - a.name.length || a.name.localeCompare(b.name, 'ja'));

  return sorted[0]?.name || '';
}

function scoreSubjectName(name) {
  let score = 0;
  const text = compactWhitespace(name);

  if (text.length >= 4) score += 6;
  if (text.length >= 7) score += 4;
  if (/[ぁ-んァ-ヶ一-龠]/u.test(text)) score += 6;
  if (/入門|概論|基礎|初歩|はじめ|統計|政治|法学|英文法|スポートロジー|メディア/u.test(text)) score += 4;
  if (/^[0-9０-９]{2,3}\s+/u.test(text)) score -= 20;
  if (/(?:コース|学部|研究科|専攻|プログラム|資格取得に資する科目|基盤科目|外国語科目)$/u.test(text)) score -= 80;
  if (/第\s*\d+\s*回/u.test(text)) score -= 25;
  if (/^\d+$/.test(text)) score -= 20;

  return score;
}

function isElementReadable(el) {
  if (!el || !isVisible(el)) {
    return false;
  }

  const text = compactWhitespace(el.textContent || '');
  if (!text) {
    return false;
  }

  if (text.length > 200) {
    return false;
  }

  return true;
}

function extractEmbeddedCourseLabels(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return [];
  }

  const matches = [];
  const patterns = [
    /[0-9０-９]{2,4}\s*[^><\n\r]{1,100}?[（(][’'＇`\s]?[0-9０-９]{2}[)）]\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?/gu,
    /[0-9０-９]{2,4}\s*[^><\n\r]{1,100}?\([’'＇`\s]?[0-9０-９]{2}\)\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?/gu
  ];

  for (const pattern of patterns) {
    const found = normalized.match(pattern) || [];
    for (const item of found) {
      const trimmed = compactWhitespace(item);
      if (trimmed) {
        matches.push(trimmed);
      }
    }
  }

  return Array.from(new Set(matches));
}

function extractCanonicalCourseLabel(text) {
  const labels = extractEmbeddedCourseLabels(text);
  if (!labels.length) {
    return '';
  }
  return labels[labels.length - 1];
}

function extractSubjectTitleFromCourseLabel(label) {
  const normalized = compactWhitespace(label);
  if (!normalized) {
    return '';
  }

  const strictLabel = extractRightmostThreeDigitBreadcrumbLabel(normalized) || extractStrictThreeDigitCourseLabel(normalized) || normalized;
  const match = strictLabel.match(/^[0-9０-９]{3}\s*(.+?)\s*[（(][’'＇`\s]?[0-9０-９]{2}[)）]\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?$/u)
    || strictLabel.match(/^[0-9０-９]{3}\s*(.+)$/u)
    || strictLabel.match(/^[0-9０-９]{2,4}\s*(.+?)\s*[（(][’'＇`\s]?[0-9０-９]{2}[)）]\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?$/u);
  if (!match) {
    return '';
  }

  let title = compactWhitespace(match[1] || '');
  title = title
    .replace(/[（(][’'＇`\s]?[0-9０-９]{2}[)）]/gu, '')
    .replace(/\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?$/u, '')
    .trim();

  if (looksLikeThreeDigitBreadcrumbDirectory(title)) {
    return '';
  }

  return compactWhitespace(title);
}

function extractCourseLabelFromBreadcrumb(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return '';
  }

  const strictRightmost = extractRightmostThreeDigitBreadcrumbLabel(normalized);
  if (strictRightmost) {
    return strictRightmost;
  }

  const canonical = extractCanonicalCourseLabel(normalized);
  if (canonical) {
    return canonical;
  }

  const separators = /\s*(?:>|＞|›|»|\/|／)\s*/u;
  if (!separators.test(normalized)) {
    return '';
  }

  const parts = normalized.split(separators).map((part) => compactWhitespace(part)).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const embedded = extractCanonicalCourseLabel(part);
    if (embedded) {
      return embedded;
    }
    if (looksLikeCourseLabel(part)) {
      return part;
    }
  }

  return '';
}

function looksLikeCourseLabel(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (/^[0-9０-９]{2,4}\s+.+\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?$/u.test(normalized) && /[（(][’'＇`\s]?[0-9０-９]{2}[)）]/u.test(normalized)) {
    return true;
  }

  return /[（(][’'＇`\s]?[0-9０-９]{2}[)）]/u.test(normalized) && /\d{5,}$/u.test(normalized);
}

function looksLikePotentialSubjectName(text) {
  const normalized = compactWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (normalized.length < 2 || normalized.length > 80) {
    return false;
  }

  if (isWeakSubjectName(normalized)) {
    return false;
  }

  if (/^第\s*\d+\s*回/u.test(normalized)) {
    return false;
  }

  if (/^\d{2}:\d{2}:\d{2}$/u.test(normalized)) {
    return false;
  }

  if (/^(?:ホーム|ログアウト|動画検索|設定)$/u.test(normalized)) {
    return false;
  }

  if (looksLikeThreeDigitBreadcrumbDirectory(normalized)) {
    return false;
  }

  return true;
}

function cleanSubjectNameCandidate(text) {
  let value = compactWhitespace(text);
  if (!value) {
    return '';
  }

  const canonicalLabel = extractCanonicalCourseLabel(value) || extractCourseLabelFromBreadcrumb(value);
  if (canonicalLabel) {
    const titleFromLabel = extractSubjectTitleFromCourseLabel(canonicalLabel);
    if (titleFromLabel && !isWeakSubjectName(titleFromLabel)) {
      return titleFromLabel;
    }
    value = canonicalLabel;
  }

  value = value
    .replace(/^[0-9０-９]{2,4}\s+/u, '')
    .replace(/\s+[0-9０-９]{5,}[A-Za-zＡ-Ｚａ-ｚ]?$/u, '')
    .replace(/[（(][’'＇`\s]?[0-9０-９]{2}[)）]/gu, '')
    .replace(/【.*?】/gu, '')
    .replace(/^科目名[:：]\s*/u, '')
    .replace(/^番組名[:：]\s*/u, '')
    .trim();

  value = compactWhitespace(value);

  if (!value || isWeakSubjectName(value) || looksLikeThreeDigitBreadcrumbDirectory(value)) {
    return '';
  }

  return value;
}

function isWeakSubjectName(text) {
  const value = compactWhitespace(text);
  if (!value) {
    return true;
  }

  return /^(?:放送大学|WAKABA|動画|配信ページ(?:[（(].*[)）])?|未登録の配信ページ(?:[（(].*[)）])?|トップページ|ホーム)$/u.test(value)
    || /(?:コース|学部|研究科|専攻|プログラム|資格取得に資する科目|基盤科目|外国語科目)$/u.test(value);
}

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/gu, ' ').trim();
}
