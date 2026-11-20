// Stateful mock of every Tractive host (graph, aps, timeline, channel) and the Telegram Bot API, with a control API.
// In-process: startMock(). Standalone (docker `mock` service): MOCK_PORT=9100 node test/mock/server.js
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ll } from '../helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const clone = (v) => structuredClone(v);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
};
const nowS = () => Math.floor(Date.now() / 1000);
const iso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');
const hex24 = () => crypto.randomBytes(12).toString('hex');
const bump = (v) => String(Number(v) + 1);
const stub = (o) => ({ _id: o._id, _type: o._type, _version: o._version });
const NOT_FOUND = [404, { code: 404, message: 'not found' }];

export async function startMock({ port = 0, host = '127.0.0.1', keepAliveMs = 1000, commandDelayMs = 200, telegramToken = '123456:TEST-TOKEN-abc', fixturesDir } = {}) {
  const dir = fixturesDir ?? FIXTURES;
  const fx = (n) => JSON.parse(fs.readFileSync(`${dir}/${n}.json`, 'utf8'));
  const byId = (arr) => new Map(arr.map((o) => [o._id, o]));
  let S;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); t.unref(); timers.add(t); return t; };

  function reset() {
    if (S) {
      for (const c of S.channels) endStream(c);
      for (const w of S.tg.waiters) w();
    }
    for (const t of timers) clearTimeout(t);
    timers.clear();
    const now = Date.now();
    const [, chStatus] = fx('channel');
    const status = clone(chStatus);
    Object.assign(status, {
      tracker_state_reason: null, power_saving_zone_id: null, prioritized_zone: null,
      position: { time: nowS() - 60, time_rcvd: nowS() - 59, latlong: [41.0, 2.0], sensor_used: 'GPS', accuracy: 8, altitude: 120, power_saving_zone_id: null },
      hardware: { time: nowS() - 60, battery_level: 80, temperature_state: null, power_saving_zone_id: null },
    });
    const tracker = { ...fx('tracker'), state_reason: null, power_saving_zone_id: null, prioritized_zone_id: null, prioritized_zone_type: null, prioritized_zone_last_seen_at: null, prioritized_zone_entered_at: null };
    const history = [];
    for (let i = 0; i < 288; i++) {
      const p = ll(10 * Math.sin(i), 10 * Math.cos(0.7 * i));
      history.push({ time: nowS() - (288 - i) * 600, latlong: [p.lat, p.lng], alt: 120, speed: null, course: null, pos_uncertainty: 8, sensor_used: 'GPS' });
    }
    S = {
      tracker, status, history, fixtures: { hw: fx('hw-report'), pos: fx('pos-report') },
      geofences: byId(fx('geofences-bulk')), zones: byId(fx('power-saving-zone')), shares: byId([fx('public-share')]),
      cmds: byId(fx('command-states')), user: fx('user'), pet: fx('pet'), health: fx('health-overview'), weight: fx('weight-activity-history'),
      config: fx('config-all'), subscription: fx('subscription'), reachable: false,
      timeline: [
        { id: 'gen1', type: 'insidePowerSavingZone', startedAt: iso(now - 3 * 3600e3), endedAt: iso(now - 2 * 3600e3), zoneName: 'Kitchen' },
        { id: 'gen2', type: 'walk', startedAt: iso(now - 6 * 3600e3), endedAt: iso(now - 5.5 * 3600e3) },
      ],
      timelinePaging: fx('timeline').paging,
      issued: new Set(), fails: [], requests: [], channels: new Set(), counters: { inj: 0, share: 1 },
      tg: { updates: [], nextUpdateId: 1, sent: [], nextMessageId: 1, stopped: new Set(), lastLoc: new Map(), waiters: new Set() },
    };
  }

  const statusMsg = () => ({ ...clone(S.status), message: 'tracker_status' });
  const restTracker = () => ({
    ...S.tracker, charging_state: S.status.charging_state, battery_state: S.status.battery_state,
    power_saving_zone_id: S.status.power_saving_zone_id, state_reason: S.status.power_saving_zone_id ? 'POWER_SAVING' : null,
  });

  // --- channel ---
  function endStream(c) { clearInterval(c.timer); S?.channels.delete(c); c.res.end(); }
  function push(msg) {
    const line = `${JSON.stringify(msg)}\n`;
    for (const c of S.channels) if (Date.now() >= c.silencedUntil) c.res.write(line);
  }
  function openChannel(res) {
    const c = { res, silencedUntil: 0 };
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const [handshake] = fx('channel');
    res.write(`${JSON.stringify(handshake)}\n${JSON.stringify(statusMsg())}\n`);
    c.timer = setInterval(() => {
      if (Date.now() >= c.silencedUntil) res.write(`${JSON.stringify({ channelId: 'mock-channel', keepAlive: nowS(), message: 'keep-alive' })}\n`);
    }, keepAliveMs);
    c.timer.unref();
    S.channels.add(c);
    res.on('close', () => { clearInterval(c.timer); S.channels.delete(c); });
  }

  // --- graph ---
  function command(name, on) {
    const st = S.status[name];
    const cmd = S.cmds.get(`${S.tracker._id.toLowerCase()}_${name}`);
    const timeout = st?.timeout ?? cmd?.timeout ?? 300;
    const reply = { active: st?.active ?? false, started_at: null, timeout, remaining: 0, pending: true, reconnecting: false };
    later(() => {
      if (name === 'pos_request') {
        if (on) { const t = nowS(); push({ message: 'tracker_status', tracker_id: S.status.tracker_id, position: { ...S.status.position, time: t, time_rcvd: t } }); }
        return;
      }
      const block = { active: on, pending: false, remaining: on ? timeout : 0, timeout };
      S.status[name] = { ...st, ...block, reconnecting: false };
      if (cmd) Object.assign(cmd, block);
      push(statusMsg());
    }, commandDelayMs);
    return [200, reply];
  }

  function versioned(obj, q, apply) {
    if (q.get('_version') !== obj._version) return [409, { code: 409, message: 'version conflict' }];
    apply();
    obj._version = bump(obj._version);
    return [200, obj];
  }

  function graph(method, p, q, body) {
    let m;
    const is = (meth, re) => method === meth && (m = re.exec(p));
    if (is('GET', /^user\/(me|[a-f0-9]{24})$/)) return [200, S.user];
    if (is('PUT', /^user\/[a-f0-9]{24}$/)) return versioned(S.user, q, () => Object.assign(S.user, body));
    if (is('GET', /^user\/[a-f0-9]{24}\/(trackers|trackable_objects|subscriptions)$/)) {
      return [200, fx(`user-${m[1].replace('trackable_objects', 'trackable-objects')}`)];
    }
    if (is('GET', /^tracker\/([^/]+)$/)) return [200, restTracker()];
    if (is('GET', /^device_hw_report\/[^/]+$/)) {
      const hw = S.status.hardware;
      return [200, { ...S.fixtures.hw, time: hw.time, battery_level: hw.battery_level, temperature_state: hw.temperature_state, power_saving_zone_id: hw.power_saving_zone_id }];
    }
    if (is('GET', /^device_pos_report\/[^/]+$/)) {
      const ps = S.status.position;
      return [200, { ...S.fixtures.pos, time: ps.time, time_rcvd: ps.time_rcvd, latlong: ps.latlong, sensor_used: ps.sensor_used, pos_uncertainty: ps.accuracy, altitude: ps.altitude, power_saving_zone_id: ps.power_saving_zone_id }];
    }
    if (is('GET', /^trackable_object\/[^/]+$/)) return [200, S.pet];
    if (is('PUT', /^trackable_object\/[^/]+$/)) {
      return versioned(S.pet, q, () => { const { details, ...rest } = body; Object.assign(S.pet, rest); if (details) S.pet.details = deepMerge(S.pet.details, details); });
    }
    if (is('GET', /^subscription\/[^/]+$/)) return [200, S.subscription];
    if (is('POST', /^bulk$/)) {
      const maps = { geofence: S.geofences, tracker_command_state: S.cmds, power_saving_zone: S.zones, public_share: S.shares };
      return [200, (body ?? []).map((r) => maps[r._type]?.get(r._id)).filter(Boolean)];
    }
    if (is('GET', /^tracker\/[^/]+\/geofences$/)) return [200, [...S.geofences.values()].map(stub)];
    if (is('POST', /^geofence\/tracker\/[^/]+\/geofences$/)) {
      const g = { trigger: ['IN_TO_OUT', 'OUT_TO_IN'], home_flag: false, deleted_at: null, entered_at: null, ...body, _id: hex24(), _type: 'geofence', _version: '1' };
      S.geofences.set(g._id, g);
      return [200, g];
    }
    if (is('PUT', /^geofence\/([^/]+)$/)) {
      const g = S.geofences.get(m[1]);
      return g ? versioned(g, q, () => Object.assign(g, body, { _id: g._id, _type: 'geofence' })) : NOT_FOUND;
    }
    if (is('DELETE', /^geofence\/([^/]+)$/)) return S.geofences.delete(m[1]) ? [200, {}] : NOT_FOUND;
    if (is('GET', /^tracker\/[^/]+\/power_saving_zones$/)) return [200, [...S.zones.values()].map(stub)];
    if (is('GET', /^power_saving_zone\/([^/]+)$/)) return S.zones.has(m[1]) ? [200, S.zones.get(m[1])] : NOT_FOUND;
    if (is('DELETE', /^power_saving_zone\/([^/]+)$/)) return S.zones.delete(m[1]) ? [200, {}] : NOT_FOUND;
    if (is('GET', /^tracker\/[^/]+\/command\/(live_tracking|led_control|buzzer_control|pos_request)\/(on|off)$/)) return command(m[1], m[2] === 'on');
    if (is('PUT', /^tracker\/[^/]+\/power_mode$/)) { S.tracker.power_mode = body.power_mode; return [200, restTracker()]; }
    if (is('PUT', /^tracker\/[^/]+\/lt_timeout$/)) {
      S.tracker.custom_lt_timeout = body.timeout;
      S.status.live_tracking.timeout = body.timeout;
      S.cmds.get(`${S.tracker._id.toLowerCase()}_live_tracking`).timeout = body.timeout;
      return [200, restTracker()];
    }
    if (is('GET', /^tracker\/[^/]+\/positions\/range$/)) return [200, { first: S.history[0].time, last: S.history.at(-1).time }];
    if (is('GET', /^tracker\/[^/]+\/positions$/)) {
      const from = Number(q.get('time_from') ?? 0);
      const to = Number(q.get('time_to') ?? Infinity);
      return [200, [S.history.filter((x) => x.time >= from && x.time <= to)]];
    }
    if (is('GET', /^tracker\/[^/]+\/public_shares$/)) return [200, [...S.shares.values()].map(stub)];
    if (is('POST', /^public_share$/)) {
      const s = { tracker_id: body.tracker_id, message: body.message, share_link: `https://example.invalid/share/${++S.counters.share}`, active: true, created_at: nowS(), _id: hex24(), _type: 'public_share', _version: '1' };
      S.shares.set(s._id, s);
      return [200, s];
    }
    if (is('GET', /^public_share\/([^/]+)$/)) return S.shares.has(m[1]) ? [200, S.shares.get(m[1])] : NOT_FOUND;
    if (is('PUT', /^public_share\/([^/]+)\/deactivate$/)) {
      const s = S.shares.get(m[1]);
      if (!s) return NOT_FOUND;
      s.active = false;
      s._version = bump(s._version);
      return [200, s];
    }
    if (is('GET', /^tracker\/[^/]+\/event_notification\/tracker_reachable_again$/)) return [200, { user_gets_notified: S.reachable }];
    if (is('POST', /^tracker\/[^/]+\/event_notification\/tracker_reachable_again$/)) { S.reachable = true; return [200, { user_gets_notified: true }]; }
    if (is('GET', /^weight_activity_history\/[^/]+$/)) return [200, S.weight];
    if (is('GET', /^config\/all$/)) return [200, S.config];
    if (is('GET', /^media\/resource\/[^/]+\.jpg$/)) return [200, PNG, 'image/png'];
    return NOT_FOUND;
  }

  // --- telegram ---
  async function telegram(req, p, query, body) {
    const m = /^bot([^/]+)\/(\w+)$/.exec(p);
    if (!m || m[1] !== telegramToken) return [404, { ok: false, error_code: 404, description: 'Not Found' }];
    const tg = S.tg;
    const b = { ...Object.fromEntries(query), ...body };
    const bad = (description) => [400, { ok: false, error_code: 400, description }];
    const ok = (result) => {
      tg.sent.push({ method: m[2], body: b, at: Date.now(), result });
      return [200, { ok: true, result }];
    };
    switch (m[2]) {
      case 'getMe': return [200, { ok: true, result: { id: 7000001, is_bot: true, first_name: 'OpenTractive Test', username: 'opentractive_test_bot' } }];
      case 'getUpdates': {
        const offset = Number(b.offset ?? 0);
        const end = Date.now() + Math.min(Number(b.timeout ?? 0), 50) * 1000;
        let aborted = false;
        req.on('close', () => { aborted = true; });
        for (;;) {
          tg.updates = tg.updates.filter((u) => u.update_id >= offset);
          // like Telegram, at most `limit` (1-100, default 100) updates per response
          if (tg.updates.length || aborted || Date.now() >= end || S.tg !== tg) return [200, { ok: true, result: tg.updates.slice(0, Math.min(Math.max(Number(b.limit) || 100, 1), 100)) }];
          await new Promise((resolve) => {
            const t = setTimeout(done, end - Date.now());
            t.unref();
            function done() { clearTimeout(t); tg.waiters.delete(done); req.off('close', done); resolve(); }
            tg.waiters.add(done);
            req.on('close', done);
          });
        }
      }
      case 'sendMessage': case 'sendLocation': {
        const id = tg.nextMessageId++;
        if (m[2] === 'sendLocation') tg.lastLoc.set(id, `${b.latitude},${b.longitude}`);
        return ok({ message_id: id, chat: { id: b.chat_id }, date: nowS() });
      }
      case 'editMessageLiveLocation': {
        if (tg.stopped.has(b.message_id)) return bad("Bad Request: message can't be edited");
        const loc = `${b.latitude},${b.longitude}`;
        if (tg.lastLoc.get(b.message_id) === loc) return bad('Bad Request: message is not modified');
        tg.lastLoc.set(b.message_id, loc);
        return ok(true);
      }
      case 'stopMessageLiveLocation': tg.stopped.add(b.message_id); return ok(true);
      case 'answerCallbackQuery': case 'editMessageReplyMarkup': case 'deleteWebhook': return ok(true);
      default: return [404, { ok: false, error_code: 404, description: 'Not Found' }];
    }
  }

  // --- control ---
  function control(method, p, query, body) {
    if (method === 'GET') {
      if (p === 'health') return { ok: true };
      if (p === 'requests') { const h = query.get('host'); return S.requests.filter((r) => !h || r.host === h); }
      if (p === 'telegram/sent') return S.tg.sent;
      return undefined;
    }
    switch (p) {
      case 'reset': reset(); return { ok: true };
      case 'channel': push(body.message); return { ok: true };
      case 'channel/drop': for (const c of [...S.channels]) endStream(c); return { ok: true };
      case 'channel/silence': for (const c of S.channels) c.silencedUntil = Date.now() + body.seconds * 1000; return { ok: true };
      case 'fix': {
        const { lat, lng, acc, sensor = 'GPS', pszId = null, dtS = 0 } = body;
        const time = nowS() + dtS;
        Object.assign(S.status, {
          position: { time, time_rcvd: time, latlong: [lat, lng], sensor_used: sensor, accuracy: acc, altitude: 120, power_saving_zone_id: pszId },
          hardware: { ...S.status.hardware, time, power_saving_zone_id: pszId },
          power_saving_zone_id: pszId, tracker_state_reason: pszId ? 'POWER_SAVING' : null,
        });
        S.history.push({ time, latlong: [lat, lng], alt: 120, speed: null, course: null, pos_uncertainty: acc, sensor_used: sensor });
        const msg = statusMsg();
        push(msg);
        return msg;
      }
      case 'tracker': {
        S.status = deepMerge(S.status, body.patch);
        for (const [k, v] of Object.entries(body.patch)) if (k in S.tracker) S.tracker[k] = v;
        if (body.patch.tracker_state) S.tracker.state = body.patch.tracker_state;
        const msg = statusMsg();
        push(msg);
        return msg;
      }
      case 'timeline': {
        const e = { id: `inj${++S.counters.inj}`, occurredAt: iso(Date.now()), ...body.event };
        S.timeline.unshift(e);
        return e;
      }
      case 'fail': S.fails.push({ times: 1, ...body }); return { ok: true };
      case 'telegram/update': {
        const u = { update_id: S.tg.nextUpdateId++, ...body.update };
        if (u.message && !u.message.date) u.message.date = nowS();
        S.tg.updates.push(u);
        for (const w of [...S.tg.waiters]) w();
        return u;
      }
      default: return undefined;
    }
  }

  // --- http ---
  const hostOf = (p) => p.split('/')[1];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    const send = (status, payload, type = 'application/json', extra = {}) => {
      if (rec) rec.status = status;
      const out = Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(out);
    };
    let rec = null;
    try {
      const p = url.pathname.replace(/\/+$/, '') || '/';
      if (p.startsWith('/__mock/')) {
        const out = control(req.method, p.slice(8), url.searchParams, body ?? {});
        return out === undefined ? send(404, { code: 404, message: 'not found' }) : send(200, out);
      }
      const host = hostOf(p);
      rec = { host, method: req.method, path: url.pathname + url.search, body, at: Date.now(), status: null };
      S.requests.push(rec);
      const key = `${req.method} ${url.pathname}`;
      const rule = S.fails.find((f) => f.times > 0 && key.startsWith(f.match));
      if (rule) {
        rule.times--;
        if (rule.hang) return undefined; // never answers: the client must time out (closed by close())
        if (rule.headersThenHang) { // sends the status and part of a body, then never finishes it
          rec.status = rule.status;
          res.writeHead(rule.status, { 'content-type': 'application/json' });
          return void res.write('{"ok":true,"res');
        }
        if (rule.image) { // { bytes, chunked, type }: an image body; chunked without bytes streams until the client cancels
          const { bytes = Infinity, chunked = false, type = 'image/png' } = rule.image;
          rec.status = rule.status;
          res.writeHead(rule.status, { 'content-type': type, ...(!chunked && { 'content-length': String(bytes) }) });
          const chunk = Buffer.alloc(65536);
          let n = 0;
          const pump = () => {
            while (!res.destroyed && n < bytes) {
              const c = chunk.subarray(0, Math.min(chunk.length, bytes - n));
              n += c.length;
              if (!res.write(c)) return void res.once('drain', pump);
            }
            if (!res.destroyed) res.end();
          };
          return pump();
        }
        return send(rule.status, rule.body ?? { code: rule.status, message: 'injected' }, 'application/json', rule.retryAfter != null ? { 'retry-after': String(rule.retryAfter) } : {});
      }
      if (host === 'telegram') {
        const [status, out] = await telegram(req, p.slice('/telegram/'.length), url.searchParams, body ?? {});
        return send(status, out);
      }
      if (!['graph', 'aps', 'timeline', 'channel'].includes(host)) return send(...NOT_FOUND);
      if (host === 'graph' && req.method === 'POST' && p === '/graph/4/auth/token') {
        const token = `mock-${crypto.randomBytes(8).toString('hex')}`;
        S.issued.add(token);
        return send(200, { user_id: S.user._id, client_id: req.headers['x-tractive-client'], expires_at: nowS() + 7 * 86400, access_token: token });
      }
      if (!S.issued.has(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1])) return send(401, { code: 401, message: 'unauthorized' });
      if (host === 'channel' && req.method === 'POST' && p === '/channel/3/channel') {
        rec.status = 200;
        return openChannel(res);
      }
      if (host === 'graph' && p.startsWith('/graph/4/')) {
        const [status, out, type] = graph(req.method, p.slice('/graph/4/'.length), url.searchParams, body ?? {});
        return send(status, out, type);
      }
      if (host === 'aps') {
        if (req.method === 'GET' && /^\/aps\/api\/1\/pet\/[^/]+\/health\/overview$/.test(p)) return send(200, S.health);
        return send(...NOT_FOUND);
      }
      if (host === 'timeline' && req.method === 'GET' && p === '/timeline/api/1/events') {
        const types = url.searchParams.getAll('types').flatMap((t) => t.split(','));
        return send(200, { paging: S.timelinePaging, events: S.timeline.filter((e) => !types.length || types.includes(e.type)) });
      }
      return send(...NOT_FOUND);
    } catch (err) {
      if (!res.headersSent) send(500, { code: 500, message: String(err?.message ?? err) });
      else res.end();
    }
  });

  reset();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  const call = (method, p, body) => fetch(url + p, { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }).then((r) => r.json());
  return {
    url, port: actualPort,
    post: (p, body = {}) => call('POST', p, body),
    get: (p) => call('GET', p),
    async close() {
      for (const c of [...S.channels]) endStream(c);
      for (const w of [...S.tg.waiters]) w();
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.MOCK_PORT ?? 9000);
  await startMock({ port, host: '0.0.0.0' });
  console.log(`mock listening on ${port}`);
}
