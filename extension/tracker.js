(function (root, factory) {
	if (typeof define === 'function' && define.amd) {
		define([], factory);
	} else if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.IntelliTracker = factory();
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// -------- Utilities --------
	function generateUuid() {
		// RFC4122 v4-ish UUID, good enough for client-side IDs
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
			var r = (Math.random() * 16) | 0;
			var v = c === 'x' ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
	}

	function now() {
		return Date.now();
	}

	function safeJsonStringify(value) {
		try {
			return JSON.stringify(value);
		} catch (e) {
			return '"[unserializable]"';
		}
	}

	function getDomPath(node, maxDepth) {
		try {
			var depth = 0;
			var parts = [];
			while (node && node.nodeType === 1 && depth < (maxDepth || 5)) {
				var name = node.nodeName.toLowerCase();
				var id = node.id ? '#' + node.id : '';
				var className = node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
				parts.unshift(name + id + className);
				node = node.parentNode;
				depth++;
			}
			return parts.join(' > ');
		} catch (e) {
			return 'unknown';
		}
	}

	function redactedValue(input) {
		var type = (input && input.type || '').toLowerCase();
		var name = (input && input.name || '').toLowerCase();
		var isSensitiveType = ['password', 'email', 'tel', 'number'].indexOf(type) !== -1;
		var looksSensitiveName = /(pass|secret|token|card|cc|ssn|email|phone)/i.test(name);
		if (isSensitiveType || looksSensitiveName) return '***';
		var val = (input && input.value) || '';
		if (typeof val !== 'string') return '***';
		return val.length > 64 ? val.slice(0, 64) + '…' : val;
	}

	function isSensitiveInput(input) {
		try {
			var type = (input && input.type || '').toLowerCase();
			var name = (input && input.name || '').toLowerCase();
			var isSensitiveType = ['password', 'email', 'tel', 'number'].indexOf(type) !== -1;
			var looksSensitiveName = /(pass|secret|token|card|cc|ssn|email|phone)/i.test(name);
			return isSensitiveType || looksSensitiveName;
		} catch (e) { return false; }
	}

	function on(target, event, handler, opts) {
		if (!target || !target.addEventListener) return function () {};
		target.addEventListener(event, handler, opts || false);
		return function () { try { target.removeEventListener(event, handler, opts || false); } catch (e) {} };
	}

	function loadScriptOnce(src, id) {
		return new Promise(function (resolve, reject) {
			if (id && document.getElementById(id)) return resolve();
			var s = document.createElement('script');
			if (id) s.id = id;
			s.async = true;
			s.src = src;
			s.onload = function () { resolve(); };
			s.onerror = function (e) { reject(e); };
			document.head.appendChild(s);
		});
	}

	// -------- Core Tracker --------
	var defaultConfig = {
		endpoint: '',
		apiKey: '',
		projectId: '',
		flushIntervalMs: 5000,
		maxBatchSize: 25,
		maxQueueBytes: 1_000_000,
		captureClicks: true,
		captureInputs: true,
		captureInputChanges: true,
		captureContentEditable: true,
		captureErrors: true,
		capturePerformance: true,
		captureNavigation: true,
		captureForms: true,
		captureFileUploads: true,
		captureScreenshots: true,
		screenshotIntervalMs: 5000,
		screenshotMaxWidth: 2400,
		screenshotQuality: 0.75, // optimized for good quality and smaller file size
		screenshotFormat: 'webp', // 'webp' | 'jpeg' | 'png'
		ocrMode: false, // when true, force PNG lossless and full device scale
		maxScale: 3, // higher cap for sharper OCR images
		activityHeartbeatMs: 15000,
		inactivityThresholdMs: 30000,
		respectDNT: false,
		sampleRate: 1.0
	};

	var state = {
		initialized: false,
		config: null,
		queue: [],
		queueBytes: 0,
		flushTimer: null,
		sessionId: null,
		userId: null,
		pageId: null,
		unsubscribers: [],
		screenshotTimer: null,
		lastUrl: null,
		lastActivityTs: 0,
		isIdle: false,
		heartbeatTimer: null,
		formStartTimes: typeof WeakMap !== 'undefined' ? new WeakMap() : new Map(),
		activeTimers: {}
	};

	function shouldRecord(config) {
		if (config.respectDNT && typeof navigator !== 'undefined' && navigator.doNotTrack === '1') return false;
		if (config.sampleRate >= 1) return true;
		return Math.random() < config.sampleRate;
	}

	function getOrCreateUserId() {
		try {
			var key = 'intelli_user_id';
			var existing = localStorage.getItem(key);
			if (existing) return existing;
			var created = generateUuid();
			localStorage.setItem(key, created);
			return created;
		} catch (e) {
			return generateUuid();
		}
	}

	function scheduleFlush() {
		if (state.flushTimer) return;
		state.flushTimer = setTimeout(flush, state.config.flushIntervalMs);
	}

	function enqueue(event) {
		var payload = {
			ts: now(),
			sessionId: state.sessionId,
			pageId: state.pageId,
			userId: state.userId,
			projectId: state.config.projectId || undefined,
			event: event
		};
		var json = safeJsonStringify(payload);
		state.queue.push(json);
		state.queueBytes += json.length;
		if (state.queue.length >= state.config.maxBatchSize || state.queueBytes >= state.config.maxQueueBytes) {
			flush();
		} else {
			scheduleFlush();
		}
	}

	function buildBatchBody() {
		var items = state.queue;
		state.queue = [];
		state.queueBytes = 0;
		var body = '[' + items.join(',') + ']';
		return body;
	}

	function flush() {
		if (!state.queue.length) {
			if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
			return;
		}
		if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }

		var body = buildBatchBody();
		var endpoint = state.config.endpoint;
		if (!endpoint) return; // nothing to send to

		try {
			if (navigator && navigator.sendBeacon) {
				var blob = new Blob([body], { type: 'application/json' });
				var headers = state.config.apiKey ? { 'x-api-key': state.config.apiKey } : null;
				// sendBeacon doesn't support setting headers; append apiKey as query if needed
				var url = endpoint;
				if (state.config.apiKey && url.indexOf('x-api-key=') === -1) {
					url += (url.indexOf('?') === -1 ? '?' : '&') + 'x-api-key=' + encodeURIComponent(state.config.apiKey);
				}
				navigator.sendBeacon(url, blob);
				return;
			}
		} catch (e) {}

		try {
			var headersObj = { 'content-type': 'application/json' };
			if (state.config.apiKey) headersObj['x-api-key'] = state.config.apiKey;
			// Avoid keepalive for large payloads
			fetch(endpoint, { method: 'POST', headers: headersObj, body: body, keepalive: true }).catch(function () {});
		} catch (e) {}
	}

	// -------- Capture Features --------
	function captureSessionStart() {
		enqueue({ type: 'session_start', data: { url: location.href, referrer: document.referrer, userAgent: navigator.userAgent } });
	}

	function captureSessionEnd() {
		enqueue({ type: 'session_end', data: { url: location.href } });
		flush();
	}

	function capturePageView() {
		state.pageId = generateUuid();
		state.lastUrl = location.href;
		enqueue({ type: 'page_view', data: { url: location.href, title: document.title, referrer: document.referrer } });
	}

	function captureNavigation(fromUrl, toUrl) {
		enqueue({ type: 'navigation', data: { from: fromUrl, to: toUrl } });
	}

	function installSpaListeners() {
		if (!state.config.captureNavigation) return function () {};
		var origPush = history.pushState;
		var origReplace = history.replaceState;
		function onChange() {
			var newUrl = location.href;
			if (newUrl === state.lastUrl) return;
			captureNavigation(state.lastUrl, newUrl);
			capturePageView();
		}
		history.pushState = function () {
			origPush.apply(history, arguments);
			onChange();
		};
		history.replaceState = function () {
			origReplace.apply(history, arguments);
			onChange();
		};
		var unPop = on(window, 'popstate', onChange);
		var unHash = on(window, 'hashchange', onChange);
		return function () {
			try { history.pushState = origPush; history.replaceState = origReplace; } catch (e) {}
			unPop(); unHash();
		};
	}

	function installClickListener() {
		if (!state.config.captureClicks) return function () {};
		return on(document, 'click', function (e) {
			try {
				var target = e.target;
				var path = getDomPath(target, 7);
				var text = (target && target.innerText) || '';
				text = text && text.length > 64 ? text.slice(0, 64) + '…' : text;
				enqueue({ type: 'click', data: { path: path, text: text } });
				// Button-specific tracking
				var tag = (target && target.tagName) || '';
				var type = (target && target.type) || '';
				var isButton = tag === 'BUTTON' || (tag === 'INPUT' && (type === 'button' || type === 'submit'));
				if (isButton) {
					enqueue({ type: 'button_click', data: { path: path, text: text } });
				}
			} catch (err) {}
		}, true);
	}

	function installInputListener() {
		if (!state.config.captureInputs) return function () {};
		return on(document, 'input', function (e) {
			try {
				var target = e.target;
				if (!target || !('value' in target)) return;
				var path = getDomPath(target, 7);
				var value = redactedValue(target);
				var dtype = (target.type || '').toLowerCase();
				var name = target.name || '';
				var redacted = isSensitiveInput(target);
				var selectedText;
				if (target.tagName === 'SELECT') {
					selectedText = target.options && target.selectedIndex >= 0 ? target.options[target.selectedIndex].text : undefined;
				}
				enqueue({ type: 'input', data: { path: path, value: value, inputType: dtype, name: name, redacted: redacted, selectedText: selectedText } });
			} catch (err) {}
		}, true);
	}

	function installChangeListener() {
		if (!state.config.captureInputChanges) return function () {};
		var unChange = on(document, 'change', function (e) {
			try {
				var target = e.target;
				if (!target) return;
				// Handle select, checkbox, radio, and generic changes
				var path = getDomPath(target, 7);
				var dtype = (target.type || '').toLowerCase();
				var name = target.name || '';
				var value;
				if (dtype === 'checkbox' || dtype === 'radio') {
					value = !!target.checked;
				} else if ('value' in target) {
					value = redactedValue(target);
				} else {
					value = undefined;
				}
				var redacted = isSensitiveInput(target);
				var selectedText;
				if (target.tagName === 'SELECT') {
					selectedText = target.options && target.selectedIndex >= 0 ? target.options[target.selectedIndex].text : undefined;
				}
				enqueue({ type: 'change', data: { path: path, value: value, inputType: dtype, name: name, redacted: redacted, selectedText: selectedText } });
			} catch (err) {}
		}, true);
		var unBlur = on(document, 'blur', function (e) {
			try {
				var target = e.target;
				if (!target || !('value' in target)) return;
				var path = getDomPath(target, 7);
				enqueue({ type: 'blur', data: { path: path } });
			} catch (err) {}
		}, true);
		return function () { unChange(); unBlur(); };
	}

	function installContentEditableListener() {
		if (!state.config.captureContentEditable) return function () {};
		return on(document, 'input', function (e) {
			try {
				var target = e.target;
				if (!target || target.getAttribute('contenteditable') !== 'true') return;
				var path = getDomPath(target, 7);
				var text = (target.innerText || '').slice(0, 256);
				enqueue({ type: 'contenteditable_input', data: { path: path, text: text } });
			} catch (err) {}
		}, true);
	}

	function installFileUploadListeners() {
		if (!state.config.captureFileUploads) return function () {};
		var unInput = on(document, 'change', function (e) {
			try {
				var target = e.target;
				if (!target || target.tagName !== 'INPUT') return;
				var type = (target.type || '').toLowerCase();
				if (type !== 'file') return;
				var files = (target.files && target.files.length) || 0;
				var summary = [];
				if (files && target.files) {
					for (var i = 0; i < target.files.length; i++) {
						var f = target.files[i];
						summary.push({ name: 'redacted', size: f.size, type: f.type || undefined });
					}
				}
				var path = getDomPath(target, 7);
				enqueue({ type: 'file_upload', data: { path: path, count: files, files: summary, redacted: true } });
			} catch (err) {}
		}, true);
		var unDrop = on(document, 'drop', function (e) {
			try {
				var dt = e.dataTransfer;
				if (!dt || !dt.files) return;
				var files = dt.files.length;
				var summary = [];
				for (var i = 0; i < dt.files.length; i++) {
					var f = dt.files[i];
					summary.push({ name: 'redacted', size: f.size, type: f.type || undefined });
				}
				var path = getDomPath(e.target, 7);
				enqueue({ type: 'file_drop', data: { path: path, count: files, files: summary, redacted: true } });
			} catch (err) {}
		}, true);
		return function () { unInput(); unDrop(); };
	}

	function installFormListener() {
		if (!state.config.captureForms) return function () {};
		var unFocusIn = on(document, 'focusin', function (e) {
			try {
				var el = e.target;
				if (!el) return;
				var form = el.closest ? el.closest('form') : null;
				if (form && !state.formStartTimes.get(form)) {
					state.formStartTimes.set(form, now());
				}
			} catch (err) {}
		}, true);
		var unInput = on(document, 'input', function (e) {
			try {
				var el = e.target;
				if (!el) return;
				var form = el.closest ? el.closest('form') : null;
				if (form && !state.formStartTimes.get(form)) {
					state.formStartTimes.set(form, now());
				}
			} catch (err) {}
		}, true);
		var unSubmit = on(document, 'submit', function (e) {
			try {
				var form = e.target;
				if (!form || form.tagName !== 'FORM') return;
				var path = getDomPath(form, 7);
				var fields = [];
				// Iterate simple controls only
				var elements = form.elements || [];
				for (var i = 0; i < elements.length; i++) {
					var el = elements[i];
					if (!el || !el.name) continue;
					var type = (el.type || '').toLowerCase();
					if (type === 'password') { fields.push({ name: el.name, value: '***', type: type, redacted: true }); continue; }
					if (type === 'file') { fields.push({ name: el.name, value: '[files]', type: type, redacted: true }); continue; }
					if (type === 'checkbox' || type === 'radio') {
						fields.push({ name: el.name, value: !!el.checked, type: type, redacted: false });
						continue;
					}
					if ('value' in el) {
						var red = isSensitiveInput(el);
						var selectedText;
						if (el.tagName === 'SELECT') { selectedText = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : undefined; }
						fields.push({ name: el.name, value: redactedValue(el), type: type, redacted: red, selectedText: selectedText });
					}
				}
				var action = form.action || '';
				var method = (form.method || 'GET').toUpperCase();
				var startedAt = state.formStartTimes.get(form) || null;
				var submissionDurationMs = startedAt ? (now() - startedAt) : null;
				enqueue({ type: 'form_submit', data: { path: path, action: action, method: method, fields: fields, submissionDurationMs: submissionDurationMs } });
			} catch (err) {}
		}, true);
		return function () { unFocusIn(); unInput(); unSubmit(); };
	}

	function startTimer(name, meta) {
		if (!name) return;
		var id = generateUuid();
		state.activeTimers[name] = { id: id, start: now(), meta: meta || {} };
		enqueue({ type: 'timer_start', data: { name: String(name), id: id, meta: meta || {} } });
		return id;
	}

	function endTimer(name, meta) {
		var t = state.activeTimers[name];
		if (!t) return;
		var durationMs = now() - t.start;
		enqueue({ type: 'timer_end', data: { name: String(name), id: t.id, durationMs: durationMs, meta: meta || t.meta || {} } });
		delete state.activeTimers[name];
		return durationMs;
	}

	function markActivity() {
		state.lastActivityTs = now();
		if (state.isIdle) {
			state.isIdle = false;
			enqueue({ type: 'active_resume', data: { at: state.lastActivityTs } });
		}
	}

	function installActivityListeners() {
		state.lastActivityTs = now();
		state.isIdle = false;
		var handlers = [
			on(document, 'mousemove', markActivity, true),
			on(document, 'mousedown', markActivity, true),
			on(document, 'keydown', markActivity, true),
			on(document, 'scroll', markActivity, true),
			on(document, 'touchstart', markActivity, true),
			on(window, 'focus', function () { enqueue({ type: 'window_focus', data: {} }); markActivity(); }),
			on(window, 'blur', function () { enqueue({ type: 'window_blur', data: {} }); })
		];
		return function () { for (var i = 0; i < handlers.length; i++) { try { handlers[i](); } catch (e) {} } };
	}

	function startHeartbeatLoop() {
		if (state.heartbeatTimer) return;
		var lastBeat = now();
		state.heartbeatTimer = setInterval(function () {
			try {
				var t = now();
				var sinceActivity = t - state.lastActivityTs;
				var wasIdle = state.isIdle;
				if (!state.isIdle && sinceActivity >= state.config.inactivityThresholdMs) {
					state.isIdle = true;
					enqueue({ type: 'inactive_start', data: { at: t } });
				}
				var delta = t - lastBeat;
				var activeMs = state.isIdle ? 0 : delta;
				var idleMs = state.isIdle ? delta : 0;
				enqueue({ type: 'heartbeat', data: { activeMs: activeMs, idleMs: idleMs, isIdle: state.isIdle } });
				lastBeat = t;
			} catch (e) {}
		}, state.config.activityHeartbeatMs);
	}

	function stopHeartbeatLoop() {
		if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
	}

	function installErrorListeners() {
		if (!state.config.captureErrors) return function () {};
		var unError = on(window, 'error', function (e) {
			try {
				var data = { message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno, stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined };
				enqueue({ type: 'error', data: data });
			} catch (err) {}
		});
		var unRej = on(window, 'unhandledrejection', function (e) {
			try {
				var reason = e && e.reason;
				var message = reason && (reason.message || String(reason));
				var stack = reason && reason.stack ? String(reason.stack).slice(0, 2000) : undefined;
				enqueue({ type: 'unhandledrejection', data: { message: message, stack: stack } });
			} catch (err) {}
		});
		return function () { unError(); unRej(); };
	}

	function capturePerformance() {
		if (!state.config.capturePerformance || !('performance' in window)) return;
		try {
			var nav = performance.getEntriesByType && performance.getEntriesByType('navigation');
			if (nav && nav[0]) {
				var n = nav[0];
				enqueue({ type: 'performance_navigation', data: {
					startTime: n.startTime,
					domContentLoaded: n.domContentLoadedEventEnd,
					loadEventEnd: n.loadEventEnd,
					responseEnd: n.responseEnd,
					requestStart: n.requestStart
				}});
			}
			var paints = performance.getEntriesByType && performance.getEntriesByType('paint');
			if (paints && paints.length) {
				for (var i = 0; i < paints.length; i++) {
					var p = paints[i];
					enqueue({ type: 'performance_paint', data: { name: p.name, startTime: p.startTime, duration: p.duration } });
				}
			}
		} catch (e) {}
	}

	function startScreenshotLoop() {
		if (!state.config.captureScreenshots) return;
		var ensureLib = function () {
			if (window.html2canvas) return Promise.resolve();
			return loadScriptOnce('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js', 'intelli_html2canvas');
		};
	        function takeOnce() {
            ensureLib().then(function () {
                try {
	                    var viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
	                    var viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
	                    var scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0;
	                    var scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;

	                    var scale = (window.devicePixelRatio || 1);
	                    var cappedScale = Math.max(1, Math.min(scale, state.config.ocrMode ? Math.max(2, state.config.maxScale || 2) : (state.config.maxScale || 2)));

	                    var target = document.documentElement;
	                    var opts = {
	                        logging: false,
	                        useCORS: true,
	                        allowTaint: true,
	                        foreignObjectRendering: true,
	                        backgroundColor: null,
	                        imageTimeout: 0,
	                        removeContainer: true,
	                        scale: cappedScale,
	                        // Capture only the currently visible viewport area
	                        x: scrollX,
	                        y: scrollY,
	                        width: viewportWidth,
	                        height: viewportHeight,
	                        windowWidth: viewportWidth,
	                        windowHeight: viewportHeight,
	                        scrollX: scrollX,
	                        scrollY: scrollY
	                    };

	                    var waitFonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
	                    waitFonts.then(function(){
	                        return new Promise(function(resolve){ requestAnimationFrame(function(){ requestAnimationFrame(resolve); }); });
	                    }).then(function(){
	                        return window.html2canvas(target, opts);
	                    }).then(function (canvas) {
                        try {
	                            var maxW = state.config.screenshotMaxWidth;
	                            if (canvas.width > maxW && !state.config.ocrMode) {
	                                var scaleDown = maxW / canvas.width;
	                                var cv = document.createElement('canvas');
	                                cv.width = Math.round(canvas.width * scaleDown);
	                                cv.height = Math.round(canvas.height * scaleDown);
	                                var ctx = cv.getContext('2d');
	                                ctx.drawImage(canvas, 0, 0, cv.width, cv.height);
	                                canvas = cv;
	                            }
	                            var format = (state.config.ocrMode ? 'png' : (state.config.screenshotFormat || 'webp'));
	                            var mime = (format === 'png') ? 'image/png' : (format === 'jpeg' ? 'image/jpeg' : 'image/webp');
	                            var quality = (format === 'png') ? undefined : (state.config.screenshotQuality || 0.75);
	                            var dataUrl = quality == null ? canvas.toDataURL(mime) : canvas.toDataURL(mime, quality);
                            enqueue({ type: 'screenshot', data: { dataUrl: dataUrl, width: canvas.width, height: canvas.height } });
                        } catch (e2) {}
	                    }).catch(function () {
                        // Fallback to full body capture if viewport capture fails
                        try {
	                            window.html2canvas(document.body, { logging: false, useCORS: true, allowTaint: true, foreignObjectRendering: true, backgroundColor: null, imageTimeout: 0, scale: cappedScale }).then(function (canvas) {
                                try {
	                                    var maxW = state.config.screenshotMaxWidth;
	                                    if (canvas.width > maxW && !state.config.ocrMode) {
	                                        var scaleDown = maxW / canvas.width;
	                                        var cv = document.createElement('canvas');
	                                        cv.width = Math.round(canvas.width * scaleDown);
	                                        cv.height = Math.round(canvas.height * scaleDown);
	                                        var ctx = cv.getContext('2d');
	                                        ctx.drawImage(canvas, 0, 0, cv.width, cv.height);
	                                        canvas = cv;
	                                    }
	                                    var format = (state.config.ocrMode ? 'png' : (state.config.screenshotFormat || 'webp'));
	                                    var mime = (format === 'png') ? 'image/png' : (format === 'jpeg' ? 'image/jpeg' : 'image/webp');
	                                    var quality = (format === 'png') ? undefined : (state.config.screenshotQuality || 0.75);
	                                    var dataUrl = quality == null ? canvas.toDataURL(mime) : canvas.toDataURL(mime, quality);
                                    enqueue({ type: 'screenshot', data: { dataUrl: dataUrl, width: canvas.width, height: canvas.height } });
                                } catch (e3) {}
                            });
                        } catch (e4) {}
                    });
                } catch (e) {}
            }).catch(function () {});
        }
		takeOnce();
		state.screenshotTimer = setInterval(takeOnce, state.config.screenshotIntervalMs);
	}

	function stopScreenshotLoop() {
		if (state.screenshotTimer) { clearInterval(state.screenshotTimer); state.screenshotTimer = null; }
	}

	// -------- Public API --------
	function init(userConfig) {
		if (state.initialized) return;
		var cfg = Object.assign({}, defaultConfig, userConfig || {});
		if (!shouldRecord(cfg)) return; // sampling or DNT
		state.config = cfg;
		state.sessionId = generateUuid();
		state.userId = getOrCreateUserId();
		state.pageId = generateUuid();
		state.initialized = true;

		// Listeners
		state.unsubscribers.push(
			installSpaListeners(),
			installClickListener(),
			installInputListener(),
			installChangeListener(),
			installContentEditableListener(),
			installFileUploadListeners(),
			installFormListener(),
			installActivityListeners(),
			installErrorListeners(),
			on(window, 'beforeunload', captureSessionEnd),
			on(document, 'visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); })
		);

		// Initial captures
		captureSessionStart();
		capturePageView();
		capturePerformance();
		startScreenshotLoop();
		startHeartbeatLoop();
	}

	function shutdown() {
		stopScreenshotLoop();
		stopHeartbeatLoop();
		for (var i = 0; i < state.unsubscribers.length; i++) { try { state.unsubscribers[i](); } catch (e) {} }
		state.unsubscribers = [];
		captureSessionEnd();
		state.initialized = false;
	}

	function identify(userId, traits) {
		try {
			if (userId) {
				state.userId = String(userId);
				try { localStorage.setItem('intelli_user_id', state.userId); } catch (e) {}
			}
			enqueue({ type: 'identify', data: { userId: state.userId, traits: traits || {} } });
		} catch (e) {}
	}

	function track(eventName, properties) {
		if (!eventName) return;
		enqueue({ type: 'event', data: { name: String(eventName), properties: properties || {} } });
	}

	function setProject(projectId) {
		state.config.projectId = projectId;
	}

	function forceFlush() { flush(); }

	return {
		init: init,
		shutdown: shutdown,
		identify: identify,
		track: track,
		setProject: setProject,
		flush: forceFlush,
		version: '0.2.0'
	};
});





