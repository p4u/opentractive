// Monitor: escape incidents with evidence and persisted repeats, alert rules with dedupe, chase mode, the live-tracking
// reconciler, yard watch, walk mode, the unknown-field detector and settings validation. Persisted times are unix seconds.
import { EventEmitter } from 'node:events';
import { classify, HOME } from './escapes.js';
import { distanceM, distanceToBoundary, geofenceToPolygon } from './geo.js';
import { positionRow } from './state.js';

export const RULE_KINDS = ['out_possible', 'out_confirmed', 'left_psz', 'fence_exit', 'danger_enter', 'offline', 'live_failed',
  'chase_low_battery', 'channel_down', 'battery_low', 'battery_critical', 'charging', 'back_home', 'new_field'];

const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

export const DEFAULT_SETTINGS = deepFreeze({
  v: 1, yardGeofenceId: null, pszCoversYard: {},
  rules: {
    out_possible: { enabled: true, severity: 'warn' }, out_confirmed: { enabled: true, severity: 'critical' },
    left_psz: { enabled: true, severity: 'critical' }, fence_exit: { enabled: true, severity: 'critical' },
    danger_enter: { enabled: true, severity: 'critical' }, offline: { enabled: true, severity: 'warn' },
    live_failed: { enabled: true, severity: 'warn' }, chase_low_battery: { enabled: true, severity: 'critical' },
    channel_down: { enabled: true, severity: 'warn' }, battery_low: { enabled: true, severity: 'warn' },
    battery_critical: { enabled: true, severity: 'critical' }, charging: { enabled: true, severity: 'info' },
    back_home: { enabled: true, severity: 'info' }, new_field: { enabled: true, severity: 'info' },
  },
  thresholds: { offlineMin: 75, channelDownMin: 5, batteryLow: 20, batteryCritical: 10, dedupeMin: 10, repeatMin: 2, repeatMax: 10 },
  chase: { auto: true, maxHours: 6, minBattery: 15 },
  yardWatch: {
    enabled: false, windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '22:00' }], minBattery: 35, resumeBattery: 40,
    mode: 'live', nearFenceM: 15, nearFenceHoldMin: 10,
  },
  analysis: { marginM: 10, maxGapS: 600, homePszM: 50 },
});

export const C = Object.freeze({
  outConfirmS: 45, uncertainCount: 3, uncertainSpanS: 20, posRequestEveryS: 60, liveGuardS: 30, liveLowS: 60,
  reconcileBackoffS: 120, pendingFailS: 60, offlineIncidentMin: 10, newFieldsPerDay: 20, walkUntilBackMin: 720, itsAWalkMin: 120,
  staleFixS: 900, quietS: 600, maxEvidence: 50,
});

const RANK = { info: 0, warn: 1, critical: 2 };
const OFFLINE_STATES = new Set(['NOT_REPORTING', 'OUT_OF_BATTERY', 'SHUTDOWN_BY_USER']);
const REDACT = /latlong|coords|token|email|address|phone|name|guid|link|zip|invoice/i;

// ---- settings validation ----

const HEX24 = /^[a-f0-9]{24}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const join = (p, k) => (p ? `${p}.${k}` : String(k));
const leaf = (ok, msg) => (v, p, err) => { if (!ok(v)) err(p, msg); };
const int = (lo, hi) => leaf((v) => Number.isInteger(v) && v >= lo && v <= hi, `must be an integer from ${lo} to ${hi}`);
const num = (lo, hi) => leaf((v) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi, `must be a number from ${lo} to ${hi}`);
const bool = leaf((v) => typeof v === 'boolean', 'must be true or false');
const oneOf = (...xs) => leaf((v) => xs.includes(v), `must be one of: ${xs.join(', ')}`);
const time = leaf((v) => typeof v === 'string' && HHMM.test(v), 'must be a time HH:MM');
const obj = (shape) => (v, p, err) => {
  if (!isObj(v)) return err(p, 'must be an object');
  for (const k of Object.keys(v)) if (!Object.hasOwn(shape, k)) err(join(p, k), 'unknown key');
  for (const [k, check] of Object.entries(shape)) {
    if (Object.hasOwn(v, k)) check(v[k], join(p, k), err);
    else err(join(p, k), 'required');
  }
};
const days = leaf((v) => Array.isArray(v) && v.length > 0 && v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) && new Set(v).size === v.length,
  'must be a non-empty list of different days from 1 to 7');
