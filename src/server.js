// JSON API, SSE and the SPA behind a password login (stateless signed cookie, see auth.js).
// Routes are matched by method and a segment pattern with validated :params.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  passwordMatches, sessionKey, signSession, verifySession, createLimiter, clientIp, isHttps, cookieHeader,
} from './auth.js';
import { resolveStatic, MIME, FONTS, VENDOR, buildSprite } from './static.js';
import { AuthError, RateLimited, TractiveError } from './tractive.js';
import { DEFAULT_SETTINGS, RULE_KINDS } from './monitor.js';
import { classify } from './escapes.js';
import { distanceM } from './geo.js';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
// Served without a session: the login page and what it loads.
export const PUBLIC_PATHS = new Set([
  '/js/login.js', '/js/i18n.js', '/js/i18n/core.js', '/js/theme.js', '/css/tokens.css', '/css/base.css', '/css/login.css', '/favicon.svg',
]);
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin', // tile servers need a Referer
};
const DAY_MS = 24 * 60 * 60e3;
const SESSION_MS = 30 * DAY_MS;
const RENEW_MS = 15 * DAY_MS;
const MAX_BODY = 16 * 1024;
const MAX_STREAMS = 8;
const DAY = 86400;
const LOGIN_REQUIRED = { error: 'login required' };
const SSE = Symbol('sse');

const HEX24 = /^[a-f0-9]{24}$/;
const ID = /^[1-9]\d{0,15}$/;
const CID = /^-?\d{1,20}$/;
const PARAMS = { tid: /^[A-Z0-9]{8}$/, gid: HEX24, sid: HEX24, zid: HEX24, pid: HEX24, aid: ID, eid: ID, cid: CID };
const NUMERIC = new Set(['aid', 'eid']);
const COMMANDS = { led: 'led_control', buzzer: 'buzzer_control', pos_request: 'pos_request' };
const POWER_MODES = ['LOW', 'BALANCED', 'PRECISION'];
const LIVE_TIMEOUTS = [300, 900, 1800, 3600];
const SEVERITIES = ['info', 'warn', 'critical'];
const NOTIFY_KEYS = ['automatic_walk_detection', 'geofence_in', 'geofence_out', 'battery_full', 'battery_low', 'battery_critical', 'battery_empty',
  'charging_reminder', 'proactive_charge_reminder', 'tracker_startup_shutdown', 'sharing', 'support', 'wellness_and_activity', 'point_of_interest_warnings'];
const without = (...xs) => NOTIFY_KEYS.filter((k) => !xs.includes(k));
const NOTIFY = {
  push: { field: 'push_settings', keys: NOTIFY_KEYS },
  mail: { field: 'mail_settings', keys: without('automatic_walk_detection', 'proactive_charge_reminder', 'support') },
  webPush: { field: 'web_push_settings', keys: without('automatic_walk_detection', 'proactive_charge_reminder') },
};

class HttpError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}
const fail = (status, error, extra = {}) => { throw new HttpError(status, { error, ...extra }); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const onlyKeys = (o, keys) => Object.keys(o).filter((k) => !keys.includes(k));

// Resolves null when the body exceeds maxBytes (a 413 response closes the connection).
export function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > maxBytes) return resolve(null);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes) return chunks.push(c);
      req.removeAllListeners('data').pause();
      resolve(null);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sameOrigin(origin, host) {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false; // missing or opaque ("null") origin
  }
}

const readCookie = (header) => /(?:^|;\s*)ot_session=([^;]*)/.exec(header ?? '')?.[1];

// ---- Lab console ----

const LAB_PATH = /^\/[A-Za-z0-9_\-./?=&,:]{0,300}$/;
const LAB_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const DENY_FIRST = ['auth', 'payment', 'invoices', 'analytics'];
const DENY_PARTS = ['/subscription/', '/email_change', '/push_token', '/picture', 'reset_password', 'logout'];
const DENY_DELETE = ['user', 'trackable_object', 'tracker'];
// any write under /user can change the login email (account takeover); notification settings have their own route

