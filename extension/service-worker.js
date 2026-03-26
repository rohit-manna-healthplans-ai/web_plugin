// Discovery AI — Service Worker (SWITCH, CLICK, SCROLL, KEY, PASTE, TYPED_FLUSH + USER_LOGGED_IN / USER_LOGGED_OUT)
// Screenshots only for Lovable hosts; all sites still emit interaction logs.

import { getEmployeeEmailPrefs, isExtensionSetupComplete } from './storage-email.js';

const EXTENSION_VERSION = '2.2.5';
const KEEPALIVE_ALARM_NAME = 'discovery_ai_keepalive';
const BACKEND_BASE_URL = 'https://web-plugin.onrender.com';
const EXT_API_KEY = 'discovery_ext_7Kp9Xb2Q';
const FLUSH_INTERVAL_MS = 5000;

const ALLOWED_CONTENT_TYPES = {
  CLICK: 1,
  SCROLL: 1,
  KEY: 1,
  PASTE: 1,
  TYPED_FLUSH: 1
};

/** Session events: no screenshot (plugin “starts” after login). */
function shouldCaptureScreenshotForType(type) {
  return type === 'SWITCH' || type === 'CLICK' || type === 'SCROLL' || type === 'KEY' || type === 'PASTE' || type === 'TYPED_FLUSH';
}

/**
 * Hosts where we allow captureVisibleTab (Lovable product + subdomains).
 * Keep in sync with how users open the app (app.lovable.com, *.lovable.app, etc.).
 */
function isLovableScreenshotUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === 'lovable.app' || h === 'lovable.dev' || h === 'lovable.com') return true;
    if (
      h.endsWith('.lovable.app') ||
      h.endsWith('.lovable.dev') ||
      h.endsWith('.lovable.com')
    ) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/** If true, do not trust e.url for allow/deny — let _runCapture use the real tab URL. */
function isAmbiguousPageUrlForScreenshot(url) {
  if (!url || typeof url !== 'string') return true;
  const u = url.trim().toLowerCase();
  if (
    u.startsWith('about:') ||
    u.startsWith('chrome://') ||
    u.startsWith('chrome-extension://') ||
    u.startsWith('edge://') ||
    u.startsWith('moz-extension://') ||
    u.startsWith('blob:') ||
    u.startsWith('data:')
  ) {
    return true;
  }
  if (!/^https?:\/\//.test(u)) return true;
  return false;
}

function getClientExtensionMeta() {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    let browserName = 'Chromium';
    if (/Edg\//.test(ua)) browserName = 'Microsoft Edge';
    else if (/OPR\/|Opera/.test(ua)) browserName = 'Opera';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browserName = 'Chrome';
    else if (/Firefox\//.test(ua)) browserName = 'Firefox';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browserName = 'Safari';
    let os = '';
    if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    else if (/Android/.test(ua)) os = 'Android';
    return {
      browserName,
      ...(os ? { os } : {}),
      userAgent: ua.slice(0, 512),
      extensionVersion: EXTENSION_VERSION
    };
  } catch (_) {
    return { extensionVersion: EXTENSION_VERSION };
  }
}

console.log('[Discovery AI] Service worker loaded — telemetry + Lovable-only screenshots. Backend:', BACKEND_BASE_URL);

const eventBuffer = [];
const pendingEvents = [];
let flushTimer = null;
let currentSessionId = null;
let currentPageId = null;
let sessionStartedAt = null;

let _trackingStateLoaded = false;
const _bufferedContentMessages = [];

let _captureInProgress = false;
const _captureQueue = [];

(async () => {
  try {
    const r = await fetch(`${BACKEND_BASE_URL}/api/collect/remote-commands?x-api-key=${EXT_API_KEY}&trackerUserId=test`, {
      headers: { 'x-api-key': EXT_API_KEY }
    });
    console.log('[Discovery AI] Backend reachable. Status:', r.status);
  } catch (e) {
    console.warn('[Discovery AI] Backend NOT reachable:', e.message);
  }
})();

function ensureAnonymousId() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ trackerUserId: null }, (res) => {
      if (res.trackerUserId) {
        resolve(res.trackerUserId);
      } else {
        const id = crypto.randomUUID();
        chrome.storage.local.set({ trackerUserId: id }, () => resolve(id));
      }
    });
  });
}

