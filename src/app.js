// Wiring: Tractive client → live state → monitor → Telegram and SSE events, the startup sequence, periodic jobs,
// retention and the app-level helpers the HTTP API uses. createApp has no process side effects (main.js owns those).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createTractive } from './tractive.js';
import { LiveState, normalizePosition, positionRow } from './state.js';
import { createMonitor } from './monitor.js';
import { createTelegram } from './telegram.js';
import { analyze, classify, detectEpisodes, reconcileStored } from './escapes.js';
import { perimeterLength } from './geo.js';

const { version } = createRequire(import.meta.url)('../package.json');
const DAY = 86400;
const MIN = 60e3;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_IMAGE = 2 * 1024 * 1024;
const RECOMPUTE_MAX = 200_000; // positions one recompute reads at most

// Merges [from, to] windows that overlap or touch.
function mergeWindows(list) {
  const out = [];
  for (const [a, b] of list.filter(([x, y]) => y >= x).sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function createApp({
  env = process.env, store, dataDir = env.DATA_DIR || 'data', log = console.log, now = Date.now, tractiveOptions = {}, telegramOptions = {},
}) {
  const app = new EventEmitter();
  const nowS = () => Math.floor(now() / 1000);
  const tz = env.TZ || 'UTC';
  const followed = () => app.followedId;
  const errText = (e) => e?.state ?? e?.message ?? String(e);
  // every listener and background job catches and logs its own errors
  const guard = (what, fn) => (...a) => {
    try {
      const r = fn(...a);
      if (r && typeof r.catch === 'function') r.catch((e) => log(`${what}: ${errText(e)}`));
    } catch (e) {
      log(`${what}: ${errText(e)}`);
    }
  };
  const emitEvent = (name, data) => app.emit('event', name, data);

  const zones = (tid = followed()) => store.getRaw(`psz:${tid}`) ?? [];
  const rawPrefix = (prefix) => store.all('SELECT json FROM raw WHERE kind LIKE ? ORDER BY kind', `${prefix}%`).map((r) => r.json);
  const petOf = (tid) => rawPrefix('pet:').find((p) => p?.device_id === tid) ?? null;
  const pszPins = () => zones().filter((z) => Array.isArray(z.latlong)).map((z) => ({ id: z._id, lat: z.latlong[0], lng: z.latlong[1] }));

  const bases = {
    graph: env.TRACTIVE_GRAPH_URL || 'https://graph.tractive.com/4',
    aps: env.TRACTIVE_APS_URL || 'https://aps-api.tractive.com/api/1',
    timeline: env.TRACTIVE_TIMELINE_URL || 'https://prod.eu-central-1.event-timeline-api.tractive.com/api/1',
  };
  const tractive = createTractive({
    graphUrl: bases.graph, apsUrl: bases.aps, timelineUrl: bases.timeline,
    channelUrl: env.TRACTIVE_CHANNEL_URL || 'https://channel.tractive.com/3/channel',
    clientId: env.TRACTIVE_CLIENT_ID || '625e533dc3c3b41c28a669f0',
    email: env.TRACTIVE_EMAIL, password: env.TRACTIVE_PASSWORD,
    tokenFile: path.join(dataDir, '.tractive-token.json'), tz,
    minGapMs: Number(env.TRACTIVE_MIN_GAP_MS || 5000), log, now, ...tractiveOptions,
  });
  const live = new LiveState({ now, pszPins, pszName: (id) => zones().find((z) => z._id === id)?.name ?? null });
  const posRequestAllowed = () => store.getRaw('user')?.settings?.pos_request_allowed === true;
  const monitor = createMonitor({ store, live, trackerId: followed, posRequestAllowed, sendCommand: (id, name, on) => tractive.command(id, name, on), now, tz, log });
  const telegram = createTelegram({
    token: env.TELEGRAM_BOT_TOKEN || '', apiUrl: env.TELEGRAM_API_URL || undefined,
    chatIds: (env.TELEGRAM_CHAT_IDS || '').split(',').map((s) => s.trim()).filter((s) => /^-?\d{1,20}$/.test(s)),
    botName: env.TELEGRAM_BOT_NAME || undefined, store, monitor, live, trackerId: followed, posRequestAllowed,
    petName: () => petOf(followed())?.details?.name || 'The dog', escapesSummary: () => escapesSummary(),
    appUrl: env.APP_URL || '', now, log, ...telegramOptions,
  });

  let backfillPendingDays = 0;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  // ---- raw objects ----

  // Stores the raw object and feeds it to the unknown-field detector (arrays element by element).
  function keep(kind, value, fieldKind) {
    store.setRaw(kind, value);
    if (value == null) return value;
    for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === 'object') monitor.detectFields(fieldKind, v);
    return value;
  }

  const insertRest = (tid, list) => {
    const pins = tid === followed() ? pszPins() : [];
    const rows = (list ?? []).map((p) => normalizePosition(p, { pszPins: pins, nowS: nowS() })).filter(Boolean).map((pos) => positionRow(tid, pos, 'rest'));
    return store.insertPositions(rows);
  };

  const loaders = {
    tracker: async (tid) => { const t = keep(`tracker:${tid}`, await tractive.tracker(tid), 'tracker'); live.applyTracker(t); return t; },
    commands: async (tid) => { const l = keep(`commands:${tid}`, await tractive.commandStates(tid), 'command_state'); live.applyCommandStates(tid, l); return l; },
    geofences: async (tid) => { const l = keep(`geofences:${tid}`, await tractive.geofences(tid), 'geofence'); if (tid === followed()) monitor.reclassify(); return l; },
    psz: async (tid) => { const l = keep(`psz:${tid}`, await tractive.powerSavingZones(tid), 'psz'); if (tid === followed()) monitor.reclassify(); return l; },
    shares: async (tid) => keep(`shares:${tid}`, await tractive.publicShares(tid), 'share'),
    reachable: async (tid) => keep(`reachable:${tid}`, await tractive.reachableNotification(tid), 'reachable'),
    hw: async (tid) => keep(`hw:${tid}`, await tractive.hwReport(tid), 'hw'),
    pos: async (tid) => keep(`pos:${tid}`, await tractive.posReport(tid), 'pos'),
    range: async (tid) => keep(`range:${tid}`, await tractive.positionsRange(tid), 'range'),
    health: async (pid) => keep(`health:${pid}`, await tractive.health(pid), 'health'),
    timeline: async (pid) => {
      const tl = keep(`timeline:${pid}`, await tractive.timeline(pid), 'timeline');
      monitor.onTimelineEvents(tl?.events ?? []);
      return tl;
    },
    weight: async (pid) => keep(`weight:${pid}`, await tractive.weightHistory(pid), 'weight'),
  };

  const SYNC = { geofence: ['geofences'], power_saving_zone: ['psz'], public_share: ['shares'], tracker: ['tracker', 'commands'] };
  async function refresh(kind, tid = followed()) {
    const steps = SYNC[kind];
    if (!steps) throw new RangeError(`unknown refresh kind ${kind}`);
    if (!tid) return null;
    let first;
    for (const s of steps) { const r = await loaders[s](tid); first ??= r; }
    emitEvent('state', app.statePayload());
    return first;
  }

  // ---- wiring ----

  tractive.on('channel-message', guard('channel message', (msg) => {
    if (msg?.message === 'tracker_status') {
      const id = msg.tracker_id;
      live.applyStatus(msg);
      if (id) {
        store.setRaw(`status:${id}`, msg);
        const hw = msg.hardware;
        if (typeof hw?.time === 'number') {
          const st = live.get(id);
          store.insertHw({ tracker_id: id, t: hw.time, battery: hw.battery_level ?? null, charging: st?.charging ?? null, psz_id: st?.pszId ?? null });
        }
      }
      monitor.detectFields('tracker_status', msg);
    }
    if (msg?.message !== 'keep-alive') {
      const t = nowS();
      store.logChannel(t, msg?.message ?? null, msg);
      emitEvent('channel', { kind: 'message', t, message: msg?.message ?? null, json: msg });
    }
  }));
  tractive.on('channel-status', guard('channel status', (s) => {
    live.setChannel(s);
    monitor.onChannelStatus(s);
    emitEvent('channel', { kind: 'status', ...s });
  }));
  tractive.on('sync', guard('sync', (kind) => refresh(kind)));
  tractive.on('login', guard('login', (s) => { if (s === 'ok' && started) return boot(); return null; }));

  live.on('position', guard('position', (id, pos) => {
    store.insertPosition(positionRow(id, pos, 'channel'));
    emitEvent('position', { trackerId: id, pos });
  }));
  live.on('drop', (id, why) => { if (why !== 'not newer') log(`position dropped for ${id}: ${why}`); });
  live.on('change', guard('change', (id, st) => emitEvent('state', { trackerId: id, tracker: st, monitor: monitor.status() })));

  monitor.on('alert', guard('alert', (row, reason) => {
    emitEvent('alert', row);
    return telegram.onAlert(row, reason);
  }));
  monitor.on('repeat', guard('repeat', (row) => telegram.onRepeat(row)));
  monitor.on('chase', guard('chase', (ev) => {
    const p = telegram.onChase(ev);
    emitEvent('state', { monitor: monitor.status() });
    return p;
  }));
  monitor.on('chase-position', guard('chase position', (row) => telegram.onChasePosition(row)));
  monitor.on('command', guard('command event', (row) => emitEvent('command', row)));
  monitor.on('status', guard('status event', (s) => emitEvent('state', { monitor: s })));

  // ---- startup ----

  let started = false, stopped = false, bootP = null, bootRetry = null, coreStarted = false, liveStarted = false;
  const timers = [];

  async function loadTrackers() {
    const ids = (await tractive.trackers()).map((s) => s?._id).filter((id) => typeof id === 'string');
    for (const id of ids) {
      try { await loaders.tracker(id); } catch (e) { log(`tracker ${id}: ${errText(e)}`); }
    }
    app.trackerIds = ids;
    const listed = (id) => (id && ids.includes(id) ? id : null);
    app.followedId = listed(env.TRACTIVE_TRACKER_ID) ?? listed(env.TRACTIVE_TRACKER_HINT)
      ?? ids.find((id) => store.getRaw(`tracker:${id}`)?.state !== 'NO_SUBSCRIPTION') ?? ids[0] ?? null;
  }

  function every(ms, what, fn) {
    const t = setInterval(guard(what, fn), ms);
    t.unref();
    timers.push(t);
  }

  // the monitor tick (repeats of a persisted incident) and Telegram do not wait for Tractive.
  function startCore() {
    if (coreStarted) return;
    coreStarted = true;
    monitor.start();
    guard('telegram start', () => telegram.start())();
    every(10e3, 'tick', () => monitor.tick());
  }

  function startLive() {
    tractive.startChannel();
    monitor.reclassify(); // the followed tracker is known now
    if (liveStarted) return;
    liveStarted = true;
    const pet = () => petOf(followed())?._id;
    every(30 * MIN, 'health', () => pet() && loaders.health(pet()));
    every(5 * MIN, 'timeline', () => pet() && loaders.timeline(pet()));
    every(15 * MIN, 'trackers', async () => { // one failing tracker does not skip the others
      for (const id of app.trackerIds) { try { await loaders.tracker(id); } catch (e) { log(`tracker ${id}: ${errText(e)}`); } }
    });
    every(60 * MIN, 'positions', async () => followed() && insertRest(followed(), await tractive.positions(followed(), nowS() - 2 * 3600, nowS())));
    const first = setTimeout(() => { guard('retention', retention)(); every(DAY * 1000, 'retention', retention); }, 10 * MIN);
    first.unref();
    timers.push(first);
  }

  async function background() {
    const tid = followed();
    const steps = [
      ['pets', async () => { for (const s of await tractive.pets()) if (s?._id) keep(`pet:${s._id}`, await tractive.pet(s._id), 'pet'); }],
      ['geofences', () => tid && loaders.geofences(tid)],
      ['power saving zones', () => tid && loaders.psz(tid)],
      ['command states', () => tid && loaders.commands(tid)],
      ['public shares', () => tid && loaders.shares(tid)],
      ['subscriptions', async () => { for (const s of await tractive.subscriptions()) if (s?._id) keep(`subscription:${s._id}`, await tractive.subscription(s._id), 'subscription'); }],
      ['user', async () => keep('user', await tractive.user(), 'user')],
      ['config', async () => keep('config', await tractive.config(), 'config')],
      ['health', () => petOf(tid)?._id && loaders.health(petOf(tid)._id)],
      ['timeline', () => petOf(tid)?._id && loaders.timeline(petOf(tid)._id)],
      ['weight', () => petOf(tid)?._id && loaders.weight(petOf(tid)._id)],
      ['reachable', () => tid && loaders.reachable(tid)],
      ['hw report', () => tid && loaders.hw(tid)],
      ['pos report', () => tid && loaders.pos(tid)],
      ['positions range', () => tid && loaders.range(tid)],
      ['positions', async () => tid && insertRest(tid, await tractive.positions(tid, nowS() - 2 * DAY, nowS()))],
    ];
    for (const [what, fn] of steps) {
      if (stopped) return;
      try { await fn(); } catch (e) { log(`startup ${what}: ${errText(e)}`); }
    }
    emitEvent('state', app.statePayload());
  }

  // Steps 2-4; resolves after step 3. A failed tracker list is retried in 60 s (and on the next successful login).
  function boot() {
    bootP ??= (async () => {
      try {
        await loadTrackers();
      } catch (e) {
        log(`startup trackers: ${errText(e)}`);
        bootP = null;
        readyResolve();
        if (!stopped) { clearTimeout(bootRetry); bootRetry = setTimeout(guard('startup retry', boot), 60e3); bootRetry.unref(); }
        return;
      }
      startLive();
      background().catch((e) => log(`startup: ${errText(e)}`)).finally(readyResolve);
    })();
    return bootP;
  }

  async function start() {
    started = true;
    startCore();
    try {
      if (tractive.status().login !== 'ok') await tractive.login(); // a cached valid token needs no call
    } catch (e) {
      log(`tractive login: ${errText(e)}`);
      readyResolve();
      return;
    }
    await boot();
  }

  async function stop() {
    stopped = true;
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    timers.length = 0;
    clearTimeout(bootRetry);
    tractive.close();
    await telegram.stop();
    monitor.stop();
  }

  // ---- jobs ----

  function retention() {
    const tid = followed(), y = monitor.yard();
    if (!tid || !y) return 0;
    const before = nowS() - 90 * DAY, analysis = monitor.settings().analysis;
    const escs = store.escapes(tid, 0, before + 600);
    return store.thinPositions(tid, before, (row) => {
      const { cls, d } = classify(row, y.polygon, analysis);
      return cls === 'inside' && d < -30 && !escs.some((e) => e.t_outside - row.t >= 0 && e.t_outside - row.t <= 600);
    });
  }

  async function backfill({ trackerId, from, to }) {
    const days = [];
    for (let a = from; a < to; a += DAY) days.push([a, Math.min(a + DAY, to)]);
    backfillPendingDays += days.length;
    let left = days.length;
    try {
      for (const [a, b] of days) {
        insertRest(trackerId, await tractive.positions(trackerId, a, b));
        left--;
        backfillPendingDays--;
      }
    } catch (e) {
      log(`backfill: ${errText(e)}`);
    } finally {
      backfillPendingDays -= left;
    }
    return days.length - left;
  }

  function yardOut(y) {
    return y && { id: y.id, name: y.name, polygon: y.polygon.map((p) => [p.lat, p.lng]), perimeter_m: perimeterLength(y.polygon) };
  }

  // fixes only around stored episodes plus the requested range capped at 31 days.
  function escapes({ trackerId, from, to }) {
    const y = trackerId === followed() ? monitor.yard() : null;
    const blind = trackerId === followed() ? monitor.pszFlags().filter((z) => z.coversYard).map(({ id, name }) => ({ id, name })) : [];
    if (!y) return { yard: null, blind, episodes: [], strip: [], peaks: [] };
    const stored = store.escapes(trackerId, from, to);
    const windows = mergeWindows([
      [Math.max(from - 3600, to - 31 * DAY), to],
      ...stored.map((s) => [(s.t_inside ?? s.t_outside) - 600, s.t_outside + 900]),
    ]);
    const fixes = windows.flatMap(([a, b]) => store.positionsAsc(trackerId, a, b));
    const pszNames = Object.fromEntries(zones(trackerId).map((z) => [z._id, z.name]));
    const r = analyze({ fixes, poly: y.polygon, settings: monitor.settings().analysis, now: nowS(), stored, pszNames });
    return { yard: yardOut(y), blind, episodes: r.episodes, strip: r.strip, peaks: r.peaks };
  }

  function escapesSummary() {
    const tid = followed();
    if (!tid) return [];
    return escapes({ trackerId: tid, from: nowS() - 30 * DAY, to: nowS() }).episodes.slice(-5).reverse()
      .map(({ t_outside, quality, gap_s }) => ({ t_outside, quality, gap_s }));
  }

  function recompute({ trackerId, from, to }) {
    const y = trackerId === followed() ? monitor.yard() : null;
    if (!y) return { inserted: 0, deleted: 0 };
    const fixes = store.positionsAsc(trackerId, from - 3600, to, RECOMPUTE_MAX + 1);
    if (fixes.length > RECOMPUTE_MAX) { // a truncated read would delete valid later episodes
      log(`recompute: more than ${RECOMPUTE_MAX} positions in the range; nothing changed`);
      return { inserted: 0, deleted: 0, truncated: true };
    }
    const detected = detectEpisodes(fixes, y.polygon, { settings: monitor.settings().analysis, now: nowS() }).filter((e) => e.t_outside >= from);
    const { insert, remove } = reconcileStored(detected, store.escapes(trackerId, from, to), from, to);
    for (const e of insert) store.insertEscape({ tracker_id: trackerId, ...e });
    return { inserted: insert.length, deleted: remove.length ? store.deleteEscapes(remove) : 0 };
  }

  async function petPhoto(pid) {
    const pic = store.getRaw(`pet:${pid}`)?.details?.profile_picture_id;
    if (typeof pic !== 'string' || !/^[a-f0-9]{24}$/.test(pic)) return null; // the id becomes a file name
    const dir = path.join(dataDir, 'cache');
    for (const [type, ext] of Object.entries(IMAGE_EXT)) {
      try { return { type, buf: fs.readFileSync(path.join(dir, `${pic}.${ext}`)) }; } catch { /* not cached in this format */ }
    }
    const { type, buf } = await tractive.petPhoto(pic);
    if (!IMAGE_EXT[type] || buf.length > MAX_IMAGE) return { error: 'unsupported image' };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${pic}.${IMAGE_EXT[type]}`), buf, { mode: 0o600 });
    return { type, buf };
  }

  async function audit(actor, action, params, fn) {
    const t = nowS();
    let ok = false, result, error;
    try {
      result = await fn();
      ok = true;
      return result;
    } catch (e) {
      error = e;
      throw e;
    } finally {
      store.logCommand({ t, actor, action, params, ok, result: ok ? 'ok' : error?.message ?? String(error) });
      emitEvent('command', store.commands(1)[0]);
    }
  }

  // Loads anything missing (or everything with refresh) for one tracker, then answers from the raw objects.
  async function trackerPayload(tid, { refresh: again = false } = {}) {
    const raw = (k) => store.getRaw(`${k}:${tid}`);
    for (const k of ['tracker', 'commands', 'psz', 'shares', 'reachable']) if (again || raw(k) == null) await loaders[k](tid);
    const flags = new Map(tid === followed() ? monitor.pszFlags().map((f) => [f.id, f]) : []);
    const cur = live.get(tid)?.pszId ?? null;
    return {
      tracker: raw('tracker'), readOnly: tid !== followed(),
      subscription: rawPrefix('subscription:').find((s) => s?.tracker_id === tid) ?? null,
      psz: (raw('psz') ?? []).map((z) => ({ ...z, coversYard: flags.get(z._id)?.coversYard ?? false, geometric: flags.get(z._id)?.geometric ?? false, current: cur === z._id })),
      shares: raw('shares') ?? [], commandStates: raw('commands') ?? [], reachable: raw('reachable'), hw: raw('hw'), pos: raw('pos'), range: raw('range'),
    };
  }

  function statePayload() {
    const ts = tractive.status(), s = monitor.settings(), fid = followed();
    return {
      followed: fid, timeZone: tz, version,
      trackers: app.trackerIds.map((id) => {
        const pet = petOf(id);
        return { ...(live.get(id) ?? { trackerId: id }), followed: id === fid, readOnly: id !== fid, petId: pet?._id ?? null, petName: pet?.details?.name ?? null };
      }),
      capabilities: { posRequest: posRequestAllowed() },
      channel: ts.channel,
      tractive: { login: ts.login, queue: ts.queue, backfillPendingDays },
      monitor: monitor.status(),
      yard: (() => { const y = monitor.yard(); return y && { id: y.id, name: y.name, polygon: y.polygon.map((p) => [p.lat, p.lng]) }; })(),
      psz: monitor.pszFlags(),
      settings: { yardGeofenceId: s.yardGeofenceId, yardWatchEnabled: s.yardWatch.enabled, chaseAuto: s.chase.auto },
      telegram: telegram.status(),
      alerts: { unacked: store.unackedCritical() },
    };
  }

  function retryLogin() {
    bootP = null; // the 'login' listener re-runs steps 2-4 once the login is ok
    tractive.retryLogin();
  }

  return Object.assign(app, {
    tractive, live, monitor, telegram, store, bases, posRequestAllowed, trackerIds: [], followedId: null, ready,
    start, stop, statePayload, trackerPayload, refresh, audit, escapes, escapesSummary, recompute, backfill, retryLogin, petPhoto,
  });
}
