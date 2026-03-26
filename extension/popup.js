// Discovery AI — Popup: mandatory work email + department before telemetry is sent.

import { getEmployeeEmailPrefs, setEmployeeEmailPrefs, isExtensionSetupComplete } from './storage-email.js';

const BACKEND_BASE_URL = 'https://web-plugin.onrender.com';

const anonIdEl = document.getElementById('anonId');
const backendStatusEl = document.getElementById('backendStatus');
const employeeIdInput = document.getElementById('employeeId');
const departmentInput = document.getElementById('department');
const saveEmployeeBtn = document.getElementById('saveEmployeeBtn');
const savedMsg = document.getElementById('savedMsg');
const errMsg = document.getElementById('errMsg');
const employeeDisplay = document.getElementById('employeeDisplay');
const setupForm = document.getElementById('setupForm');
const lockedBlock = document.getElementById('lockedBlock');
const emailLocked = document.getElementById('emailLocked');
const deptLocked = document.getElementById('deptLocked');
const statusPill = document.getElementById('statusPill');

function getTrackerId() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get_tracker_id' }, (res) => {
      resolve(res?.trackerUserId || null);
    });
  });
}

async function checkBackend() {
  try {
    const r = await fetch(`${BACKEND_BASE_URL}/api/collect/remote-commands?x-api-key=discovery_ext_7Kp9Xb2Q&trackerUserId=test`, {
      headers: { 'x-api-key': 'discovery_ext_7Kp9Xb2Q' }
    });
    backendStatusEl.textContent = r.ok ? 'Connected' : `Error (${r.status})`;
    backendStatusEl.style.color = r.ok ? '#4ade80' : '#f87171';
  } catch {
    backendStatusEl.textContent = 'Offline';
    backendStatusEl.style.color = '#f87171';
  }
}

function setStatusPill(complete) {
  statusPill.className = 'status-pill ' + (complete ? 'active' : 'warn');
  statusPill.innerHTML = complete
    ? '<span class="dot"></span><span>Tracking Active</span>'
    : '<span>Complete setup below to send telemetry</span>';
}

async function loadEmployeeId() {
  const prefs = await getEmployeeEmailPrefs();
  const val = (prefs.employeeIdentifier || '').trim();
  const dept = (prefs.department || '').trim();
  const locked = !!prefs.employeeIdentifierLocked;
  const complete = isExtensionSetupComplete(prefs);

  setStatusPill(complete);
  employeeDisplay.textContent = val && dept ? `${val} · ${dept}` : val || 'Not set';

  if (locked && val && dept) {
    setupForm.classList.add('hidden');
    lockedBlock.classList.remove('hidden');
    emailLocked.textContent = val;
    deptLocked.textContent = dept;
  } else {
    setupForm.classList.remove('hidden');
    lockedBlock.classList.add('hidden');
    employeeIdInput.value = val;
    departmentInput.value = dept;
  }
}

function showErr(msg) {
  errMsg.textContent = msg || '';
  errMsg.classList.toggle('show', !!msg);
}

async function saveEmployeeId() {
  showErr('');
  const email = employeeIdInput.value.trim();
  const dept = departmentInput.value.trim();

  if (!email || !email.includes('@')) {
    showErr('Enter a valid work email.');
    return;
  }
  if (!dept) {
    showErr('Department is required.');
    return;
  }

  saveEmployeeBtn.disabled = true;
  try {
    await setEmployeeEmailPrefs(email, dept, true);
    employeeDisplay.textContent = `${email} · ${dept}`;
    setupForm.classList.add('hidden');
    lockedBlock.classList.remove('hidden');
    emailLocked.textContent = email;
    deptLocked.textContent = dept;
    savedMsg.classList.add('show');
    setStatusPill(true);
    setTimeout(() => savedMsg.classList.remove('show'), 3000);
  } catch (e) {
    showErr('Could not save. Try again.');
  } finally {
    saveEmployeeBtn.disabled = false;
  }
}

async function init() {
  chrome.runtime.sendMessage({ type: 'clear_badge' });

  await loadEmployeeId();

  const trackerId = await getTrackerId();
  if (trackerId) {
    anonIdEl.textContent = trackerId.slice(0, 8) + '...' + trackerId.slice(-4);
    anonIdEl.title = trackerId;
  }

  checkBackend();
  saveEmployeeBtn.addEventListener('click', () => saveEmployeeId());
}

init();
