// Discovery AI — Content script (CLICK, SCROLL, KEY, PASTE, TYPED_FLUSH; screenshots queued in service worker)
// Main frame only.

(function () {
  if (window !== window.top) return;
  if (window.__discoveryAIContentInitialized) return;
  window.__discoveryAIContentInitialized = true;

  const EXTENSION_VERSION = '2.2.5';

  try {
    console.log('[Discovery AI] Content script (limited events) on', location.href);
  } catch (e) {}

  let _keepalivePort = null;
  function _connectKeepalive() {
    try {
      _keepalivePort = chrome.runtime.connect({ name: 'discovery-ai-keepalive' });
      _keepalivePort.onDisconnect.addListener(function () {
        _keepalivePort = null;
        setTimeout(_connectKeepalive, 1000);
      });
    } catch (e) {}
  }
  _connectKeepalive();

  function post(message) {
    try {
      chrome.runtime.sendMessage(
        Object.assign(
          {
            source: 'discovery-ai-content',
            url: location.href,
            title: document.title,
            ts: Date.now(),
            extensionVersion: EXTENSION_VERSION
          },
          message
        )
      );
    } catch (e) {}
  }

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return { tag: null };
    const tag = el.tagName.toLowerCase();
    const id = el.id || null;
    const classes = el.className && typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 5) : [];
    const name = el.getAttribute('name') || null;
    const type = el.getAttribute('type') || null;
    const text = (el.innerText || '').trim().slice(0, 120);
    return { tag, id, classes, name, type, text };
  }

  function isSensitive(el) {
    if (!el) return false;
    const typ = (el.type || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    if (typ === 'password') return true;
    return /(^pass|secret|token|card_num|cvv|ssn|social_sec)/i.test(name);
  }

  function isTextTypingElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isSensitive(el)) return false;
    if (el.getAttribute && el.getAttribute('contenteditable') === 'true') return true;
    const tag = el.tagName.toLowerCase();
    const typ = (el.type || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      return ['text', 'search', 'email', 'url', 'tel', ''].indexOf(typ) !== -1;
    }
    return false;
  }

  function getPlainTextForSentence(el) {
    if (!el || isSensitive(el)) return null;
    try {
      if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
        return (el.innerText || el.textContent || '').slice(0, 8000);
      }
      const tag = el.tagName && el.tagName.toLowerCase();
      const typ = (el.type || '').toLowerCase();
      if (tag === 'textarea' || (tag === 'input' && ['text', 'search', 'email', 'url', 'tel', ''].indexOf(typ) !== -1)) {
        return String(el.value || '').slice(0, 8000);
      }
    } catch (e) {}
    return null;
  }

  const _sentenceSentUntil = new WeakMap();

  function emitTypedFlush(el, text, reason) {
    const t = String(text || '').trim();
    if (!t.length) return;
    const max = 800;
    const slice = t.length > max ? t.slice(0, max) + '…' : t;
    post({
      type: 'TYPED_FLUSH',
      data: {
        label: 'TextTyped',
        element: describeElement(el),
        text: slice,
        charCount: t.length,
        reason: reason || 'boundary'
      }
    });
  }

  function processSentenceInput(el) {
    const full = getPlainTextForSentence(el);
    if (full === null) return;
    let from = _sentenceSentUntil.get(el) || 0;
    if (from > full.length) from = 0;
    const s = full;
    let i = from;
    while (i < s.length) {
      const rest = s.slice(i);
      const punct = rest.match(/^([\s\S]{0,4000}?[.!?])(?=\s|$)/);
      if (punct && punct[1].trim().length > 0) {
        emitTypedFlush(el, punct[1], 'punctuation');
        i += punct[0].length;
        while (i < s.length && /\s/.test(s[i])) i++;
        continue;
      }
      const line = rest.match(/^([^\n\r]+)(\r\n|\r|\n)/);
      if (line && line[1].trim().length > 0) {
        emitTypedFlush(el, line[1], 'newline');
        i += line[0].length;
        continue;
      }
      break;
    }
    _sentenceSentUntil.set(el, i);
  }

  function flushPendingSentenceOnBlur(el) {
    const full = getPlainTextForSentence(el);
    if (full === null) return;
    let from = _sentenceSentUntil.get(el) || 0;
    if (from > full.length) from = 0;
    const tail = full.slice(from).trim();
    if (tail.length > 0) emitTypedFlush(el, tail, 'blur');
    _sentenceSentUntil.set(el, full.length);
  }

  // —— CLICK ——
  document.addEventListener(
    'click',
    function (e) {
      post({
        type: 'CLICK',
        data: {
          label: 'MouseClick',
          x: e.clientX,
          y: e.clientY,
          button: e.button,
          element: describeElement(e.target)
        }
      });
    },
    true
  );

  // —— SCROLL ——
  let lastScrollTs = 0;
  document.addEventListener(
    'scroll',
    function () {
      const t = Date.now();
      if (t - lastScrollTs < 300) return;
      lastScrollTs = t;
      post({
        type: 'SCROLL',
        data: {
          label: 'Scroll',
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          docHeight: document.documentElement.scrollHeight
        }
      });
    },
    { passive: true, capture: true }
  );

  // —— KEY (shortcuts + Backspace, Tab, Space, Enter, F-keys, arrows, etc.) ——
  document.addEventListener(
    'keydown',
    function (e) {
      if (e.repeat || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey || e.altKey;
      const key = e.key;

      if (mod && key && ['Control', 'Shift', 'Alt', 'Meta'].indexOf(key) === -1) {
        if ((e.ctrlKey || e.metaKey) && (key === 'v' || key === 'V')) return;

        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.metaKey) parts.push('Meta');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        parts.push(key.length === 1 ? key.toUpperCase() : key);
        post({
          type: 'KEY',
          data: {
            label: 'KeyPress',
            kind: 'shortcut',
            combo: parts.join('+'),
            code: e.code
          }
        });
        return;
      }
      if (mod) return;

      if (key === ' ' || e.code === 'Space') {
        post({ type: 'KEY', data: { label: 'KeyPress', kind: 'special', key: 'Space', code: e.code } });
        return;
      }

      if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
        post({ type: 'KEY', data: { label: 'KeyPress', kind: 'function', key, code: e.code } });
        return;
      }

      const special = {
        Backspace: 1,
        Tab: 1,
        Enter: 1,
        Escape: 1,
        ArrowUp: 1,
        ArrowDown: 1,
        ArrowLeft: 1,
        ArrowRight: 1,
        Home: 1,
        End: 1,
        PageUp: 1,
        PageDown: 1,
        Insert: 1,
        Delete: 1,
        ContextMenu: 1
      };
      if (special[key]) {
        post({ type: 'KEY', data: { label: 'KeyPress', kind: 'special', key, code: e.code } });
      }
    },
    true
  );

  // —— PASTE (Ctrl+V / paste) ——
  document.addEventListener(
    'paste',
    function (e) {
      try {
        const target = e.target;
        let pastedText = '';
        if (e.clipboardData) pastedText = e.clipboardData.getData('text/plain') || '';
        const sens = target && isSensitive(target);
        post({
          type: 'PASTE',
          data: {
            label: 'Paste',
            element: describeElement(target),
            pastedLength: pastedText.length,
            pastedPreview: sens ? '***' : pastedText.slice(0, 120),
            sensitive: sens
          }
        });
      } catch (err) {}
    },
    true
  );

  // —— TYPED_FLUSH ——
  document.addEventListener(
    'input',
    function (e) {
      const target = e.target;
      if (!target || !isTextTypingElement(target)) return;
      processSentenceInput(target);
    },
    true
  );

  document.addEventListener(
    'focusin',
    function (e) {
      const target = e.target;
      if (!target || target.nodeType !== 1) return;
      if (!isTextTypingElement(target)) return;
      const t = getPlainTextForSentence(target);
      if (t !== null) _sentenceSentUntil.set(target, t.length);
    },
    true
  );

  document.addEventListener(
    'focusout',
    function (e) {
      const target = e.target;
      if (!target || !isTextTypingElement(target)) return;
      flushPendingSentenceOnBlur(target);
    },
    true
  );
})();
