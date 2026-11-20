// The only place that talks to /api. A 401 sends the user to the login page and comes back here afterwards.
// Nothing touches window/document at import time (the shell test imports this under Node).

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  // mutating routes require a JSON content type (CSRF check), even without a body
  const headers = method === 'GET' ? {} : { 'content-type': 'application/json' };
  const res = await fetch(path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
    return new Promise(() => {}); // the page is leaving; callers keep their skeleton instead of flashing an error
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  return data;
}

// query string without null or undefined values; arrays are comma-joined
function q(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) s.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
const put = (path, body) => api(path, { method: 'PUT', body });
const del = (path, body) => api(path, { method: 'DELETE', body });
const refresh = (r) => (r ? { refresh: 1 } : {});

export const getState = () => api('/api/state');
export const sendCommand = (tid, name, on) => post(`/api/tracker/${tid}/command`, { name, on });
export const setPowerMode = (tid, mode) => put(`/api/tracker/${tid}/power-mode`, { mode });
export const setLiveTimeout = (tid, seconds) => put(`/api/tracker/${tid}/live-timeout`, { seconds });
export const getTracker = (tid, { refresh: r } = {}) => api(`/api/tracker/${tid}${q(refresh(r))}`);
export const notifyReachable = (tid) => post(`/api/tracker/${tid}/reachable-notification`);
export const createShare = (tid, message) => post(`/api/tracker/${tid}/share`, { message });
export const deleteShare = (sid) => del(`/api/share/${sid}`);
export const deletePsz = (zid, confirm) => del(`/api/psz/${zid}`, { confirm });
export const getGeofences = (tid, { refresh: r } = {}) => api(`/api/tracker/${tid}/geofences${q(refresh(r))}`);
export const createGeofence = (tid, g) => post(`/api/tracker/${tid}/geofences`, g);
export const updateGeofence = (gid, g) => put(`/api/geofences/${gid}`, g);
export const deleteGeofence = (gid) => del(`/api/geofences/${gid}`);
export const getPositions = ({ tracker, from, to, step }) => api(`/api/positions${q({ tracker, from, to, step })}`);
export const gpxUrl = ({ tracker, from, to }) => `/api/positions.gpx${q({ tracker, from, to })}`;
export const backfill = ({ tracker, from, to }) => post('/api/positions/backfill', { tracker, from, to });
export const getEscapes = ({ tracker, from, to }) => api(`/api/escapes${q({ tracker, from, to })}`);
export const recomputeEscapes = ({ tracker, from, to }) => post('/api/escapes/recompute', { tracker, from, to });
export const patchEscape = (id, patch) => api(`/api/escapes/${id}`, { method: 'PATCH', body: patch });
export const getAlerts = ({ before, limit } = {}) => api(`/api/alerts${q({ before, limit })}`);
export const ackAlert = (id) => post(`/api/alerts/${id}/ack`);
export const falseAlarm = (id) => post(`/api/alerts/${id}/false-alarm`);
export const getSettings = () => api('/api/settings');
export const putSettings = (s) => put('/api/settings', s);
export const setChase = (on) => post('/api/chase', { on });
export const setWalk = (minutes) => post('/api/walk', { minutes });
export const getPet = (pid, { resumeFrom } = {}) => api(`/api/pet/${pid}${q({ resumeFrom })}`);
export const putPet = (pid, details) => put(`/api/pet/${pid}`, { details });
export const petPhotoUrl = (pid) => `/api/pet/${pid}/photo`;
export const retryLogin = () => post('/api/tractive/retry-login');
export const getNotifications = () => api('/api/tractive/notifications');
export const putNotifications = (n) => put('/api/tractive/notifications', n);
export const getTelegram = () => api('/api/telegram');
export const createPairing = () => post('/api/telegram/pairing');
export const deleteChat = (id) => del(`/api/telegram/chats/${id}`);
export const updateChat = (id, patch) => put(`/api/telegram/chats/${id}`, patch);
export const telegramTest = (chatId) => post('/api/telegram/test', chatId == null ? {} : { chatId });
export const labRaw = () => api('/api/lab/raw');
export const labChannel = ({ limit, type } = {}) => api(`/api/lab/channel${q({ limit, type })}`);
export const labFields = () => api('/api/lab/fields');
export const labRequest = (req) => post('/api/lab/request', req);
export const getCommands = ({ limit } = {}) => api(`/api/commands${q({ limit })}`);
export const logout = () => post('/api/logout');

// Server-sent events: every named event is re-dispatched on `bus` as a CustomEvent with the parsed payload.
export const bus = new EventTarget();
const EVENTS = ['state', 'position', 'alert', 'command', 'channel'];

export function openStream() {
  const es = new EventSource('/api/stream');
  for (const name of EVENTS) {
    es.addEventListener(name, (e) => {
      let detail;
      try {
        detail = JSON.parse(e.data);
      } catch {
        return;
      }
      bus.dispatchEvent(new CustomEvent(name, { detail }));
    });
  }
  es.addEventListener('open', () => bus.dispatchEvent(new Event('stream-open')));
  es.addEventListener('error', () => bus.dispatchEvent(new Event('stream-error')));
  return () => es.close();
}