const windows = (v, p, err) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 7) return err(p, 'must be a list of 1 to 7 windows');
  v.forEach((w, i) => {
    obj({ days, from: time, to: time })(w, join(p, i), err);
    if (isObj(w) && typeof w.from === 'string' && w.from === w.to) err(join(p, `${i}.to`), 'must differ from the start time');
  });
};
const pszCovers = (v, p, err) => {
  if (!isObj(v)) return err(p, 'must be an object');
  const keys = Object.keys(v);
  if (keys.length > 20) err(p, 'must have at most 20 zones');
  for (const k of keys) {
    if (!HEX24.test(k)) err(join(p, k), 'must be a 24-character hex zone id');
    else if (typeof v[k] !== 'boolean') err(join(p, k), 'must be true or false');
  }
};
const SCHEMA = obj({
  v: leaf((v) => v === 1, 'must be 1'),
  yardGeofenceId: leaf((v) => v === null || (typeof v === 'string' && HEX24.test(v)), 'must be null or a 24-character hex id'),
  pszCoversYard: pszCovers,
  rules: obj(Object.fromEntries(RULE_KINDS.map((k) => [k, obj({ enabled: bool, severity: oneOf('info', 'warn', 'critical') })]))),
  thresholds: obj({
    offlineMin: int(5, 1440), channelDownMin: int(1, 120), batteryLow: int(5, 90), batteryCritical: int(1, 50),
    dedupeMin: int(0, 1440), repeatMin: int(1, 60), repeatMax: int(0, 100),
  }),
  chase: obj({ auto: bool, maxHours: num(0.5, 24), minBattery: int(0, 90) }),
  yardWatch: obj({
    enabled: bool, windows, minBattery: int(5, 95), resumeBattery: int(0, 100), mode: oneOf('live', 'near-fence'),
    nearFenceM: num(5, 100), nearFenceHoldMin: int(1, 60),
  }),
  analysis: obj({ marginM: num(0, 50), maxGapS: int(30, 3600), homePszM: num(0, 500) }),
});

export function validateSettings(input) {
  const errors = {};
  const err = (p, msg) => { errors[p || 'settings'] ??= msg; };
  SCHEMA(input, '', err);
  const t = input?.thresholds, yw = input?.yardWatch;
  if (isObj(t) && !errors['thresholds.batteryLow'] && !errors['thresholds.batteryCritical'] && t.batteryCritical >= t.batteryLow) {
    errors['thresholds.batteryCritical'] = 'must be lower than the low battery threshold';
  }
  if (isObj(yw) && !errors['yardWatch.minBattery'] && !errors['yardWatch.resumeBattery'] && yw.resumeBattery <= yw.minBattery) {
    errors['yardWatch.resumeBattery'] = 'must be higher than the minimum battery';
  }
  return Object.keys(errors).length ? { errors } : { settings: structuredClone(input) };
}

// ---- pure helpers ----

export function liveDecision({ wanted, inPsz, active, remainingS, startedByApp, userOff, sinceLastCmdS }) {
  if (sinceLastCmdS < C.liveGuardS) return null;
  if (inPsz) return null;
  if (wanted && (!active || remainingS < C.liveLowS)) return 'on';
  if (!wanted && active && (startedByApp || userOff)) return 'off';
  return null;
}

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const fmtCache = new Map();
function localTime(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: WEEKDAY[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function inWindow(windows, ms, tz) {
  const { day, min } = localTime(ms, tz);
  const prevDay = day === 1 ? 7 : day - 1;
  return (windows ?? []).some((w) => {
    const from = toMin(w.from), to = toMin(w.to);
    if (from < to) return w.days.includes(day) && min >= from && min < to;
    return (w.days.includes(day) && min >= from) || (w.days.includes(prevDay) && min < to);
  });
}

export function yardWatchStatus({ yw, nowMs, tz, battery, charging, inPsz, lowLatched }) {
  if (!yw.enabled) return { status: 'off', lowLatched };
  if (!inWindow(yw.windows, nowMs, tz)) return { status: 'outside-window', lowLatched };
  if (charging) return { status: 'paused-charging', lowLatched };
  if (inPsz) return { status: 'paused-in-psz', lowLatched };
  if (battery < yw.minBattery || (lowLatched && battery < yw.resumeBattery)) return { status: 'low-battery', lowLatched: true };
  return { status: 'active', lowLatched: false };
}

export function flattenPaths(value) {
  const out = new Map();
  const set = (p, ex) => { if (p && !out.has(p)) out.set(p, ex); };
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      set(p, '[…]');
      for (const x of v) if (x !== null && typeof x === 'object') walk(x, `${p}[]`); // arrays of primitives are leaves
    } else if (v !== null && typeof v === 'object') {
      set(p, '{…}');
      for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
    } else set(p, typeof v === 'string' ? v.slice(0, 100) : v);
  };
  walk(value, '');
  return out;
}

function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---- monitor ----