function isSameCalendarDay(ts1, ts2) {
  return new Date(ts1).toDateString() === new Date(ts2).toDateString();
}

function now() {
  return Date.now();
}

function isSessionActive() {
  return !!currentSessionId;
}

function queueScreenshotForEvent(triggerType, tabId, eventUrl, eventTitle, screenshotId) {
  if (!isSessionActive() || !screenshotId) return;
  if (_captureQueue.length >= 40) _captureQueue.splice(0, _captureQueue.length - 20);
  _captureQueue.push({ triggerType, tabId, eventUrl, eventTitle, screenshotId });
  _processNextCapture();
}

function _processNextCapture() {
  if (_captureInProgress || _captureQueue.length === 0) return;
  _captureInProgress = true;
  const entry = _captureQueue.shift();
  _runCapture(entry);
}

function _runCapture(entry) {
  const { triggerType, tabId, eventUrl, eventTitle, screenshotId } = entry;
  const sid = screenshotId;

  const afterCapture = (dataUrl, tab) => {
    _captureInProgress = false;
    if (dataUrl && dataUrl.startsWith('data:image/')) {
      const url = eventUrl || tab?.url || '';
      const title = eventTitle || tab?.title || '';
      const tid = tab?.id;
      const shot = {
        ts: now(),
        version: EXTENSION_VERSION,
        type: 'screenshot',
        force: true,
        screenshotId: sid,
        tabId: tid,
        url,
        title,
        data: { dataUrl, url, title, tabId: tid, screenshotId: sid, reason: triggerType }
      };
      eventBuffer.push(shot);
      pendingEvents.push(shot);
      flushEventsToBackend();
    }
    _processNextCapture();
  };

  const tryTab = (tab) => {
    if (!tab || !tab.id) {
      afterCapture(null, null);
      return;
    }
    const u = tab.url || '';
    if (u.startsWith('chrome://') || u.startsWith('chrome-extension://') || u.startsWith('edge://')) {
      afterCapture(null, tab);
      return;
    }
    if (u && !isLovableScreenshotUrl(u)) {
      afterCapture(null, tab);
      return;
    }
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.warn('[Discovery AI] captureVisibleTab:', triggerType, chrome.runtime.lastError.message);
        afterCapture(null, tab);
        return;
      }
      afterCapture(dataUrl, tab);
    });
  };

  if (tabId != null) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => tryTab(tabs && tabs[0]));
      } else {
        tryTab(tab);
      }
    });
  } else {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => tryTab(tabs && tabs[0]));
  }
}

function logEvent(event) {
  if (!currentSessionId && !event.force) return;

  const e = Object.assign({ ts: now(), version: EXTENSION_VERSION }, event);
  delete e.kind;

  const needShot = shouldCaptureScreenshotForType(e.type);
  let willCapture = needShot;
  // Only skip when we have a real https URL that is clearly not Lovable.
  // about:blank / missing url / SPA edge cases defer to _runCapture (uses actual tab URL).
  if (
    willCapture &&
    e.url &&
    !isAmbiguousPageUrlForScreenshot(e.url) &&
    !isLovableScreenshotUrl(e.url)
  ) {
    willCapture = false;
  }

  if (!needShot) {
    delete e.screenshotId;
  } else if (!willCapture) {
    delete e.screenshotId;
  } else if (!e.screenshotId) {
    e.screenshotId = crypto.randomUUID();
  }

  try {
    console.log('[Discovery AI event]', 'type=', e.type || '(none)', 'shotId=', e.screenshotId || '(none)', 'url=', e.url || '(no url)');
  } catch (_) {}

  eventBuffer.push(e);
  pendingEvents.push(e);
  scheduleFlush();

  if (willCapture && e.screenshotId) {
    queueScreenshotForEvent(e.type, e.tabId, e.url, e.title, e.screenshotId);
  }

  chrome.storage.local.get({ discoveryAIEvents: [] }, (res) => {
    const arr = res.discoveryAIEvents || [];
    const toStore = { ...e };
    if (toStore.dataUrl) delete toStore.dataUrl;
    if (toStore.data && toStore.data.dataUrl) {
      toStore.data = { ...toStore.data };
      delete toStore.data.dataUrl;
    }
    if (e.type === 'screenshot') {
      toStore.data = { ...(toStore.data || {}), dataUrl: '[omitted]' };
    }
    arr.push(toStore);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    chrome.storage.local.set({ discoveryAIEvents: arr });
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushEventsToBackend();
  }, FLUSH_INTERVAL_MS);
}

