// Tractive client: token cache, single-flight login state machine, prioritised REST queue (gap, 429 penalty,
// retries), every endpoint method and the NDJSON push channel. Never logs or exposes the token or the password.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';

export class TractiveError extends Error {
  constructor(status, code, tractiveMessage) {
    super(`Tractive ${status}: ${tractiveMessage ?? 'request failed'}`);
    this.name = 'TractiveError';
    this.status = status;
    this.code = code;
    this.tractiveMessage = tractiveMessage;
  }
}

export class RateLimited extends TractiveError {
  constructor(retryAfterS) {
    super(429, undefined, 'rate limited');
    this.name = 'RateLimited';
    this.retryAfterS = retryAfterS;
  }
}

export class AuthError extends Error {
  constructor(state) {
    super(`Tractive login ${state}`);
    this.name = 'AuthError';
    this.state = state;
  }
}

export const ALL_TIMELINE_TYPES = ['walk', 'dailyActivityGoalReached', 'safezoneEnter', 'safezoneExit', 'dangerzoneEnter', 'dangerzoneExit', 'insidePowerSavingZone', 'territory', 'birthday'];
const COMMANDS = ['live_tracking', 'led_control', 'buzzer_control', 'pos_request'];
const POWER_MODES = ['LOW', 'BALANCED', 'PRECISION'];
const LIVE_TIMEOUTS = [300, 900, 1800, 3600];
const SYNC_KINDS = new Set(['geofence', 'tracker', 'power_saving_zone', 'public_share']);
const GEOFENCE_KEYS = ['coords', 'shape', 'radius', 'active', 'fence_type', 'name', 'icon'];
const e = encodeURIComponent;

// A sleep that close() or a new queue item can cut short.
function sleeper() {
  let timer, done;
  return {
    wait: (ms) => new Promise((resolve) => { done = resolve; timer = setTimeout(resolve, Math.max(0, ms)); }),
    wake: () => { clearTimeout(timer); done?.(); },
  };
}