export function labCheck({ host, method, path: p, confirm }, bases) {
  if (!Object.hasOwn(bases, host ?? '')) return { status: 400, error: 'host must be graph, aps or timeline' };
  if (!LAB_METHODS.includes(method)) return { status: 400, error: `method must be one of ${LAB_METHODS.join(', ')}` };
  if (typeof p !== 'string' || !LAB_PATH.test(p) || p.includes('..') || p.includes('//') || p.split('?')[0].split('/').includes('.')) return { status: 400, error: 'invalid path' };
  const base = new URL(bases[host]);
  let url;
  try {
    url = new URL(bases[host] + p);
  } catch {
    return { status: 400, error: 'invalid path' };
  }
  const root = base.pathname.replace(/\/$/, '');
  if (url.origin !== base.origin || !url.pathname.startsWith(`${root}/`)) return { status: 400, error: 'invalid path' };
  const lower = url.pathname.slice(root.length).toLowerCase(); // the canonical path is what Tractive receives
  const first = lower.split('/')[1];
  if (DENY_FIRST.includes(first) || DENY_PARTS.some((x) => lower.includes(x)) || (method === 'DELETE' && DENY_DELETE.includes(first)) || (method !== 'GET' && first === 'user')) {
    return { status: 403, error: 'this path is not allowed from the Lab' };
  }
  if (confirm !== true && (method !== 'GET' || lower.includes('/command/'))) return { status: 400, error: 'confirm required' };
  return { url };
}

const SECRET_KEYS = new Set(['access_token', 'token', 'share_link']);
export function redactSecrets(v) {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.has(k) ? '<redacted>' : redactSecrets(x)]));
}

// ---- validation ----

function validateGeofence(b) {
  const f = {};
  for (const k of onlyKeys(b, ['name', 'shape', 'coords', 'radius', 'fence_type', 'active', 'icon', '_version'])) f[k] = 'unknown key';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 40) f.name = 'must be 1 to 40 characters';
  if (!['POLYGON', 'CIRCLE', 'RECTANGLE'].includes(b.shape)) f.shape = 'must be POLYGON, CIRCLE or RECTANGLE';
  const pairOk = (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180;
  const n = { POLYGON: [3, 100], RECTANGLE: [2, 2], CIRCLE: [1, 1] }[b.shape] ?? [1, 100];
  if (!Array.isArray(b.coords) || !b.coords.every(pairOk)) f.coords = 'must be [lat, lng] pairs within ±90/±180';
  else if (b.coords.length < n[0] || b.coords.length > n[1]) f.coords = n[0] === n[1] ? `must have exactly ${n[0]} points` : `must have ${n[0]} to ${n[1]} points`;
  if (b.shape === 'CIRCLE' ? !(typeof b.radius === 'number' && b.radius >= 10 && b.radius <= 5000)
    : b.radius !== undefined && b.radius !== null && !(Number.isFinite(b.radius) && b.radius >= 0)) f.radius = 'must be 10 to 5000 m';
  if (!['SAFE', 'DANGER'].includes(b.fence_type)) f.fence_type = 'must be SAFE or DANGER';
  if (b.active !== undefined && typeof b.active !== 'boolean') f.active = 'must be true or false';
  if (b.icon !== undefined && !(typeof b.icon === 'string' && /^[A-Z_]{1,30}$/.test(b.icon))) f.icon = 'invalid icon';
  if (b._version !== undefined && typeof b._version !== 'string') f._version = 'must be a string';
  if (Object.keys(f).length) fail(400, 'invalid geofence', { fields: f });
  const { _version, ...g } = b;
  return { ...g, name, active: b.active ?? true };
}