async function flushEventsToBackend() {
  if (pendingEvents.length === 0) return;

  const eventsToSend = [...pendingEvents];
  pendingEvents.length = 0;

  const trackerRes = await new Promise((resolve) => {
    chrome.storage.local.get({ trackerUserId: null }, resolve);
  });
  const trackerUserId = trackerRes.trackerUserId;
  if (!trackerUserId) {
    console.warn('[Discovery AI] No trackerUserId, re-queuing events');
    pendingEvents.unshift(...eventsToSend);
    return;
  }

  let prefs;
  try {
    prefs = await getEmployeeEmailPrefs();
  } catch (_) {
    prefs = {};
  }
  if (!isExtensionSetupComplete(prefs)) {
    console.warn('[Discovery AI] Work email + department required in extension popup; holding events');
    pendingEvents.unshift(...eventsToSend);
    return;
  }
  const employeeIdentifier = (prefs.employeeIdentifier || '').trim() || undefined;
  const department = (prefs.department || '').trim();
  const extensionMeta = { ...getClientExtensionMeta(), department };

  const effectiveSessionId = currentSessionId || `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const effectivePageId = currentPageId || `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const batch = eventsToSend.map((e) => {
      const eventData = {
        ...(e.data || {}),
        ...(e.dataUrl ? { dataUrl: e.dataUrl } : {}),
        ...(e.tabId != null ? { tabId: e.tabId } : {}),
        ...(e.url ? { url: e.url } : {}),
        ...(e.title ? { title: e.title } : {}),
        ...(e.totalActiveMs !== undefined ? { totalActiveMs: e.totalActiveMs } : {}),
        ...(e.status ? { status: e.status } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.screenshotId != null ? { screenshotId: e.screenshotId } : {})
      };

      if (e.type === 'screenshot' && e.data && e.data.dataUrl) {
        eventData.dataUrl = e.data.dataUrl;
      }

      const item = {
        ts: e.ts || Date.now(),
        sessionId: effectiveSessionId,
        pageId: effectivePageId,
        screenshotId: e.screenshotId != null ? e.screenshotId : null,
        userId: trackerUserId,
        projectId: 'discovery-ai',
        extensionMeta,
        event: {
          type: e.type || 'unknown',
          data: Object.keys(eventData).length > 0 ? eventData : null
        }
      };
    if (employeeIdentifier) item.employeeIdentifier = employeeIdentifier;
    return item;
  });

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/collect?x-api-key=${EXT_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': EXT_API_KEY },
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      console.warn('[Discovery AI] Backend returned', response.status);
      pendingEvents.unshift(...eventsToSend);
    } else {
      console.log(`[Discovery AI] Sent ${batch.length} events`);
    }
  } catch (error) {
    console.warn('[Discovery AI] Flush error:', error.message);
    pendingEvents.unshift(...eventsToSend);
  }
}

function saveTrackingState() {
  chrome.storage.local.set({
    trackingState: {
      sessionId: currentSessionId,
      pageId: currentPageId,
      sessionStartedAt
    }
  });
}

