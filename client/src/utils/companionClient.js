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

export const VALID_COMPANION_TABS = [
  'companion',
  'stream',
  'dump',
  'today',
  'focus',
  'memory',
  'extensions'
];

export function sanitizeSessionId(sessionId, defaultId = 'default-session') {
  const cleaned = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 128);
  return cleaned || defaultId;
}

export function readInitialActiveTab(validTabs = VALID_COMPANION_TABS) {
  try {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab');
    if (Array.isArray(validTabs) && validTabs.includes(tab)) {
      return tab === 'dump' ? 'stream' : tab;
    }
  } catch (err) {
    logClientBoundaryWarning('readInitialActiveTab', err);
  }
  return 'companion';
}

export function readStoredSessionId(defaultId = 'default-session') {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return sanitizeSessionId(raw, defaultId);
  } catch (err) {
    logClientBoundaryWarning('readStoredSessionId', err);
    return defaultId;
  }
}

export function writeStoredSessionId(sessionId) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sanitizeSessionId(sessionId));
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

export async function fetchStreakCount({ signal } = {}) {
  try {
    const res = await fetch('/api/streak', signal ? { signal } : undefined);
    if (res.ok) {
      const data = await res.json();
      return data?.streak || 0;
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      logClientBoundaryWarning('fetchStreakCount', err);
    }
  }
  return null;
}

export async function fetchIncompleteTasksSorted({ signal } = {}) {
  try {
    const res = await fetch('/api/tasks', signal ? { signal } : undefined);
    if (res.ok) {
      const tasks = await res.json();
      return sortIncompleteTasks(tasks);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      logClientBoundaryWarning('fetchIncompleteTasksSorted', err);
    }
  }
  return null;
}

export async function fetchOnboardingStatus({ signal } = {}) {
  try {
    const res = await fetch('/api/companion/onboarding', signal ? { signal } : undefined);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      logClientBoundaryWarning('fetchOnboardingStatus', err);
    }
  }
  return null;
}

const VALID_TASK_ID_REGEX = /^(?:\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[a-zA-Z0-9_-]{1,64})$/;

export function validateTaskId(taskId) {
  if (taskId === null || taskId === undefined || typeof taskId === 'object' || typeof taskId === 'boolean') {
    throw new Error('Invalid taskId: must be a numeric ID, UUID, or safe identifier');
  }
  const normalized = String(taskId).trim();
  if (!normalized || !VALID_TASK_ID_REGEX.test(normalized)) {
    throw new Error(`Invalid taskId format: ${String(taskId)}`);
  }
  return encodeURIComponent(normalized);
}

export async function markTaskComplete(taskId, { fetchImpl = fetch } = {}) {
  const encodedId = validateTaskId(taskId);
  const res = await fetchImpl(`/api/tasks/${encodedId}/complete`, { method: 'PATCH' });
  return Boolean(res && res.ok);
}

export async function fetchGoogleHomeSetupGuide() {
  try {
    const res = await fetch('/api/companion/google-home');
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    logClientBoundaryWarning('fetchGoogleHomeSetupGuide', err);
  }
  return null;
}

export async function sendGoogleHomeVoiceTurn({ prompt, room = 'Kitchen', castReply = true } = {}) {
  try {
    const res = await fetch('/api/companion/google-home', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, room, castReply })
    });
    return await res.json();
  } catch (err) {
    logClientBoundaryWarning('sendGoogleHomeVoiceTurn', err);
    return { ok: false, error: err.message };
  }
}

export async function announceOnGoogleHome({ text, room = 'Kitchen' } = {}) {
  try {
    const res = await fetch('/api/companion/google-home/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, room })
    });
    return await res.json();
  } catch (err) {
    logClientBoundaryWarning('announceOnGoogleHome', err);
    return { ok: false, error: err.message };
  }
}

