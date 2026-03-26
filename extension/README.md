## Discovery AI Browser Extension

This folder contains the **Discovery AI** WebExtension – a full browser activity tracker that runs in Chrome-compatible browsers (and other MV3-compatible browsers).

### What it tracks

- **Pages & tabs**: URLs, titles, tab creation/close, updates, window focus/blur, and how long each tab is active.
- **User actions**: Clicks, inputs, field changes, form submissions, scrolls, visibility changes, window focus/blur, and periodic page heartbeats.
- **Screenshots**: 
  - Every ~10 seconds for the currently active tab.
  - Whenever the active tab changes, a window gains focus, the page loads, or a form is submitted.
- **Storage**: Events (including screenshots as data URLs) are kept in `chrome.storage.local` under the `discoveryAIEvents` key (capped to the most recent ~5000 events).

Inputs that look sensitive (passwords, obvious secrets, card numbers, etc.) are **redacted to `"***"`** in the recorded data for safety.

### Files

- `manifest.json` – MV3 manifest for the Discovery AI extension.
- `service-worker.js` – Background service worker that aggregates events across tabs and captures screenshots.
- `content-script.js` – Runs in every page and streams detailed user actions to the service worker.
- `tracker.js` – Legacy IntelliTracker library (optional; currently not required by Discovery AI).

### Loading in Chrome / Edge

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose this `extension` folder.

Once loaded and enabled, Discovery AI will begin tracking activity on all pages that match `<all_urls>` as defined in `manifest.json`.