const PET_DETAILS = {
  name: (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 40,
  birthday: (v) => isInt(v, 0, Math.floor(Date.now() / 1000)),
  weight: (v) => isInt(v, 500, 150000),
  gender: (v) => v === 'F' || v === 'M',
};
const PET_GOALS = { daily_goal: [1, 1000], daily_distance_goal: [100, 50000], daily_active_minutes_goal: [10, 600] };

function validatePet(b) {
  const f = {};
  for (const k of onlyKeys(b, ['details'])) f[k] = 'unknown key';
  const d = b.details;
  if (!isObj(d)) f.details = 'must be an object';
  else {
    for (const [k, v] of Object.entries(d)) {
      if (k === 'activity_settings') {
        if (!isObj(v)) f[`details.${k}`] = 'must be an object';
        else for (const [g, x] of Object.entries(v)) if (!PET_GOALS[g] || !isInt(x, ...PET_GOALS[g])) f[`details.${k}.${g}`] = PET_GOALS[g] ? `must be an integer from ${PET_GOALS[g].join(' to ')}` : 'unknown key';
      } else if (!PET_DETAILS[k]) f[`details.${k}`] = 'unknown key';
      else if (!PET_DETAILS[k](v)) f[`details.${k}`] = 'invalid value';
    }
  }
  if (Object.keys(f).length) fail(400, 'invalid pet', { fields: f });
  return typeof d.name === 'string' ? { ...d, name: d.name.trim() } : d;
}

function notificationsOf(user) {
  const s = user?.settings ?? {};
  return Object.fromEntries(Object.entries(NOTIFY).map(([k, { field, keys }]) => [k, Object.fromEntries(keys.map((x) => [x, s[field]?.[x] ?? false]))]));
}

const qInt = (query, name) => {
  const v = query.get(name);
  return v != null && /^-?\d{1,15}$/.test(v) ? Number(v) : null;
};

function trackerParam(v) {
  if (typeof v !== 'string' || !PARAMS.tid.test(v)) fail(400, 'invalid tracker');
  return v;
}

// ---- server ----

export function startServer({ store, app, config = {}, port = 8080, host = '127.0.0.1', log = console.log, failDelayMs = 300 }) {
  if (!config.password) throw new Error('config.password is required');
  const trustProxy = Boolean(config.trustProxy);
  let secret = store.getKv('sessionSecret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    store.setKv('sessionSecret', secret);
  }
  const key = sessionKey(secret, config.password);
  const limiter = createLimiter();
  const sprite = buildSprite();
  const { tractive, monitor, telegram } = app;
  const nowS = () => Math.floor(Date.now() / 1000);
  const streams = [];

  const known = (tid, { write = false } = {}) => {
    if (!app.trackerIds.includes(tid)) fail(404, 'unknown tracker');
    if (write && tid !== app.followedId) fail(403, 'tracker is read-only');
    return tid;
  };
  // tracker, from, to from a query or body; to > from and a span cap
  const span = (src, maxDays, defaults = false) => {
    const get = (k) => (src instanceof URLSearchParams ? qInt(src, k) : Number.isInteger(src[k]) ? src[k] : null);
    const has = (k) => (src instanceof URLSearchParams ? src.has(k) : src[k] !== undefined);
    const tid = known(trackerParam(src instanceof URLSearchParams ? src.get('tracker') : src.tracker));
    let to = get('to'), from = get('from');
    if (defaults && !has('to')) to = nowS();
    if (defaults && !has('from') && to != null) from = to - 30 * DAY;
    if (from == null || to == null) fail(400, 'from and to must be integer unix seconds');
    if (to <= from) fail(400, 'to must be after from');
    if (to - from > maxDays * DAY) fail(400, `the range is limited to ${maxDays} days`);
    return { trackerId: tid, from, to };
  };
  // TractiveError 409/412 on a versioned PUT: someone changed the object since the client loaded it.
  const versioned = (p) => p.catch((e) => {
    if (e instanceof TractiveError && !(e instanceof RateLimited) && (e.status === 409 || e.status === 412)) fail(409, 'changed elsewhere');
    throw e;
  });
  const fences = () => store.getRaw(`geofences:${app.followedId}`) ?? [];
  const fence = (gid) => fences().find((g) => g._id === gid) ?? fail(404, 'unknown geofence');

  function positionStats(rows, trackerId) {
    const asc = [...rows].reverse();
    let dist = 0, prev = null;
    for (const r of asc) {
      if (r.psz_id || r.sensor === 'KNOWN_WIFI') continue;
      if (prev) dist += distanceM(prev, r);
      prev = r;
    }
    const y = trackerId === app.followedId ? monitor.yard() : null;
    let outsideS = null;
    if (y) {
      const analysis = monitor.settings().analysis;
      outsideS = 0;
      for (let i = 0; i < asc.length - 1; i++) if (classify(asc[i], y.polygon, analysis).cls === 'outside') outsideS += asc[i + 1].t - asc[i].t;
    }
    return { distanceM: Math.round(dist), outsideS, fixes: rows.length };
  }

  function positionsQuery(query) {
    const r = span(query, 31);
    let step;
    if (query.has('step')) {
      step = qInt(query, 'step');
      if (!isInt(step, 1, DAY)) fail(400, 'step must be 1 to 86400 seconds');
    }
    return { ...r, ...store.positions(r.trackerId, r.from, r.to, { step }) };
  }

  const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function gpx({ trackerId, rows }) {
    const pts = [...rows].reverse().filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)).map((r) => `<trkpt lat="${r.lat.toFixed(6)}" lon="${r.lng.toFixed(6)}">`
      + `${Number.isFinite(r.alt) ? `<ele>${r.alt}</ele>` : ''}<time>${new Date(r.t * 1000).toISOString()}</time>`
      + `<desc>${xml(r.sensor ?? 'unknown')} ±${Math.round(r.acc ?? 0)} m</desc></trkpt>`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="OpenTractive" xmlns="http://www.topografix.com/GPX/1/1">`
      + `<trk><name>${xml(trackerId)}</name><trkseg>\n${pts.join('\n')}\n</trkseg></trk></gpx>\n`;
  }

  const timelineOut = (tl) => {
    let next = null;
    try { next = tl?.paging?.nextUrl ? new URL(tl.paging.nextUrl).searchParams.get('resumeFrom') : null; } catch { /* malformed */ }
    return { events: Array.isArray(tl?.events) ? tl.events : [], nextResumeFrom: next };
  };

  const routes = {
    'GET /api/state': () => [200, app.statePayload()],
    'GET /api/stream': () => [200, SSE],

    'POST /api/tracker/:tid/command': async ({ params: { tid }, body: { name, on } }) => {
      if (name !== 'live' && !COMMANDS[name]) fail(400, 'name must be live, led, buzzer or pos_request');
      if (typeof on !== 'boolean') fail(400, 'on must be true or false');
      if (name === 'pos_request' && !on) fail(400, 'pos_request can only be turned on');
      known(tid, { write: true });
      if (name === 'live') {
        await monitor.setManualLive(on, 'web');
        return [202, { manual: on }];
      }
      return [200, await monitor.command('web', tid, COMMANDS[name], on)];
    },
    'PUT /api/tracker/:tid/power-mode': async ({ params: { tid }, body: { mode } }) => {
      if (!POWER_MODES.includes(mode)) fail(400, 'mode must be LOW, BALANCED or PRECISION');
      known(tid, { write: true });
      await app.audit('web', 'power-mode', { tracker: tid, mode }, () => tractive.setPowerMode(tid, mode));
      return [200, await app.refresh('tracker', tid)];
    },
    'PUT /api/tracker/:tid/live-timeout': async ({ params: { tid }, body: { seconds } }) => {
      if (!LIVE_TIMEOUTS.includes(seconds)) fail(400, 'seconds must be 300, 900, 1800 or 3600');
      known(tid, { write: true });
      await app.audit('web', 'live-timeout', { tracker: tid, seconds }, () => tractive.setLiveTimeout(tid, seconds));
      return [200, await app.refresh('tracker', tid)];
    },
    'GET /api/tracker/:tid': async ({ params: { tid }, query }) => [200, await app.trackerPayload(known(tid), { refresh: query.get('refresh') === '1' })],
    'POST /api/tracker/:tid/reachable-notification': async ({ params: { tid } }) => {
      known(tid, { write: true });
      const r = await app.audit('web', 'reachable-notification', { tracker: tid }, () => tractive.setReachableNotification(tid));
      store.setRaw(`reachable:${tid}`, r);
      return [200, r];
    },
    'POST /api/tracker/:tid/share': async ({ params: { tid }, body: { message } }) => {
      if (typeof message !== 'string' || message.length < 1 || message.length > 200) fail(400, 'message must be 1 to 200 characters');
      known(tid, { write: true });
      const s = await app.audit('web', 'share-create', { tracker: tid }, () => tractive.createPublicShare(tid, message));
      await app.refresh('public_share');
      return [201, s];
    },
    'DELETE /api/share/:sid': async ({ params: { sid } }) => {
      await app.audit('web', 'share-delete', { share: sid }, () => tractive.deactivatePublicShare(sid));
      await app.refresh('public_share');
      return [204, null];
    },
    'DELETE /api/psz/:zid': async ({ params: { zid }, body }) => {
      const z = (store.getRaw(`psz:${app.followedId}`) ?? []).find((x) => x._id === zid) ?? fail(404, 'unknown zone');
      if (body.confirm !== z.name) fail(400, 'type the zone name to confirm');
      await app.audit('web', 'psz-delete', { zone: zid }, () => tractive.deletePowerSavingZone(zid));
      await app.refresh('power_saving_zone');
      return [204, null];
    },

    'GET /api/tracker/:tid/geofences': async ({ params: { tid }, query }) => {
      known(tid);
      const list = store.getRaw(`geofences:${tid}`);
      return [200, query.get('refresh') === '1' || list == null ? await app.refresh('geofence', tid) : list];
    },
    'POST /api/tracker/:tid/geofences': async ({ params: { tid }, body }) => {
      const g = validateGeofence(body);
      known(tid, { write: true });
      const created = await app.audit('web', 'geofence-create', { tracker: tid, name: g.name }, () => tractive.createGeofence(tid, { ...g, icon: g.icon ?? 'TRACTIVE' }));
      await app.refresh('geofence');
      return [201, created];
    },
    'PUT /api/geofences/:gid': async ({ params: { gid }, body }) => {
      const g = validateGeofence(body);
      if (typeof body._version !== 'string') fail(400, 'invalid geofence', { fields: { _version: 'required' } });
      const old = fence(gid);
      const updated = await versioned(app.audit('web', 'geofence-update', { geofence: gid, name: g.name },
        () => tractive.updateGeofence({ ...g, _id: gid, _version: body._version, icon: g.icon ?? old.icon ?? 'TRACTIVE' })));
      await app.refresh('geofence');
      return [200, updated];
    },
    'DELETE /api/geofences/:gid': async ({ params: { gid } }) => {
      fence(gid);
      await app.audit('web', 'geofence-delete', { geofence: gid }, () => tractive.deleteGeofence(gid));
      await app.refresh('geofence');
      return [204, null];
    },

    'GET /api/positions': ({ query }) => {
      const { rows, truncated, trackerId } = positionsQuery(query);
      return [200, { rows, truncated, stats: positionStats(rows, trackerId) }];
    },
    'GET /api/positions.gpx': ({ query }) => {
      const r = positionsQuery(query);
      return [200, Buffer.from(gpx(r)), {
        'content-type': 'application/gpx+xml; charset=utf-8',
        'content-disposition': `attachment; filename="opentractive-${r.trackerId}-${r.from}-${r.to}.gpx"`,
      }];
    },
    'POST /api/positions/backfill': ({ body }) => {
      const r = span(body, 31);
      app.backfill(r).catch((e) => log(`backfill: ${e.message}`));
      return [202, { days: Math.ceil((r.to - r.from) / DAY) }];
    },

    'GET /api/escapes': ({ query }) => [200, app.escapes(span(query, 92, true))],
    'POST /api/escapes/recompute': ({ body }) => [200, app.recompute(span(body, 92))],
    'PATCH /api/escapes/:eid': ({ params: { eid }, body }) => {
      const keys = Object.keys(body);
      if (!keys.length || onlyKeys(body, ['dismissed', 'note']).length) fail(400, 'send dismissed and/or note only');
      if (body.dismissed !== undefined && typeof body.dismissed !== 'boolean') fail(400, 'dismissed must be true or false');
      if (body.note !== undefined && body.note !== null && !(typeof body.note === 'string' && body.note.length <= 200)) fail(400, 'note must be at most 200 characters');
      if (!store.escape(eid)) fail(404, 'unknown escape');
      store.updateEscape(eid, {
        ...(body.dismissed !== undefined && { dismissed: body.dismissed ? 1 : 0 }), ...(body.note !== undefined && { note: body.note }),
      });
      return [200, store.escape(eid)];
    },

    'GET /api/alerts': ({ query }) => {
      const limit = query.has('limit') ? qInt(query, 'limit') : 50;
      if (!isInt(limit, 1, 200)) fail(400, 'limit must be 1 to 200');
      const before = query.has('before') ? qInt(query, 'before') : undefined;
      if (before === null) fail(400, 'before must be an integer id');
      return [200, store.alerts({ before, limit })];
    },
    'POST /api/alerts/:aid/ack': ({ params: { aid } }) => [200, monitor.ack(aid, 'web') ?? fail(404, 'unknown alert')],
    'POST /api/alerts/:aid/false-alarm': ({ params: { aid } }) => {
      if (!store.alert(aid)) fail(404, 'unknown alert');
      return [200, monitor.falseAlarm(aid, 'web') ?? fail(409, 'not an open incident')];
    },

    'GET /api/settings': () => [200, { settings: monitor.settings(), defaults: DEFAULT_SETTINGS, ruleKinds: RULE_KINDS, pszFlags: monitor.pszFlags() }],
    'PUT /api/settings': ({ body }) => {
      const r = monitor.putSettings(body);
      if (r.errors) fail(400, 'invalid settings', { fields: r.errors });
      return [200, { settings: r.settings }];
    },
    'POST /api/chase': async ({ body: { on } }) => {
      if (typeof on !== 'boolean') fail(400, 'on must be true or false');
      await monitor.setChase(on, 'web');
      return [200, monitor.status()];
    },
    'POST /api/walk': ({ body }) => {
      if (!(body.minutes === null || isInt(body.minutes, 1, 720))) fail(400, 'minutes must be 1 to 720, or null to end the walk');
      monitor.setWalk(body.minutes, 'web');
      return [200, monitor.status()];
    },

    'GET /api/pet/:pid': async ({ params: { pid }, query }) => {
      const pet = store.getRaw(`pet:${pid}`) ?? fail(404, 'unknown pet');
      if (query.has('resumeFrom')) {
        const d = query.get('resumeFrom');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) fail(400, 'resumeFrom must be YYYY-MM-DD');
        return [200, { timeline: timelineOut(await tractive.timeline(pid, { resumeFrom: d })) }];
      }
      return [200, {
        pet, health: store.getRaw(`health:${pid}`), weight: store.getRaw(`weight:${pid}`), timeline: timelineOut(store.getRaw(`timeline:${pid}`)),
        photo: pet.details?.profile_picture_id ? `/api/pet/${pid}/photo` : null,
      }];
    },
    'PUT /api/pet/:pid': async ({ params: { pid }, body }) => {
      const d = validatePet(body);
      if (!store.getRaw(`pet:${pid}`)) fail(404, 'unknown pet');
      const updated = await versioned(app.audit('web', 'pet-update', { pet: pid, keys: Object.keys(d) }, async () => {
        const fresh = await tractive.pet(pid);
        const details = { ...fresh.details, ...d };
        if (d.activity_settings) details.activity_settings = { ...fresh.details?.activity_settings, ...d.activity_settings };
        return tractive.updatePet({ ...fresh, details });
      }));
      store.setRaw(`pet:${pid}`, updated);
      return [200, updated];
    },
    'GET /api/pet/:pid/photo': async ({ params: { pid } }) => {
      const r = (await app.petPhoto(pid)) ?? fail(404, 'no photo');
      if (r.error) fail(502, r.error);
      return [200, r.buf, { 'content-type': r.type, 'cache-control': 'private, max-age=86400' }];
    },

    'POST /api/tractive/retry-login': () => {
      app.retryLogin();
      return [202, { login: tractive.status().login }];
    },
    'GET /api/tractive/notifications': async () => {
      let u = store.getRaw('user');
      if (!u) store.setRaw('user', (u = await tractive.user()));
      return [200, notificationsOf(u)];
    },
    'PUT /api/tractive/notifications': async ({ body }) => {
      const f = {};
      for (const k of onlyKeys(body, Object.keys(NOTIFY))) f[k] = 'unknown key';
      for (const [k, { keys }] of Object.entries(NOTIFY)) {
        if (body[k] === undefined) continue;
        if (!isObj(body[k])) { f[k] = 'must be an object'; continue; }
        for (const [x, v] of Object.entries(body[k])) if (!keys.includes(x) || typeof v !== 'boolean') f[`${k}.${x}`] = keys.includes(x) ? 'must be true or false' : 'unknown key';
      }
      if (Object.keys(f).length) fail(400, 'invalid notification settings', { fields: f });
      const updated = await app.audit('web', 'notifications', { keys: Object.keys(body) }, async () => {
        const u = await tractive.user();
        u.settings ??= {};
        for (const [k, { field }] of Object.entries(NOTIFY)) if (body[k]) u.settings[field] = { ...u.settings[field], ...body[k] };
        return (await tractive.updateUser(u)) ?? u;
      });
      store.setRaw('user', updated);
      return [200, notificationsOf(updated)];
    },

    'GET /api/telegram': () => {
      const p = store.getKv('pairing');
      return [200, { ...telegram.status(), chats: store.chats(), pairing: p ? { code: p.code, expiresAt: p.expiresAt } : null }];
    },
    'POST /api/telegram/pairing': () => {
      if (!telegram.status().enabled) fail(409, 'Telegram is off');
      return [200, telegram.createPairingCode()];
    },
    'DELETE /api/telegram/chats/:cid': ({ params: { cid } }) => {
      if (!store.chat(cid)) fail(404, 'unknown chat');
      store.deleteChat(cid);
      return [204, null];
    },
    'PUT /api/telegram/chats/:cid': ({ params: { cid }, body }) => {
      if (!Object.keys(body).length || onlyKeys(body, ['min_severity', 'muted_until']).length) fail(400, 'send min_severity and/or muted_until only');
      if (body.min_severity !== undefined && !SEVERITIES.includes(body.min_severity)) fail(400, 'min_severity must be info, warn or critical');
      if (body.muted_until !== undefined && body.muted_until !== null && !isInt(body.muted_until, 0, Number.MAX_SAFE_INTEGER)) fail(400, 'muted_until must be unix seconds or null');
      if (!store.chat(cid)) fail(404, 'unknown chat');
      store.updateChat(cid, body);
      return [200, store.chat(cid)];
    },
    'POST /api/telegram/test': async ({ body }) => {
      if (!telegram.status().enabled) fail(409, 'Telegram is off');
      const chatId = body.chatId;
      if (chatId !== undefined && !CID.test(String(chatId))) fail(400, 'invalid chatId');
      return [200, { sent: await telegram.sendTest(chatId) }];
    },

    'GET /api/lab/raw': () => [200, redactSecrets(store.rawAll())],
    'GET /api/lab/channel': ({ query }) => {
      const limit = query.has('limit') ? qInt(query, 'limit') : 200;
      if (!isInt(limit, 1, 2000)) fail(400, 'limit must be 1 to 2000');
      return [200, store.channelLog(limit, query.get('type') || undefined)];
    },
    'GET /api/lab/fields': () => {
      const rows = store.fields(), first = {};
      for (const r of rows) first[r.kind] = Math.min(first[r.kind] ?? Infinity, r.first_seen);
      return [200, rows.map((r) => ({ ...r, isNew: r.first_seen - first[r.kind] > 60 }))];
    },
    'POST /api/lab/request': async ({ body }) => {
      const chk = labCheck(body, app.bases);
      if (!chk.url) fail(chk.status, chk.error);
      const params = { method: body.method, host: body.host, path: body.path.split('?')[0] };
      const t = nowS();
      let r;
      try {
        r = await tractive.raw(body.host, body.method, body.path, body.method === 'GET' ? undefined : body.body);
      } catch (e) {
        store.logCommand({ t, actor: 'web', action: 'lab', params, ok: false, result: { error: e.name } });
        app.emit('event', 'command', store.commands(1)[0]);
        throw e;
      }
      // the audit keeps status and duration only, never the response body
      store.logCommand({ t, actor: 'web', action: 'lab', params, ok: r.status < 400, result: { status: r.status, ms: r.ms } });
      app.emit('event', 'command', store.commands(1)[0]);
      return [200, { status: r.status, ms: r.ms, body: redactSecrets(r.body) }];
    },
    'GET /api/commands': ({ query }) => {
      const limit = query.has('limit') ? qInt(query, 'limit') : 100;
      if (!isInt(limit, 1, 500)) fail(400, 'limit must be 1 to 500');
      return [200, store.commands(limit)];
    },
    'POST /api/logout': ({ req }) => [204, null, { 'set-cookie': cookieHeader('', { maxAgeS: 0, secure: isHttps(req, trustProxy) }) }],
  };

  const table = Object.entries(routes).map(([k, handler]) => {
    const [method, pattern] = k.split(' ');
    return { method, segs: pattern.split('/'), handler };
  });
  // → {handler, params} | {status, error}
  function match(method, pathname) {
    const segs = pathname.split('/');
    let otherMethod = false, invalid = null;
    for (const r of table) {
      if (r.segs.length !== segs.length) continue;
      const params = {};
      let ok = true, bad = null;
      for (let i = 0; i < segs.length && ok; i++) {
        const p = r.segs[i];
        if (!p.startsWith(':')) ok = p === segs[i];
        else if (!PARAMS[p.slice(1)].test(segs[i])) bad ??= p.slice(1);
        else params[p.slice(1)] = NUMERIC.has(p.slice(1)) ? Number(segs[i]) : segs[i];
      }
      if (!ok) continue;
      if (r.method !== method) otherMethod = true;
      else if (bad) invalid ??= bad;
      else return { handler: r.handler, params };
    }
    if (invalid) return { status: 400, error: `invalid ${invalid}` };
    if (otherMethod) return { status: 405, error: 'method not allowed' };
    return null;
  }

  function errorResponse(err) {
    if (err instanceof HttpError) return [err.status, err.body];
    if (err instanceof AuthError) {
      return [503, { error: err.state === 'bad-credentials' ? 'Tractive login failed: wrong email or password' : 'Tractive login is retrying', login: err.state }];
    }
    if (err instanceof RateLimited) return [503, { error: 'Tractive rate limit', retryAfter: err.retryAfterS }, { 'retry-after': String(err.retryAfterS) }];
    if (err instanceof TractiveError) {
      return [502, { error: `Tractive: ${err.tractiveMessage ?? 'request failed'}`, tractive: { status: err.status, code: err.code ?? null } }];
    }
    if (err instanceof RangeError) return [400, { error: err.message }];
    log(`http error: ${err?.message ?? err}`);
    return [500, { error: 'internal error' }];
  }

  function openStream(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    const send = (name, data) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (e) {
        log(`sse: ${e.message}`);
      }
    };
    const onEvent = (name, data) => send(name, data);
    const hb = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 20e3);
    hb.unref();
    const s = { res };
    streams.push(s);
    res.on('close', () => {
      clearInterval(hb);
      app.off('event', onEvent);
      const i = streams.indexOf(s);
      if (i >= 0) streams.splice(i, 1);
    });
    while (streams.length > MAX_STREAMS) streams.shift().res.end(); // the oldest goes first
    try {
      send('state', app.statePayload());
    } catch (e) {
      log(`sse state: ${e.message}`);
    }
    app.on('event', onEvent);
  }

  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // a 413 leaves the rest of the body unread, so the connection cannot be reused
    const json = (status, body, headers = {}) => {
      res.writeHead(status, {
        ...(status !== 204 && { 'content-type': 'application/json' }), ...(status === 413 && { connection: 'close' }),
        'cache-control': 'no-store', ...headers,
      });
      res.end(status === 204 ? undefined : JSON.stringify(body));
    };
    let url;
    // scripts and styles are never stored, so a stale module never runs after an update
    const sendFile = (abs, cacheControl = /^\/(js|css)\//.test(url?.pathname) ? 'no-store' : 'no-cache') => {
      if (!abs) return json(404, { error: 'not found' });
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': cacheControl });
      fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
    };
    const newCookie = () =>
      cookieHeader(signSession(key, Date.now() + SESSION_MS), { maxAgeS: SESSION_MS / 1000, secure: isHttps(req, trustProxy) });

    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return json(400, { error: 'bad request' });
    }
    const { pathname } = url;
    const route = `${req.method} ${pathname}`;
    const aborter = new AbortController();
    res.on('close', () => { if (!res.writableFinished) aborter.abort(); });
    const ctx = { req, url, query: url.searchParams, body: undefined, params: {}, signal: aborter.signal, actor: 'web' };
    // CSRF: a JSON content type (not sendable cross-site without a preflight) and an Origin matching the Host, checked
    // before anything is read; then the body is capped and parsed.
    const bodyError = async () => {
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return [415, 'json content type required'];
      const reqHost = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
      if (!sameOrigin(req.headers.origin, reqHost)) return [403, 'origin not allowed'];
      const raw = await readBody(req);
      if (raw == null) return [413, 'body too large'];
      try {
        ctx.body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
      } catch {
        return [400, 'invalid json'];
      }
      if (!isObj(ctx.body)) return [400, 'the body must be a JSON object'];
      return null;
    };

    try {
      if (route === 'GET /healthz') {
        try {
          store.healthCheck();
        } catch {
          return json(503, { ok: false });
        }
        const s = tractive.status();
        return json(200, { ok: true, tractive: s.login === 'idle' ? 'login-retrying' : s.login, channel: s.channel.connected ? 'connected' : 'reconnecting' });
      }
      if (req.method === 'GET') {
        if (pathname === '/login') return sendFile(resolveStatic(PUBLIC, '/login.html'));
        if (pathname === '/icons.svg') {
          res.writeHead(200, { 'content-type': MIME['.svg'], 'cache-control': 'no-cache' });
          return res.end(sprite);
        }
        if (pathname.startsWith('/fonts/')) return sendFile(FONTS[pathname], 'max-age=86400');
        if (PUBLIC_PATHS.has(pathname)) return sendFile(resolveStatic(PUBLIC, pathname));
      }

      if (route === 'POST /api/login') {
        const err = await bodyError();
        if (err) return json(err[0], { error: err[1] });
        // check, compare and count in one synchronous step, so parallel guesses are all counted
        const ip = clientIp(req, trustProxy);
        const retryAfter = limiter.retryAfter(ip);
        if (retryAfter > 0) return json(429, { error: 'too many attempts', retryAfter }, { 'retry-after': String(retryAfter) });
        if (!passwordMatches(ctx.body?.password, config.password)) {
          limiter.fail(ip);
          await sleep(failDelayMs);
          return json(401, { error: 'wrong password' });
        }
        limiter.reset(ip);
        return json(204, null, { 'set-cookie': newCookie() });
      }

      const expiry = verifySession(key, readCookie(req.headers.cookie), Date.now());
      if (expiry == null) {
        if (req.method === 'GET' && !pathname.startsWith('/api/') && (pathname === '/' || pathname.endsWith('.html'))) {
          res.writeHead(302, { location: `/login?next=${encodeURIComponent(pathname + url.search)}` });
          return res.end();
        }
        return json(401, LOGIN_REQUIRED);
      }
      if (expiry - Date.now() < RENEW_MS) res.setHeader('set-cookie', newCookie());

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const err = await bodyError();
        if (err) return json(err[0], { error: err[1] });
      }
      const m = match(req.method, pathname);
      if (m?.handler) {
        let out;
        try {
          out = await m.handler({ ...ctx, params: m.params });
        } catch (err) {
          out = errorResponse(err);
        }
        const [status, body, headers] = out;
        if (body === SSE) return openStream(res);
        if (Buffer.isBuffer(body)) {
          res.writeHead(status, { 'cache-control': 'no-store', ...headers });
          return res.end(body);
        }
        return json(status, body, headers);
      }
      if (m) return json(m.status, { error: m.error });
      if (pathname.startsWith('/api/')) return json(404, { error: 'not found' });
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' });
      if (pathname.startsWith('/vendor/')) return sendFile(VENDOR[pathname] ?? null, 'max-age=86400');
      return sendFile(resolveStatic(PUBLIC, pathname === '/' ? '/index.html' : pathname));
    } catch (err) {
      log(`http error: ${err.message}`);
      if (res.headersSent) return res.end();
      json(500, { error: 'internal error' });
    }
  });
  server.listen(port, host, () => log(`http://${host}:${port}`));
  return server;
}
