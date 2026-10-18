/**
 * Client-side API, storage, and browser history boundary helper for Krusch Companion.
 * Encapsulates external I/O and replaces silent catch blocks with debug observability.
 */

const SESSION_STORAGE_KEY = 'krusch_active_session_id';

export function logClientBoundaryWarning(context, err) {
  if (typeof window !== 'undefined' && window.__KRUSCH_DEBUG__) {
    console.debug(`[KruschCompanion:${context}]`, err?.message || err);
  }
}

export function readInitialSetupRoute() {
  try {
    const path = window.location.pathname || '';
    const params = new URLSearchParams(window.location.search);
    if (path === '/setup' || params.get('setup') === '1') {
      return true;
    }
  } catch (err) {
    logClientBoundaryWarning('readInitialSetupRoute', err);
  }
  return false;
}

export function readInitialActiveTab() {
  try {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (['companion', 'stream', 'dump', 'today', 'focus', 'memory'].includes(tab)) {
      return tab === 'dump' ? 'stream' : tab;
    }
  } catch (err) {
    logClientBoundaryWarning('readInitialActiveTab', err);
  }
  return 'companion';
}

export function readStoredSessionId(defaultId = 'default-session') {
  try {
    return localStorage.getItem(SESSION_STORAGE_KEY) || defaultId;
  } catch (err) {
    logClientBoundaryWarning('readStoredSessionId', err);
    return defaultId;
  }
}

export function writeStoredSessionId(sessionId) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch (err) {
    logClientBoundaryWarning('writeStoredSessionId', err);
  }
}

export function navigateToSetupRoute() {
  try {
    window.history.pushState({}, '', '/setup');
  } catch (err) {
    logClientBoundaryWarning('navigateToSetupRoute', err);
  }
}

export function clearSetupRouteInHistory() {
  try {
    if (window.location.pathname === '/setup' || window.location.search.includes('setup=')) {
      window.history.replaceState({}, '', '/');
    }
  } catch (err) {
    logClientBoundaryWarning('clearSetupRouteInHistory', err);
  }
}

export function sortIncompleteTasks(tasks = []) {
  const incomplete = (Array.isArray(tasks) ? tasks : []).filter(t => !t.completed);
  incomplete.sort((a, b) => {
    const epA = a.execution_priority || 3;
    const epB = b.execution_priority || 3;
    if (epA !== epB) return epA - epB;
    return (a.tier || 5) - (b.tier || 5);
  });
  return incomplete;
}

export async function fetchStreakCount() {
  try {
    const res = await fetch('/api/streak');
    if (res.ok) {
      const data = await res.json();
      return data?.streak || 0;
    }
  } catch (err) {
    logClientBoundaryWarning('fetchStreakCount', err);
  }
  return null;
}

export async function fetchIncompleteTasksSorted() {
  try {
    const res = await fetch('/api/tasks');
    if (res.ok) {
      const tasks = await res.json();
      return sortIncompleteTasks(tasks);
    }
  } catch (err) {
    logClientBoundaryWarning('fetchIncompleteTasksSorted', err);
  }
  return null;
}

export async function fetchOnboardingStatus() {
  try {
    const res = await fetch('/api/companion/onboarding');
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    logClientBoundaryWarning('fetchOnboardingStatus', err);
  }
  return null;
}

export async function markTaskComplete(taskId) {
  const res = await fetch(`/api/tasks/${taskId}/complete`, { method: 'PATCH' });
  return res.ok;
}