export function createTractive({
  graphUrl, channelUrl, apsUrl, timelineUrl, clientId, email, password, tokenFile, tz,
  minGapMs = 5000, penaltyBaseMs = 15000, penaltyMaxMs = 120000, loginBackoffBaseMs = 15000, loginBackoffMaxMs = 600000,
  silenceMs = 30000, reconnectMinMs = 2000, reconnectMaxMs = 60000, syncDebounceMs = 10000, syncMinIntervalMs = 60000,
  requestTimeoutMs = 30000, maxMediaBytes = 2 * 1024 * 1024, fetch: fetchImpl = globalThis.fetch, now = Date.now, random = Math.random, log = () => {},
} = {}) {
  const ee = new EventEmitter();
  const bases = { graph: graphUrl, aps: apsUrl, timeline: timelineUrl };
  const emailSha = crypto.createHash('sha256').update(email ?? '').digest('hex');
  const j = (ms) => ms * (0.8 + 0.4 * random());
  const nowS = () => Math.floor(now() / 1000);
  let closed = false;

  // --- token and login ---
  const valid = (t) => t && t.expires_at - now() / 1000 >= 3600;
  let token = null;
  try {
    const c = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    if (c.email_sha256 === emailSha && c.client_id === clientId && c.access_token) token = c;
  } catch { /* no usable cache */ }
  let state = valid(token) ? 'ok' : 'idle';
  let inflight = null;
  let retryTimer = null;
  let loginFails = 0;

  const setState = (s) => { if (s !== state) { state = s; ee.emit('login', s); } };
  const dropToken = (used) => { if (token === used) token = null; };

  function saveToken(t) {
    try {
      fs.writeFileSync(`${tokenFile}.tmp`, JSON.stringify(t), { mode: 0o600 });
      fs.renameSync(`${tokenFile}.tmp`, tokenFile);
      fs.chmodSync(tokenFile, 0o600);
    } catch (err) {
      log(`tractive: token cache not written (${err.code ?? 'error'})`);
    }
  }

  function scheduleLoginRetry() {
    clearTimeout(retryTimer);
    if (closed) return;
    loginFails++;
    const ms = j(Math.min(loginBackoffMaxMs, loginBackoffBaseMs * 2 ** (loginFails - 1)));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      login().catch((err) => log(`tractive: background login failed (${err.state ?? err.message})`));
    }, ms);
  }

  async function doLogin() {
    if (state === 'bad-credentials') throw new AuthError('bad-credentials');
    let status;
    let body;
    try {
      const res = await fetchImpl(`${graphUrl}/auth/token`, {
        method: 'POST',
        headers: { 'x-tractive-client': clientId, 'content-type': 'application/json;charset=UTF-8', accept: 'application/json' },
        body: JSON.stringify({ platform_email: email, platform_token: password, grant_type: 'tractive' }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      status = res.status;
      body = status === 200 ? await res.json() : (await res.body?.cancel(), null);
    } catch {
      status = undefined;
    }
    log(`POST graph/auth/token ${status ?? 'network error'}`);
    if (status === 200 && body?.access_token) {
      token = { user_id: body.user_id, client_id: clientId, expires_at: body.expires_at, access_token: body.access_token, email_sha256: emailSha };
      saveToken(token);
      loginFails = 0;
      clearTimeout(retryTimer);
      retryTimer = null;
      setState('ok');
      return token;
    }
    if (status === 401 || status === 403) {
      clearTimeout(retryTimer);
      retryTimer = null;
      setState('bad-credentials');
      throw new AuthError('bad-credentials');
    }
    setState('login-retrying');
    scheduleLoginRetry();
    throw new AuthError('login-retrying');
  }

  function login() {
    inflight ??= doLogin().finally(() => { inflight = null; });
    return inflight;
  }

  function ensureToken() {
    if (valid(token)) return Promise.resolve(token);
    if (state === 'login-retrying' && retryTimer) return Promise.reject(new AuthError('login-retrying'));
    return login();
  }

  function retryLogin() {
    clearTimeout(retryTimer);
    retryTimer = null;
    loginFails = 0;
    setState('idle');
    login().catch((err) => log(`tractive: login failed (${err.state ?? err.message})`));
  }

  const headers = (t) => ({
    'x-tractive-client': clientId, 'x-tractive-user': t.user_id, authorization: `Bearer ${t.access_token}`,
    'content-type': 'application/json;charset=UTF-8', accept: 'application/json',
  });

  // --- REST queue ---
  const q = { commands: [], normal: [] };
  const qs = sleeper();
  let pumping = false;
  let lastStart = -Infinity;
  let penaltyUntil = 0;
  let level = 0;
  let last429At = -Infinity;

  function gapMs() {
    if (now() - last429At >= 600000) level = 0;
    return level ? Math.min(16000, minGapMs * 2 ** level) : minGapMs;
  }

  // Synchronous: callers validate, then enqueue before any await; the worker starts on a later tick.
  function enqueue(method, path, { host = 'graph', body, command = false, raw = false, media = false } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new Error('closed'));
      (command ? q.commands : q.normal).push({ method, path, host, body, command, raw, media, resolve, reject, attempts: 0, retries: 0, notBefore: 0, reauthed: false });
      if (pumping) qs.wake();
      else setImmediate(pump);
    });
  }

  function requeue(item) {
    if (closed) return item.reject(new Error('closed'));
    (item.command ? q.commands : q.normal).push(item);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (!closed && (q.commands.length || q.normal.length)) {
      const t = now();
      const start = Math.max(lastStart + gapMs(), penaltyUntil);
      if (start > t) { await qs.wait(start - t); continue; }
      const take = (arr) => { const i = arr.findIndex((x) => x.notBefore <= t); return i < 0 ? null : arr.splice(i, 1)[0]; };
      const item = take(q.commands) ?? take(q.normal);
      if (!item) {
        await qs.wait(Math.min(...q.commands.map((x) => x.notBefore), ...q.normal.map((x) => x.notBefore)) - t);
        continue;
      }
      await run(item);
    }
    pumping = false;
  }

  // media: an image of at most maxMediaBytes, refused on its headers or cancelled mid-stream; { type: null } when refused.
  // An error status is refused unread too: its body is as untrusted and unbounded as an image's.
  async function readMedia(res) {
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const refuse = async (reader) => { await (reader ?? res.body)?.cancel().catch(() => {}); return { type: null, buf: Buffer.alloc(0) }; };
    if (!res.ok || !type.startsWith('image/') || Number(res.headers.get('content-length') ?? 0) > maxMediaBytes) return refuse();
    const reader = res.body.getReader();
    const chunks = [];
    for (let n = 0; ;) {
      const { done, value } = await reader.read();
      if (done) return { type, buf: Buffer.concat(chunks) };
      if ((n += value.length) > maxMediaBytes) return refuse(reader);
      chunks.push(value);
    }
  }

  async function readBody(res, media) {
    if (media) return readMedia(res);
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  function retryAfterMs(res) {
    const h = res.headers.get('retry-after');
    if (h == null || h === '') return 0;
    const n = Number(h);
    return Number.isFinite(n) ? n * 1000 : Math.max(0, Date.parse(h) - now()) || 0;
  }

  async function run(item) {
    let tok;
    try { tok = await ensureToken(); } catch (err) { return item.reject(err); }
    const path = typeof item.path === 'function' ? item.path(tok.user_id) : item.path;
    const t0 = now();
    lastStart = t0;
    let res;
    let status;
    let body;
    try {
      res = await fetchImpl(bases[item.host] + path, {
        method: item.method, headers: headers(tok), body: item.body === undefined ? undefined : JSON.stringify(item.body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      status = res.status;
      body = await readBody(res, item.media);
    } catch {
      status = undefined;
    }
    log(`${item.method} ${item.host}${path.split('?')[0]} ${status ?? 'network error'}`);
    const ms = now() - t0;
    if (status >= 200 && status < 300) return item.resolve(item.raw ? { status, body, ms } : body);
    if (status === 401) {
      if (!item.reauthed) { item.reauthed = true; dropToken(tok); return requeue(item); } // back through the queue: gap and priority hold
      return item.reject(new TractiveError(401, body?.code, body?.message));
    }
    if (status === 429) {
      item.attempts++;
      // Each 429 pauses the whole queue and doubles the gap; jitter never shortens the server's Retry-After.
      penaltyUntil = now() + Math.max(retryAfterMs(res), j(Math.min(penaltyMaxMs, penaltyBaseMs * 2 ** (item.attempts - 1))));
      level = Math.min(level + 1, 10);
      last429At = now();
      if (item.attempts >= (item.command ? 2 : 4)) return item.reject(new RateLimited(Math.max(0, Math.ceil((penaltyUntil - now()) / 1000))));
      return requeue(item);
    }
    if (item.raw && status !== undefined) return item.resolve({ status, body, ms });
    if (status === undefined || status >= 500) {
      item.retries++;
      if (item.retries > 2) return item.reject(new TractiveError(status ?? 0, body?.code, body?.message));
      item.notBefore = now() + j(Math.min(penaltyMaxMs, penaltyBaseMs * 2 ** (item.retries - 1)));
      return requeue(item);
    }
    return item.reject(new TractiveError(status, body?.code, body?.message));
  }

  // --- channel ---
  const ch = { connected: false, since: null, lastMessageAt: null, reconnects: 0 };
  const cs = sleeper();
  let chGen = 0;
  let chAbort = null;
  let chBackoff = reconnectMinMs;
  const syncTimers = new Map();
  const lastSync = new Map();
  const emitStatus = () => ee.emit('channel-status', { ...ch });

  function scheduleSync(kind) {
    if (!SYNC_KINDS.has(kind) || syncTimers.has(kind)) return;
    const at = Math.max(now() + syncDebounceMs, (lastSync.get(kind) ?? -Infinity) + syncMinIntervalMs);
    syncTimers.set(kind, setTimeout(() => {
      syncTimers.delete(kind);
      lastSync.set(kind, now());
      ee.emit('sync', kind);
    }, at - now()));
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { log(`channel: unparsable line ${line.slice(0, 200)}`); return; }
    ch.lastMessageAt = nowS();
    chBackoff = reconnectMinMs;
    if (msg?.message === 'handshake') {
      ch.connected = true;
      ch.since = nowS();
      emitStatus();
    }
    ee.emit('channel-message', msg);
    if (msg?.message === 'graph_sync') for (const target of msg.targets ?? []) scheduleSync(target?.type);
  }

  async function readStream(res, ac) {
    let silence;
    const arm = () => { clearTimeout(silence); silence = setTimeout(() => ac.abort(), silenceMs); };
    const dec = new TextDecoder();
    let buf = '';
    arm();
    try {
      for await (const chunk of res.body) {
        arm();
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      }
    } finally {
      clearTimeout(silence);
    }
  }

  async function channelLoop(gen) {
    let authRetried = false;
    while (gen === chGen) {
      let skipBackoff = false;
      try {
        const tok = await ensureToken();
        if (gen !== chGen) break;
        const ac = new AbortController();
        chAbort = ac;
        const connect = setTimeout(() => ac.abort(), silenceMs); // a hung connect would otherwise stall the loop
        const res = await fetchImpl(channelUrl, { method: 'POST', headers: headers(tok), signal: ac.signal }).finally(() => clearTimeout(connect));
        log(`POST channel ${res.status}`);
        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel();
          if (!authRetried) { dropToken(tok); skipBackoff = true; }
          authRetried = true;
        } else if (res.status !== 200) {
          authRetried = false;
          await res.body?.cancel();
        } else {
          authRetried = false;
          await readStream(res, ac);
        }
      } catch (err) {
        if (err?.name !== 'AbortError') log(`channel: ${err instanceof AuthError ? err.message : err?.name ?? 'error'}`);
      }
      chAbort = null;
      if (gen !== chGen) break;
      ch.connected = false;
      ch.reconnects++;
      emitStatus();
      if (!skipBackoff) {
        const wait = j(chBackoff);
        chBackoff = Math.min(chBackoff * 2, reconnectMaxMs);
        await cs.wait(wait);
      }
    }
  }

  let chRunning = false;
  function startChannel() {
    if (chRunning || closed) return;
    chRunning = true;
    channelLoop(++chGen);
  }

  function stopChannel() {
    chGen++;
    chRunning = false;
    chAbort?.abort();
    cs.wake();
    if (ch.connected) { ch.connected = false; emitStatus(); }
  }

  // --- methods (async: argument checks reject with RangeError before anything is queued) ---
  const get = (path, o) => enqueue('GET', path, o);
  const bulk = async (items) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += 100) chunks.push(enqueue('POST', '/bulk?partial=1', { body: items.slice(i, i + 100) }));
    return (await Promise.all(chunks)).flat();
  };
  const hydrate = async (stubsPath, type) => bulk((await get(stubsPath)).map((s) => ({ _type: type, _id: s._id })));
  const pick = (g) => Object.fromEntries(GEOFENCE_KEYS.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]));

  Object.assign(ee, {
    login, retryLogin, startChannel, stopChannel,
    status: () => ({
      login: state, userId: token?.user_id ?? null,
      queue: { pending: q.commands.length + q.normal.length, commands: q.commands.length, penaltyUntil: penaltyUntil > now() ? Math.floor(penaltyUntil / 1000) : null, gapMs: gapMs() },
      channel: { ...ch },
    }),
    user: async () => get((uid) => `/user/${e(uid)}`),
    updateUser: async (u) => enqueue('PUT', (uid) => `/user/${e(uid)}?_version=${e(u._version)}`, { body: u }),
    trackers: async () => get((uid) => `/user/${e(uid)}/trackers`),
    tracker: async (id) => get(`/tracker/${e(id)}`),
    hwReport: async (id) => get(`/device_hw_report/${e(id)}/`),
    posReport: async (id) => get(`/device_pos_report/${e(id)}`),
    pets: async () => get((uid) => `/user/${e(uid)}/trackable_objects`),
    pet: async (id) => get(`/trackable_object/${e(id)}`),
    updatePet: async (p) => enqueue('PUT', `/trackable_object/${e(p._id)}?_version=${e(p._version)}`, { body: p }),
    subscriptions: async () => get((uid) => `/user/${e(uid)}/subscriptions`),
    subscription: async (id) => get(`/subscription/${e(id)}`),
    bulk,
    geofences: async (id) => hydrate(`/tracker/${e(id)}/geofences`, 'geofence'),
    createGeofence: async (tid, g) => enqueue('POST', `/geofence/tracker/${e(tid)}/geofences`, { body: pick(g), command: true }),
    updateGeofence: async (g) => enqueue('PUT', `/geofence/${e(g._id)}?_version=${e(g._version)}`, { body: pick(g), command: true }),
    deleteGeofence: async (gid) => enqueue('DELETE', `/geofence/${e(gid)}`, { command: true }),
    powerSavingZones: async (id) => {
      const stubs = await get(`/tracker/${e(id)}/power_saving_zones`);
      return Promise.all(stubs.map((s) => get(`/power_saving_zone/${e(s._id)}`)));
    },
    deletePowerSavingZone: async (zid) => enqueue('DELETE', `/power_saving_zone/${e(zid)}`),
    powerSavingZone: async (zid) => get(`/power_saving_zone/${e(zid)}`),
    updatePowerSavingZone: async (z) => {
      if (!z?._id || !z._version || typeof z.zone_id !== 'string' || !z.zone_id) throw new RangeError('zone needs _id, _version and zone_id');
      const body = { zone_id: z.zone_id, latlong: z.latlong, name: z.name, source: z.source ?? 'WIFI', device_id: z.device_id };
      return enqueue('PUT', `/power_saving_zone/${e(z._id)}?_version=${e(z._version)}`, { body, command: true });
    },
    commandStates: async (id) => bulk(COMMANDS.map((n) => ({ _type: 'tracker_command_state', _id: `${String(id).toLowerCase()}_${n}` }))),
    command: async (id, name, on) => {
      if (!COMMANDS.includes(name)) throw new RangeError(`unknown command ${name}`);
      if (name === 'pos_request' && !on) throw new RangeError('pos_request can only be turned on');
      return get(`/tracker/${e(id)}/command/${name}/${on ? 'on' : 'off'}`, { command: true });
    },
    setPowerMode: async (id, mode) => {
      if (!POWER_MODES.includes(mode)) throw new RangeError(`invalid power mode ${mode}`);
      return enqueue('PUT', `/tracker/${e(id)}/power_mode`, { body: { power_mode: mode }, command: true });
    },
    setLiveTimeout: async (id, s) => {
      if (!LIVE_TIMEOUTS.includes(s)) throw new RangeError(`invalid live timeout ${s}`);
      return enqueue('PUT', `/tracker/${e(id)}/lt_timeout`, { body: { timeout: s }, command: true });
    },
    positionsRange: async (id) => get(`/tracker/${e(id)}/positions/range`),
    positions: async (id, from, to) => (await get(`/tracker/${e(id)}/positions?time_from=${e(from)}&time_to=${e(to)}&format=json_segments`)).flat(),
    publicShares: async (id) => hydrate(`/tracker/${e(id)}/public_shares`, 'public_share'),
    createPublicShare: async (id, message) => enqueue('POST', '/public_share', { body: { tracker_id: id, message } }),
    deactivatePublicShare: async (sid) => enqueue('PUT', `/public_share/${e(sid)}/deactivate`, { body: {} }),
    reachableNotification: async (id) => get(`/tracker/${e(id)}/event_notification/tracker_reachable_again`),
    setReachableNotification: async (id) => enqueue('POST', `/tracker/${e(id)}/event_notification/tracker_reachable_again`, { body: {} }),
    weightHistory: async (petId) => get(`/weight_activity_history/${e(petId)}`),
    health: async (petId) => get(`/pet/${e(petId)}/health/overview`, { host: 'aps' })
      .catch((err) => { if (err instanceof TractiveError && [400, 403].includes(err.status)) return null; throw err; }),
    timeline: async (petId, { types = ALL_TIMELINE_TYPES, resumeFrom } = {}) => {
      const qp = new URLSearchParams({ petId, timezone: tz });
      for (const t of types) qp.append('types', t);
      if (resumeFrom) qp.set('resumeFrom', resumeFrom);
      return get(`/events?${qp}`, { host: 'timeline' });
    },
    config: async () => get('/config/all'),
    petPhoto: async (pictureId) => get(`/media/resource/${e(pictureId)}.jpg`, { media: true }),
    raw: async (host, method, path, body) => {
      if (!(host in bases)) throw new RangeError(`unknown host ${host}`);
      return enqueue(method, path, { host, body, raw: true });
    },
    close() {
      closed = true;
      stopChannel();
      clearTimeout(retryTimer);
      retryTimer = null;
      for (const t of syncTimers.values()) clearTimeout(t);
      syncTimers.clear();
      qs.wake();
      for (const item of q.commands.splice(0).concat(q.normal.splice(0))) item.reject(new Error('closed'));
    },
  });
  return ee;
}