function autoStartSession() {
  if (currentSessionId && sessionStartedAt && isSameCalendarDay(sessionStartedAt, Date.now())) {
    console.log('[Discovery AI] Session already active:', currentSessionId);
    return;
  }

  currentSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  currentPageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  sessionStartedAt = Date.now();
  saveTrackingState();

  logEvent({
    type: 'USER_LOGGED_IN',
    data: {
      label: 'User Logged In',
      sessionStartedAt,
      calendarDay: new Date(sessionStartedAt).toDateString()
    },
    force: true
  });

  console.log('[Discovery AI] Session started (USER_LOGGED_IN):', currentSessionId);
}

function ensureSessionForToday() {
  if (!currentSessionId || !sessionStartedAt) {
    autoStartSession();
    return;
  }
  if (isSameCalendarDay(sessionStartedAt, Date.now())) return;

  logEvent({
    type: 'USER_LOGGED_OUT',
    data: {
      label: 'User Logged Out',
      reason: 'new_calendar_day',
      previousSessionStartedAt: sessionStartedAt
    },
    force: true
  });

  currentSessionId = null;
  currentPageId = null;
  sessionStartedAt = null;
  saveTrackingState();
  autoStartSession();
}

function loadTrackingState() {
  chrome.storage.local.get({ trackingState: null }, (res) => {
    const s = res.trackingState;
    if (s && s.sessionId && s.sessionStartedAt) {
      const startedAt = s.sessionStartedAt;
      if (isSameCalendarDay(startedAt, Date.now())) {
        currentSessionId = s.sessionId;
        currentPageId = s.pageId || `page_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        sessionStartedAt = startedAt;
        console.log('[Discovery AI] Restored session:', currentSessionId);
      }
    }
    ensureSessionForToday();
    _trackingStateLoaded = true;

    while (_bufferedContentMessages.length > 0) {
      const { message, sender } = _bufferedContentMessages.shift();
      handleContentScriptMessage(message, sender);
    }
  });
}
loadTrackingState();

chrome.runtime.onInstalled.addListener(async (details) => {
  const anonId = await ensureAnonymousId();
  console.log('[Discovery AI] Installed/updated. Anonymous ID:', anonId, 'Reason:', details.reason);

  chrome.storage.local.set({ discoveryAIEvents: [] });
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.25 });
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Discovery AI] Browser startup detected');
  await ensureAnonymousId();
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.25 });
  loadTrackingState();
  setTimeout(() => {
    if (!currentSessionId) autoStartSession();
  }, 500);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  ensureSessionForToday();
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    flushEventsToBackend();
    if (!currentSessionId) autoStartSession();
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!isSessionActive()) return;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://')) {
      return;
    }
    logEvent({
      type: 'SWITCH',
      force: true,
      tabId: tab.id,
      url,
      title: tab.title || '',
      data: {
        label: 'ActiveWindow',
        previousTabId: activeInfo.previousTabId,
        windowId: activeInfo.windowId
      }
    });
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'discovery-ai-keepalive') return;
  port.onDisconnect.addListener(() => {});
});

function handleContentScriptMessage(message, sender) {
  if (!_trackingStateLoaded) {
    _bufferedContentMessages.push({ message, sender });
    return;
  }

  if (!message || message.source !== 'discovery-ai-content') return;
  if (!ALLOWED_CONTENT_TYPES[message.type]) return;
  if (!isSessionActive()) return;

  const tabId = sender && sender.tab && sender.tab.id;
  logEvent({
    type: message.type,
    tabId: tabId != null ? tabId : undefined,
    url: message.url,
    title: message.title,
    data: message.data || null
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'clear_badge') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse && sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'get_tracker_id') {
    chrome.storage.local.get({ trackerUserId: null }, (res) => {
      try {
        sendResponse({ trackerUserId: res.trackerUserId || null });
      } catch (_) {}
    });
    return true;
  }

  if (message.type === 'get_tracking_state') {
    sendResponse({
      active: isSessionActive(),
      sessionId: currentSessionId,
      sessionStartedAt,
      eventBufferSize: eventBuffer.length
    });
    return true;
  }

  if (message.source === 'discovery-ai-content') {
    handleContentScriptMessage(message, sender);
    sendResponse && sendResponse({ ok: true });
    return true;
  }

  return false;
});