export function createMonitor({ store, live, trackerId, sendCommand, posRequestAllowed = () => true, now = Date.now, tz = process.env.TZ ?? 'UTC', log = () => {} }) {
  const mon = new EventEmitter();
  const tid = () => (typeof trackerId === 'function' ? trackerId() : trackerId);
  const nowS = () => Math.floor(now() / 1000);
  const pending = new Set();
  const track = (p) => {
    const q = Promise.resolve(p).catch((e) => log(`monitor: ${e?.message ?? e}`));
    pending.add(q);
    q.finally(() => pending.delete(q));
    return q;
  };
  const safe = (fn) => (...a) => { try { fn(...a); } catch (e) { log(`monitor: ${e?.stack ?? e}`); } };

  // fix-handling state (in memory; the incident, chase and walk are persisted)
  let home = false, lastHomeFix = null, uncertainRun = [], outsideRun = 0, possible = null, firstOutside = null;
  let confirmed = false, escapeDone = false, lastFix = null, lastGpsFix = null, lastPszId = null, leftArmed = true;
  // reconciler state
  let manual = false, userOff = false, startedByApp = false, lastLiveCmdAt = -Infinity, failures = 0, failedRaised = false;
  let nextReconcileAt = 0, pendingSince = null, chain = Promise.resolve();
  // yard watch, silence and channel state
  let ywStatus = 'off', lowLatched = false, nearFenceUntil = 0, offlineRaised = false, disconnectedSince = null, channelDownRaised = false;
  let lastPosRequestAt = -Infinity, lastStatusJson = '';

  const settings = () => structuredClone(store.getKv('settings') ?? DEFAULT_SETTINGS);
  const chaseKv = () => store.getKv('chase');
  const walkKv = () => store.getKv('walk');
  const st = () => live.get(tid());
  const posData = () => { const p = st()?.position; return p ? { lat: p.lat, lng: p.lng, acc: p.acc, t: p.t } : null; };

  function yard() {
    const fences = store.getRaw(`geofences:${tid()}`) ?? [];
    const id = settings().yardGeofenceId;
    const g = id ? fences.find((f) => f._id === id)
      : fences.find((f) => f.active && f.fence_type === 'SAFE' && (String(f.name ?? '').toLowerCase() === 'yard' || f.home_flag));
    const polygon = g ? geofenceToPolygon(g) : null;
    return polygon ? { id: g._id, name: g.name, polygon } : null;
  }

  function pszFlags() {
    const y = yard(), s = settings();
    return (store.getRaw(`psz:${tid()}`) ?? []).map((z) => {
      const [lat, lng] = Array.isArray(z.latlong) ? z.latlong : [null, null];
      const geometric = y && Number.isFinite(lat) && Number.isFinite(lng) ? distanceToBoundary({ lat, lng }, y.polygon) <= s.analysis.homePszM : false;
      return { id: z._id, name: z.name, lat, lng, geometric, coversYard: s.pszCoversYard[z._id] ?? geometric };
    });
  }

  function status() {
    const c = chaseKv(), w = walkKv();
    return {
      incident: store.openIncident(tid()),
      chase: c ? { since: c.since, incidentId: c.incidentId } : null,
      walk: w ? { until: w.until } : null,
      yardWatch: { status: ywStatus },
      live: { wanted: wanted(), manual, failures },
      lastFix,
    };
  }
  function notify(force = false) {
    const s = status();
    const j = JSON.stringify(s);
    if (force || j !== lastStatusJson) { lastStatusJson = j; mon.emit('status', s); }
  }

  // ---- alerts ----

  function emitAlert(id, reason) { const row = store.alert(id); mon.emit('alert', row, reason); return row; }

  function raise(kind, { severity, title, body = null, data = null } = {}) {
    const s = settings(), rule = s.rules[kind];
    if (!rule?.enabled) return null;
    const sev = severity ?? rule.severity, t = nowS();
    if (kind !== 'new_field') {
      const last = store.lastAlertOfKind(tid(), kind);
      if (last && t - last.t < s.thresholds.dedupeMin * 60 && RANK[last.severity] >= RANK[sev]) return null;
    }
    const pos = posData();
    const id = store.insertAlert({ t, tracker_id: tid(), kind, severity: sev, title, body, data: pos ? { ...data, position: pos } : data, incident: 0 });
    store.updateAlert(id, { last_sent_at: t });
    return emitAlert(id, 'open');
  }

  // Evidence for the one open escape incident of the tracker: opens it, or appends and maybe raises its severity.
  function evidence(kind, data, { title, body = null }, escapeT = null) {
    if (walkKv() || !yard()) return;
    const s = settings(), rule = s.rules[kind];
    if (!rule?.enabled) return;
    const sev = rule.severity, t = nowS(), pos = posData();
    const item = { kind, t, ...data };
    const inc = store.openIncident(tid());
    if (inc) {
      const d = { ...inc.data, evidence: [...(inc.data?.evidence ?? []), item].slice(-C.maxEvidence) };
      if (pos) d.position = pos;
      if (escapeT != null) d.escape_t_outside = escapeT;
      // evidence after a quiet period is a new escape inside a stale incident; alert again and restart repeats
      const quiet = t - (inc.data?.evidence?.at(-1)?.t ?? inc.t) >= C.quietS;
      if (RANK[sev] > RANK[inc.severity] || quiet) {
        store.updateAlert(inc.id, {
          kind, severity: RANK[sev] > RANK[inc.severity] ? sev : inc.severity, title, body, data: d, last_sent_at: t,
          ...(quiet && { acked_at: null, acked_by: null, sent_count: 0 }),
        });
        emitAlert(inc.id, 'rise');
        if (quiet && s.chase.auto) track(startChase('auto', inc.id));
      } else {
        store.updateAlert(inc.id, { data: d });
        emitAlert(inc.id, 'update');
      }
      return;
    }
    const d = { evidence: [item], ...(pos && { position: pos }), ...(escapeT != null && { escape_t_outside: escapeT }) };
    const id = store.insertAlert({ t, tracker_id: tid(), kind, severity: sev, title, body, data: d, incident: 1 });
    store.updateAlert(id, { last_sent_at: t });
    emitAlert(id, 'open');
    if (s.chase.auto) track(startChase('auto', id));
  }

  function closeIncident(inc, by) {
    store.updateAlert(inc.id, { closed_at: nowS(), closed_by: by });
    return emitAlert(inc.id, 'close');
  }

  // ---- fix handling ----

  function resetExcursion() {
    uncertainRun = []; outsideRun = 0; possible = null; firstOutside = null; confirmed = false; escapeDone = false;
  }

  function confirmEscape(reason, d, acc) {
    let escapeT = null;
    const w = walkKv();
    if (!escapeDone && lastHomeFix && firstOutside) { // no escape row without a known home state
      store.insertEscape({ tracker_id: tid(), t_inside: lastHomeFix.t, t_outside: firstOutside.t, note: w ? 'walk' : null, dismissed: w ? 1 : 0 });
      escapeDone = true;
      escapeT = firstOutside.t;
    }
    confirmed = true;
    possible = null;
    evidence('out_confirmed', { reason, d: Math.round(d) }, { title: 'OUT of the yard', body: `${Math.round(d)} m from the fence (±${Math.round(acc)} m).` }, escapeT);
  }

  // A home fix, or entering a home Wi-Fi zone: closes the incident and starts a new excursion.
  function cameHome(row) {
    const inc = store.openIncident(tid());
    if (inc) {
      closeIncident(inc, 'home');
      raise('back_home', { title: 'Back in the yard', body: `Out for ${fmtDur(nowS() - inc.t)}`, data: { incidentId: inc.id } });
      track(endChase('closed'));
    }
    if (walkKv()?.sawOutside) store.delKv('walk');
    resetExcursion();
    home = true;
    lastHomeFix = row;
  }

  // Being in a home Wi-Fi zone without a fix: stored as a 'zone' position so escape detection sees the return.
  function zoneHome(z) {
    const row = { tracker_id: tid(), t: nowS(), lat: z.lat, lng: z.lng, acc: 30, sensor: 'KNOWN_WIFI', psz_id: z.id, source: 'zone' };
    store.insertPosition(row);
    cameHome(row);
  }

  // Sets the home state from a fix without raising or closing anything.
  function seed(row, cls) {
    if (HOME.has(cls)) { home = true; lastHomeFix = row; } else if (cls === 'away') home = false;
  }

  function handleFix(row) {
    const y = yard();
    if (!y) { lastFix = null; return; }
    const s = settings();
    const chasing = !!chaseKv();
    const { cls, d } = classify(row, y.polygon, s.analysis);
    lastFix = { cls, d, t: row.t };
    if (cls === 'psz') lastPszId = row.psz_id ?? lastPszId;
    if (nowS() - row.t > C.staleFixS) { seed(row, cls); return; } // an hours-old fix (after a restart) raises nothing
    if (HOME.has(cls)) {
      cameHome(row);
    } else if (cls === 'away') {
      home = false;
    } else if (cls === 'uncertain') {
      uncertainRun.push(row);
      const span = row.t - uncertainRun[0].t;
      if (home && uncertainRun.length >= C.uncertainCount && span >= C.uncertainSpanS) {
        // fence jitter opens at most one out_possible incident per dedupe period
        const lastP = store.lastAlertOfKind(tid(), 'out_possible');
        const recent = !store.openIncident(tid()) && lastP && nowS() - lastP.t < s.thresholds.dedupeMin * 60;
        if (!recent) {
          evidence('out_possible', { reason: 'uncertain', d: Math.round(d) },
            { title: 'Possibly out of the yard', body: `Three uncertain fixes near the fence in ${span} s.` });
        }
        uncertainRun = [];
      }
    } else { // outside
      const w = walkKv();
      if (w && !w.sawOutside) store.setKv('walk', { ...w, sawOutside: true });
      const acc = row.acc > 0 ? row.acc : 50;
      firstOutside ??= row;
      if (!confirmed && (d > Math.max(3 * acc, 30) || outsideRun >= 1)) confirmEscape(outsideRun >= 1 ? 'second' : 'far', d, acc);
      else if (home && !confirmed) {
        evidence('out_possible', { reason: 'outside', d: Math.round(d) }, {
          title: 'Possibly out of the yard',
          body: `First fix outside the fence: ${Math.round(d)} m out (±${Math.round(acc)} m, ${row.sensor ?? 'unknown'}).`,
        });
        possible = { at: now(), from: 'outside', d, acc };
      }
      outsideRun++;
      home = false;
      uncertainRun = [];
    }
    if (cls !== 'psz' && cls !== 'away') {
      lastGpsFix = row;
      const c = chaseKv();
      if (chasing && c) { // the fix that starts a chase travels in the 'chase' event instead
        if (c.last) c.distanceM += distanceM(c.last, row);
        c.last = { lat: row.lat, lng: row.lng };
        store.setKv('chase', c);
        mon.emit('chase-position', row);
      }
      if (Math.abs(d) <= s.yardWatch.nearFenceM) nearFenceUntil = now() + s.yardWatch.nearFenceHoldMin * 60_000;
    }
  }

  // seed the home state from the current position once the yard is known.
  function reclassify() {
    const y = yard(), pos = st()?.position;
    if (!y) lastFix = null;
    else if (pos) {
      const row = positionRow(tid(), pos, 'channel');
      const { cls, d } = classify(row, y.polygon, settings().analysis);
      lastFix = { cls, d, t: row.t };
      seed(row, cls);
    }
    // on (re)start the tracker may already be in a home zone, with no zone entry or fix still to come
    const z = y && st()?.pszId ? pszFlags().find((f) => f.id === st().pszId) : null;
    if (z?.geometric && (!home || store.openIncident(tid()))) zoneHome(z);
    notify(true);
  }

  function leftPsz(zoneId) {
    const z = pszFlags().find((f) => f.id === zoneId);
    const name = z?.name ?? live.pszName?.(zoneId) ?? 'unknown';
    const data = { zoneId, zoneName: name };
    if (z?.coversYard) {
      evidence('left_psz', data, { title: `Left Wi-Fi zone ${name}`, body: `The tracker left ${name}, which covers the yard. No GPS fix yet.` });
    } else {
      raise('left_psz', { severity: 'warn', title: `Left Wi-Fi zone ${name}`, body: `The tracker left ${name}.`, data });
    }
  }

  function handleChange(cur, keys, prev) {
    const s = settings(), t = s.thresholds;
    if (keys.includes('lastStatusAt') || keys.includes('position')) offlineRaised = false;
    // left_psz, once per transition
    if ((cur.pszId && cur.pszId !== prev.pszId) || (cur.stateReason === 'POWER_SAVING' && prev.stateReason !== 'POWER_SAVING')) leftArmed = true;
    if (cur.pszId && cur.pszId !== prev.pszId) { // entering a home zone may come without a newer position
      const z = pszFlags().find((f) => f.id === cur.pszId);
      if (z?.geometric) zoneHome(z);
    }
    const byKey = prev.pszId && !cur.pszId;
    // charging (or any other reason) replaces POWER_SAVING without leaving the zone
    const byReason = prev.stateReason === 'POWER_SAVING' && cur.stateReason == null && cur.charging !== 'CHARGING' && lastFix?.cls === 'psz';
    // the same status may carry a fresh fix inside the yard ('change' is emitted before 'position')
    const y = yard();
    const fix = keys.includes('position') && y && cur.position ? positionRow(tid(), cur.position, 'channel') : null;
    const fixHome = !!fix && nowS() - fix.t <= C.staleFixS && HOME.has(classify(fix, y.polygon, s.analysis).cls);
    if ((byKey || byReason) && leftArmed && !fixHome) {
      leftArmed = false;
      leftPsz(prev.pszId ?? lastPszId);
    }
    if (prev.battery != null && cur.battery != null) {
      if (prev.battery > t.batteryLow && cur.battery <= t.batteryLow) raise('battery_low', { title: `Battery low: ${cur.battery} %` });
      if (prev.battery > t.batteryCritical && cur.battery <= t.batteryCritical) raise('battery_critical', { title: `Battery critical: ${cur.battery} %` });
    }
    if (prev.charging != null && (prev.charging === 'CHARGING') !== (cur.charging === 'CHARGING')) {
      raise('charging', { title: cur.charging === 'CHARGING' ? 'Charging started' : 'Charging stopped' });
    }
    if (OFFLINE_STATES.has(cur.state) && !OFFLINE_STATES.has(prev.state)) raiseOffline(cur);
    const pl = prev.controls.live, cl = cur.controls.live;
    if (pl.active && !cl.active && !cl.pending) { manual = false; startedByApp = false; }
    if (chaseKv() && cur.battery != null && cur.battery <= s.chase.minBattery) chaseBatteryFloor(cur.battery);
  }

  function raiseOffline(cur) {
    const last = Math.max(cur.lastStatusAt ?? 0, cur.position?.t ?? 0);
    const open = store.openIncident(tid());
    raise('offline', { severity: open ? 'critical' : undefined, title: 'Tracker offline', body: `${cur.stateLabel}, last report ${fmtDur(nowS() - last)} ago.` });
  }

  function chaseBatteryFloor(b) {
    track(endChase('battery'));
    raise('chase_low_battery', { title: 'Live tracking stopped to save the last battery; normal tracking continues', body: `Battery ${b} %.` });
  }

  // ---- commands and the reconciler ----

  async function runCommand(actor, name, on, id = tid()) {
    const t = nowS();
    const done = (ok, result) => {
      store.logCommand({ t, actor, action: `command:${name}`, params: { tracker: id, on }, ok, result });
      mon.emit('command', store.commands(1)[0]);
    };
    let r;
    try {
      r = await sendCommand(id, name, on);
    } catch (e) {
      done(false, e?.message ?? String(e));
      throw e;
    }
    live.applyCommandResult(id, name, r);
    done(true, r);
    return r;
  }

  function wanted() {
    const s = settings();
    const yw = !walkKv() && ywStatus === 'active' && (s.yardWatch.mode === 'live' || nearFenceUntil > now());
    return manual || !!chaseKv() || yw;
  }

  function updateYardWatch() {
    const cur = st();
    const r = yardWatchStatus({
      yw: settings().yardWatch, nowMs: now(), tz, battery: cur?.battery ?? 100,
      charging: cur?.charging === 'CHARGING', inPsz: !!cur?.pszId, lowLatched,
    });
    ywStatus = r.status;
    lowLatched = r.lowLatched;
  }

  function fail(msg) {
    failures++;
    if (failures >= 3) {
      if (!failedRaised) raise('live_failed', { title: 'Live tracking could not be started', body: `3 attempts failed: ${msg}` });
      failedRaised = true;
      nextReconcileAt = now() + C.reconcileBackoffS * 1000;
    }
  }

  async function doReconcile(force) {
    const cur = st();
    if (!cur) return;
    updateYardWatch();
    const c = cur.controls.live, nowMs = now(), want = wanted();
    if (!c.pending) pendingSince = null;
    else if (pendingSince != null && nowMs - pendingSince >= C.pendingFailS * 1000) { pendingSince = null; fail('the command stayed pending for 60 s'); }
    if (!c.pending && c.active === want) { failures = 0; failedRaised = false; }
    if (!force && nowMs < nextReconcileAt) return;
    const decision = liveDecision({
      wanted: want, inPsz: !!cur.pszId, active: c.active, remainingS: c.at == null ? 0 : c.remaining - (nowS() - c.at),
      startedByApp, userOff, sinceLastCmdS: force ? 999 : (nowMs - lastLiveCmdAt) / 1000,
    });
    if (!decision) return;
    const on = decision === 'on';
    if (on) startedByApp = true;
    else { startedByApp = false; userOff = false; }
    lastLiveCmdAt = nowMs; // set before the await so overlapping callers see the guard
    try {
      const r = await runCommand('auto:live', 'live_tracking', on);
      pendingSince = r?.pending ? (pendingSince ?? nowMs) : null; // a resend does not restart the pending interval
    } catch (e) {
      fail(e?.message ?? String(e));
    }
  }

  // Reconciles run one at a time and never reject.
  function reconcile({ force = false } = {}) {
    chain = chain.then(() => doReconcile(force)).catch((e) => { log(`monitor: reconcile: ${e?.message ?? e}`); }).then(() => notify());
    return chain;
  }

  // ---- chase ----

  async function startChase(reason, incidentId = null) {
    if (chaseKv()) return;
    if (walkKv()) { log(`monitor: chase (${reason}) not started: walk mode is on`); return; }
    const s = settings(), b = st()?.battery;
    if (b != null && b <= s.chase.minBattery) {
      raise('chase_low_battery', { title: 'Live tracking stopped to save the last battery; normal tracking continues', body: `Battery ${b} %.` });
      return;
    }
    const c = { since: nowS(), incidentId, messages: {}, distanceM: 0, last: null };
    store.setKv('chase', c);
    log(`monitor: chase started (${reason})`);
    mon.emit('chase', { active: true, since: c.since, incidentId, position: lastGpsFix });
    notify();
    await reconcile();
    lastPosRequestAt = now();
    if (posRequestAllowed()) try { await runCommand('auto:chase', 'pos_request', true); } catch (e) { log(`monitor: pos_request failed: ${e?.message ?? e}`); }
  }

  async function endChase(reason) {
    const c = chaseKv();
    if (!c) return;
    // emit while the chase state still exists, so listeners can read the live-location message ids
    mon.emit('chase', { active: false, reason, durationS: nowS() - c.since, distanceM: Math.round(c.distanceM ?? 0), messages: { ...c.messages } });
    store.delKv('chase');
    notify();
    await reconcile();
  }

  // ---- tick ----

  async function tick() {
    const s = settings(), t = s.thresholds, nowMs = now(), ts = nowS(), cur = st();
    try {
      const w = walkKv();
      if (w && ts >= w.until) store.delKv('walk');
      if (possible?.from === 'outside' && !confirmed && nowMs - possible.at >= C.outConfirmS * 1000) confirmEscape('45s', possible.d, possible.acc);
      if (cur && !offlineRaised && !cur.pszId) {
        const last = Math.max(cur.lastStatusAt ?? 0, cur.position?.t ?? 0);
        const limit = (store.openIncident(tid()) ? C.offlineIncidentMin : t.offlineMin) * 60;
        if (last > 0 && ts - last >= limit) { offlineRaised = true; raiseOffline(cur); }
      }
      if (disconnectedSince != null && !channelDownRaised && nowMs - disconnectedSince >= t.channelDownMin * 60_000) {
        channelDownRaised = true;
        raise('channel_down', { title: 'Connection to Tractive lost', body: `No live updates for ${t.channelDownMin} min; reconnecting.` });
      }
      const c = chaseKv();
      if (c) {
        if (ts - c.since >= s.chase.maxHours * 3600) await endChase('timeout');
        else if (cur?.battery != null && cur.battery <= s.chase.minBattery) chaseBatteryFloor(cur.battery);
        else if (posRequestAllowed() && !cur?.controls.live.active && nowMs - lastPosRequestAt >= C.posRequestEveryS * 1000) {
          lastPosRequestAt = nowMs;
          try { await runCommand('auto:chase', 'pos_request', true); } catch (e) { log(`monitor: pos_request failed: ${e?.message ?? e}`); }
        }
      }
      for (const row of store.pendingRepeats()) {
        if (row.sent_count >= t.repeatMax || ts - (row.last_sent_at ?? row.t) < t.repeatMin * 60) continue;
        store.updateAlert(row.id, { sent_count: row.sent_count + 1, last_sent_at: ts });
        mon.emit('repeat', store.alert(row.id));
      }
    } catch (e) {
      log(`monitor: tick: ${e?.stack ?? e}`);
    }
    await reconcile();
    await idle();
  }

  async function idle() { while (pending.size) await Promise.allSettled([...pending]); }

  // ---- listeners ----

  const onChange = safe((id, cur, keys, prev) => {
    if (id !== tid()) return;
    handleChange(cur, keys, prev);
    track(reconcile());
  });
  const onPosition = safe((id, pos) => {
    if (id !== tid()) return;
    handleFix(positionRow(id, pos, 'channel'));
    track(reconcile());
  });

  // ---- public methods ----

  function ownIncident(alertId) {
    const row = store.alert(alertId);
    return row && row.incident === 1 && row.closed_at == null ? row : null;
  }

  function setWalk(minutes, actor) {
    if (minutes == null) store.delKv('walk');
    else {
      store.setKv('walk', { until: nowS() + Math.round(minutes * 60), sawOutside: false });
      track(endChase('walk'));
    }
    log(`monitor: walk ${minutes == null ? 'off' : `${minutes} min`} by ${actor}`);
    track(reconcile());
    notify();
    return walkKv();
  }

  function detectFields(kind, value) {
    const paths = flattenPaths(value), t = nowS();
    // learn silently for the first hour (objects of one kind differ in their keys)
    const since = store.getKv('fieldsSince') ?? (store.setKv('fieldsSince', t), t);
    if (t - since < 3600 || store.knownFieldCount(kind) === 0) {
      for (const p of paths.keys()) store.addField(kind, p, t);
      return [];
    }
    const added = [];
    for (const [p, ex] of paths) {
      if (!store.addField(kind, p, t)) continue;
      added.push(p);
      if (store.countAlertsSince('new_field', t - 86400) >= C.newFieldsPerDay) continue;
      const example = REDACT.test(p) ? '<redacted>' : ex;
      raise('new_field', { title: `New Tractive field: ${p}`, body: `Example: ${typeof example === 'string' ? example : JSON.stringify(example)}`, data: { path: p, kind, example } });
    }
    return added;
  }

  Object.assign(mon, {
    start() {
      live.on('change', onChange);
      live.on('position', onPosition);
      reclassify();
    },
    stop() {
      live.off('change', onChange);
      live.off('position', onPosition);
    },
    idle, tick, reconcile, yard, pszFlags, status, reclassify, detectFields, setWalk, runCommand,
    settings,
    putSettings(input) {
      const r = validateSettings(input);
      if (r.errors) return r;
      store.setKv('settings', r.settings);
      reclassify();
      track(reconcile());
      return { settings: structuredClone(r.settings) };
    },
    ack(alertId, actor) {
      const row = store.alert(alertId);
      if (!row) return null;
      if (row.acked_at != null) return row;
      store.updateAlert(alertId, { acked_at: nowS(), acked_by: actor });
      return emitAlert(alertId, 'ack');
    },
    falseAlarm(alertId, actor) {
      const inc = ownIncident(alertId);
      if (!inc) return null;
      const row = closeIncident(inc, actor);
      track(endChase('closed'));
      notify();
      return row;
    },
    itsAWalk(alertId, actor) {
      const inc = ownIncident(alertId);
      if (!inc) return null;
      const row = closeIncident(inc, 'walk');
      const tOut = inc.data?.escape_t_outside;
      if (tOut != null) {
        const esc = store.escapes(inc.tracker_id, tOut, tOut)[0];
        if (esc) store.updateEscape(esc.id, { dismissed: 1, note: 'walk' });
      }
      track(endChase('closed'));
      setWalk(C.itsAWalkMin, actor);
      notify();
      return row;
    },
    async setManualLive(on, actor) {
      manual = !!on;
      userOff = !on;
      store.logCommand({ t: nowS(), actor, action: 'manual-live', params: { tracker: tid(), on: !!on }, ok: true });
      await reconcile({ force: true }); // an explicit toggle bypasses the 30 s guard once
    },
    async setChase(on, actor) {
      log(`monitor: chase ${on ? 'on' : 'off'} by ${actor}`);
      if (on) await startChase('manual', null);
      else await endChase('manual');
    },
    setYardWatch(enabled, actor) {
      const s = settings();
      s.yardWatch.enabled = !!enabled;
      log(`monitor: yard watch ${enabled ? 'on' : 'off'} by ${actor}`);
      return mon.putSettings(s);
    },
    async command(actor, id, name, on) {
      if (name === 'live_tracking') throw new Error('use setManualLive for live tracking');
      return runCommand(actor, name, on, id);
    },
    chaseState: () => chaseKv(),
    setChaseMessage(chatId, messageId) {
      const c = chaseKv();
      if (!c) return;
      if (messageId == null) delete c.messages[chatId];
      else c.messages[chatId] = messageId;
      store.setKv('chase', c);
    },
    onTimelineEvents: safe((events) => {
      const base = store.getKv('timelineSeen');
      if (base == null) { store.setKv('timelineSeen', nowS()); return; } // F17: unix seconds
      let max = base;
      for (const e of events ?? []) {
        const ms = Date.parse(e?.occurredAt ?? e?.startedAt);
        if (!Number.isFinite(ms)) continue;
        const t = Math.floor(ms / 1000);
        if (t <= base) continue;
        max = Math.max(max, t);
        if (home && lastHomeFix && t <= lastHomeFix.t) continue; // seen home after this event
        const data = { zoneName: e.zoneName ?? null, eventId: e.id ?? null };
        if (e.type === 'safezoneExit') evidence('fence_exit', data, { title: `Tractive: left fence ${e.zoneName}` });
        else if (e.type === 'dangerzoneEnter') evidence('danger_enter', data, { title: `Tractive: entered danger zone ${e.zoneName}` });
      }
      if (max > base) store.setKv('timelineSeen', max);
      notify();
    }),
    onChannelStatus(s) {
      if (s?.connected) { disconnectedSince = null; channelDownRaised = false; } else disconnectedSince ??= now();
    },
  });
  return mon;
}
