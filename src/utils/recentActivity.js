const STORAGE_KEY = 'factoryScan_recentActivity';
const MAX_ENTRIES = 50;

export function logActivity(activity) {
  const existing = getRecentActivities();
  const entry = {
    ...activity,
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
  };
  const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch (e) {}
}

export function getRecentActivities() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) { return []; }
}

export function clearActivities() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}
