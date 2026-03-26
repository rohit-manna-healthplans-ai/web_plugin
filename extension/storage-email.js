/**
 * Extension profile: work email + department (mandatory after save). Sync + local.
 */

const DEFAULTS = {
  employeeIdentifier: '',
  department: '',
  employeeIdentifierLocked: false
};

export function getEmployeeEmailPrefs() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (syncRes) => {
      if (chrome.runtime.lastError) {
        syncRes = { ...DEFAULTS };
      }
      chrome.storage.local.get(DEFAULTS, (localRes) => {
        const email = (syncRes.employeeIdentifier || localRes.employeeIdentifier || '').trim();
        const department = (syncRes.department || localRes.department || '').trim();
        const locked = !!(syncRes.employeeIdentifierLocked || localRes.employeeIdentifierLocked);
        if (email && !syncRes.employeeIdentifier && localRes.employeeIdentifier) {
          chrome.storage.sync.set({
            employeeIdentifier: localRes.employeeIdentifier.trim(),
            department: (localRes.department || '').trim(),
            employeeIdentifierLocked: !!localRes.employeeIdentifierLocked
          });
        }
        resolve({
          employeeIdentifier: email,
          department,
          employeeIdentifierLocked: locked
        });
      });
    });
  });
}

/**
 * Save email + department together; lock prevents further edits from popup.
 */
export function setEmployeeEmailPrefs(email, department, locked) {
  return new Promise((resolve) => {
    const payload = {
      employeeIdentifier: String(email || '').trim(),
      department: String(department || '').trim(),
      employeeIdentifierLocked: !!locked
    };
    chrome.storage.sync.set(payload, () => {
      chrome.storage.local.set(payload, resolve);
    });
  });
}

/** True when user completed mandatory setup (email looks like email, department non-empty, saved). */
export function isExtensionSetupComplete(prefs) {
  if (!prefs || !prefs.employeeIdentifierLocked) return false;
  const em = (prefs.employeeIdentifier || '').trim();
  const dept = (prefs.department || '').trim();
  if (!dept) return false;
  if (!em.includes('@')) return false;
  return true;
}
