// Telegram bot: long polling, pairing, chat authorisation (private chats, groups, supergroups), commands, callback buttons, alert/repeat delivery,
// chase live locations and a two-lane per-chat rate limiter. The token never leaves this module unredacted.
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const NOT_AUTH = 'Not authorised. Pair this chat from the OpenTractive web app (Telegram page).';
const PAIRED = 'Paired. This chat now gets OpenTractive alerts. Send /help to see the commands.';
const TEST_TEXT = 'Test message from OpenTractive. Alerts will look like this.';
const RANK = { info: 0, warn: 1, critical: 2 };
const CHARGING = { CHARGING: 'charging', NOT_CHARGING: 'not charging', FULLY_CHARGED: 'fully charged' };
const USAGE = {
  live: 'Usage: /live on|off', led: 'Usage: /led on|off', buzz: 'Usage: /buzz on|off', chase: 'Usage: /chase on|off',
  watch: 'Usage: /watch on|off', walk: 'Usage: /walk [minutes] (1-720) or /walk off',
  mute: 'Usage: /mute <minutes> (1-720) or /mute all <minutes>',
};
const HELP = [
  'OpenTractive commands:',
  '/status - where the dog is, battery, last fix and modes',
  '/where - last position on the map',
  '/live on|off - live tracking',
  '/locate - ask the tracker for a fresh position',
  '/led on|off - tracker light',
  '/buzz on|off - tracker buzzer',
  '/chase on|off - chase mode with a live location',
  '/watch on|off - yard watch',
  '/walk [minutes]|off - walk mode (default 120 min)',
  '/mute <minutes> - mute info and warning alerts (1-720)',
  '/mute all <minutes> - mute every alert, critical included',
  '/unmute - end a mute',
  '/escapes - last escapes',
  '/help - this list',
].join('\n');

const btn = (text, data) => ({ text, callback_data: data });
const LIVE = btn('Live on', 'live:on'), BUZZ = btn('Buzz', 'buzz:on'), WHERE = btn('Where', 'where');

export function redact(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('<redacted>');
  return s.replace(/\/bot[^/\s]+/g, '/bot<redacted>');
}

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (s) => { const d = new Date(s * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateTime = (s) => { const d = new Date(s * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(s)}`; };
const age = (s) => (s < 90 ? `${Math.max(0, s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const onOff = (a) => (a === 'on' ? true : a === 'off' ? false : null);
const minutes = (a) => (/^\d{1,3}$/.test(a ?? '') && +a >= 1 && +a <= 720 ? +a : null);
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createTelegram({
  token, apiUrl = 'https://api.telegram.org', chatIds = [], store, monitor, live, trackerId, posRequestAllowed = () => true, petName = () => 'The dog',
  escapesSummary = () => [], appUrl = '', now = Date.now, log = () => {}, pollTimeoutS = 50, minIntervalMs = 1000,
  backoffMinMs = 5000, backoffMaxMs = 60000, editEveryMs = 5000, botName: botNameOpt = null, callTimeoutMs = 15000,
}) {
  const enabled = !!token;
  const ac = new AbortController();
  const nowS = () => Math.floor(now() / 1000);
  const tid = () => (typeof trackerId === 'function' ? trackerId() : trackerId);
  const nap = (ms) => sleep(ms, undefined, { signal: ac.signal }).catch(() => {});
  let botName = botNameOpt, polling = false, lastError = null, lastUpdateAt = null, handled = 0;
  let stopped = false, started = false, pollDone = null, conflictSeen = false, busy = 0;
  // shortcut: these maps keep one entry per chat that ever wrote to the bot; prune them if the bot becomes public.
  const queues = new Map(), deniedAt = new Map(), attempts = new Map();
  const edits = new Map();
  // fallback mirror of the monitor's chase messages, for a chase end event that carries no `messages` (the monitor's own end event does)
  let chaseMsgs = {};
  let startedAt = 0; // ms, when polling began: a backlog press on a message older than this - 120 s is a replay
  const liveSending = new Set(); // chats with a chase live location being sent

  const track = (p) => { busy++; return p.finally(() => { busy--; }); };

  async function call(method, body = {}) {
    const fail = (description, extra = {}) => Object.assign(new Error(redact(`${method}: ${description}`, token)), { description: redact(description, token), ...extra });
    let res, data;
    try {
      res = await fetch(`${apiUrl}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(method === 'getUpdates' ? (pollTimeoutS + 15) * 1000 : callTimeoutMs)]),
      });
      // inside the try: a body cut off or hung after the headers is a transient failure (no code), not an empty 200
      data = await res.text().then((t) => { try { return JSON.parse(t); } catch { return {}; } });
    } catch (e) {
      throw fail(e?.cause?.message ?? e?.message ?? 'request failed');
    }
    if (data?.ok) return data.result;
    throw fail(data?.description ?? (res.statusText || 'request failed'), { code: data?.error_code ?? res.status, retryAfter: data?.parameters?.retry_after });
  }

  // ---- per-chat queue: two FIFO lanes, alert first, one call per minIntervalMs over both ----
  // checked at dispatch time: a job is dropped if its chat is no longer approved (removed) or, with a severity, no longer
  // gets alerts of that severity (muted); severity 'any' (replies to unpaired chats) and stopMessageLiveLocation always go
  function send(chat, method, body, lane = 'normal', severity = null) {
    if (stopped) return Promise.reject(Object.assign(new Error('telegram stopped'), { stopped: true }));
    let q = queues.get(chat);
    if (!q) queues.set(chat, (q = { alert: [], normal: [], running: false, last: -Infinity }));
    const p = new Promise((resolve, reject) => q[lane].push({ chat, method, body, lane, severity, resolve, reject }));
    if (!q.running) pump(q);
    return track(p);
  }
  async function pump(q) {
    q.running = true;
    while (!stopped && (q.alert.length || q.normal.length)) {
      const job = q.alert.length ? q.alert.shift() : q.normal.shift();
      for (;;) {
        const wait = q.last + minIntervalMs - Date.now();
        if (wait > 0) await nap(wait);
        const c = store.chat(job.chat);
        const allowed = job.severity === 'any' || job.method === 'stopMessageLiveLocation' || (job.severity ? delivers(c, job.severity) : !!c?.approved_at);
        if (!allowed) {
          job.reject(Object.assign(new Error(`${job.method}: chat ${job.chat} no longer gets these messages`), { skipped: true }));
          break;
        }
        q.last = Date.now();
        try {
          job.resolve(await call(job.method, job.body));
          break;
        } catch (e) {
          if (e.code === 429 && !stopped) { await nap((e.retryAfter ?? 5) * 1000); continue; }
          if (job.lane === 'alert' && !stopped && (e.code == null || e.code >= 500) && (job.tries = (job.tries ?? 0) + 1) < 4) { await nap(2000 * job.tries); continue; }
          job.reject(e);
          break;
        }
      }
    }
    q.running = false;
  }
  const logErr = (e) => {
    if (!stopped && !e?.stopped && !e?.skipped) log(`telegram: ${(lastError = redact(e?.message ?? e, token))}`);
    return null;
  };
  const fire = (chat, method, body, lane, severity) => send(chat, method, body, lane, severity).catch(logErr);
  const reply = (chat, text, severity) => fire(chat, 'sendMessage', { chat_id: chat, text }, 'normal', severity);
  const loc = (chat, p) => ({
    chat_id: chat, latitude: p.lat, longitude: p.lng, ...(p.acc != null && { horizontal_accuracy: Math.min(p.acc, 1500) }),
  });

  function delivers(chat, severity) {
    if (!chat?.approved_at) return false;
    if ((RANK[severity] ?? 0) < (RANK[chat.min_severity] ?? 0)) return false;
    return !(chat.muted_until > nowS() && (severity !== 'critical' || chat.mute_all));
  }

  // ---- answers ----
  function statusText() {
    const st = live.get(tid()), s = monitor.status(), f = s.lastFix, p = st?.position, zone = st?.pszName ?? 'unknown';
    const words = {
      inside: 'In the yard', psz: `In Wi-Fi zone ${zone}`, away: `At Wi-Fi zone ${zone}`,
      outside: `OUT, ${Math.round(f?.d ?? 0)} m from the fence`, uncertain: 'Near the fence',
    }[f?.cls] ?? st?.stateLabel ?? 'Unknown';
    return [
      `${petName()}: ${words}`,
      `Battery ${st?.battery ?? '?'} % (${CHARGING[st?.charging] ?? 'unknown'})`,
      p ? `Last fix ${age(nowS() - p.t)} ago, ±${p.acc == null ? '?' : Math.round(p.acc)} m, ${p.sensor ?? 'unknown sensor'}` : 'No position yet.',
      `Live tracking: ${st?.controls?.live?.active ? 'on' : 'off'} · Chase: ${s.chase ? 'on' : 'off'} · Yard watch: ${s.yardWatch?.status ?? 'off'} · Walk: ${s.walk ? `until ${hhmm(s.walk.until)}` : 'off'}`,
    ].join('\n');
  }
  function where(chat) {
    const p = live.get(tid())?.position;
    if (!p) return 'No position yet.';
    fire(chat, 'sendLocation', loc(chat, p));
    return `±${p.acc == null ? '?' : Math.round(p.acc)} m, ${age(nowS() - p.t)} ago, ${p.sensor ?? 'unknown sensor'}`;
  }
  function escapesText() {
    const list = escapesSummary().slice(0, 5);
    if (!list.length) return 'No escapes recorded.';
    const lines = list.map((e) => `${dateTime(e.t_outside)} · ${e.quality} · gap ${e.gap_s} s`);
    return ['Last escapes:', ...lines, ...(appUrl ? [`\n${appUrl}/#/escapes`] : [])].join('\n');
  }

  const need = (v, cmd) => { if (v == null) throw Object.assign(new Error(USAGE[cmd]), { usage: true }); return v; };
  const trackerCmd = (name, label) => async (chat, [a], actor) => {
    const on = need(onOff(a), label);
    await monitor.command(actor, tid(), name, on);
    return `${name === 'led_control' ? 'Light' : 'Buzzer'} ${on ? 'on' : 'off'} requested.`;
  };
  const COMMANDS = {
    status: () => statusText(),
    where: (chat) => where(chat),
    live: async (chat, [a], actor) => { const on = need(onOff(a), 'live'); await monitor.setManualLive(on, actor); return `Live tracking ${on ? 'on' : 'off'} requested.`; },
    locate: async (chat, args, actor) => { if (!posRequestAllowed()) return 'Locate now is not available for this Tractive account.'; await monitor.command(actor, tid(), 'pos_request', true); return 'Position requested.'; },
    led: trackerCmd('led_control', 'led'),
    buzz: trackerCmd('buzzer_control', 'buzz'),
    chase: async (chat, [a], actor) => {
      const on = need(onOff(a), 'chase');
      await monitor.setChase(on, actor);
      if (on && !monitor.chaseState()) return monitor.status().walk ? 'Chase not started: walk mode is on. Send /walk off first.' : 'Chase not started: the battery is too low.';
      return `Chase ${on ? 'started' : 'stopped'}.`;
    },
    watch: async (chat, [a], actor) => { const on = need(onOff(a), 'watch'); await monitor.setYardWatch(on, actor); return `Yard watch ${on ? 'on' : 'off'}.`; },
    walk: (chat, [a], actor) => {
      const m = a === undefined ? 120 : a === 'off' ? null : need(minutes(a), 'walk');
      monitor.setWalk(m, actor);
      return m == null ? 'Walk mode off.' : `Walk mode for ${m} min.`;
    },
    mute: (chat, args) => {
      const all = args[0] === 'all';
      const m = need(minutes(all ? args[1] : args[0]), 'mute');
      store.updateChat(chat, { muted_until: nowS() + m * 60, mute_all: all ? 1 : 0 });
      return all ? `Every alert muted for ${m} min.` : `Info and warning alerts muted for ${m} min. Critical alerts still come through.`;
    },
    unmute: (chat) => { store.updateChat(chat, { muted_until: null, mute_all: 0 }); return 'Alerts unmuted.'; },
    escapes: () => escapesText(),
    help: () => HELP,
    start: () => HELP,
  };

  async function command(chat, text) {
    const [head, ...args] = text.split(/\s+/);
    const cmd = head.replace(/^\//, '').replace(/@\S*$/, '').toLowerCase();
    const actor = `telegram:${chat}`;
    let out, ok = true;
    try {
      const fn = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
      out = fn ? await fn(chat, args, actor) : 'Unknown command. Send /help to see the commands.';
      ok = !!fn;
    } catch (e) {
      ok = false;
      out = e.usage ? e.message : `Failed: ${redact(e?.message ?? e, token)}`;
    }
    store.logCommand({ t: nowS(), actor, action: `telegram:${cmd}`, params: { args }, ok, result: out });
    reply(chat, out);
  }

  // ---- pairing ----
  function createPairingCode() {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = nowS() + 600;
    store.setKv('pairing', { code, expiresAt, wrong: 0 });
    return { code, expiresAt };
  }
  function notAuthorised(chat) {
    const t = nowS();
    if (t - (deniedAt.get(chat) ?? -Infinity) < 3600) return;
    deniedAt.set(chat, t);
    reply(chat, NOT_AUTH, 'any');
  }
  function pair(chat, code, m) {
    const t = nowS();
    const recent = (attempts.get(chat) ?? []).filter((x) => x > t - 3600);
    attempts.set(chat, recent);
    if (recent.length >= 5) return;
    const p = store.getKv('pairing');
    if (p && p.expiresAt > t && crypto.timingSafeEqual(digest(code), digest(p.code))) {
      store.upsertChat({ chat_id: chat, name: m.chat?.title ?? m.chat?.first_name ?? m.from?.first_name ?? m.chat?.username ?? null, approved_at: t });
      store.delKv('pairing');
      log(`telegram: chat ${chat} paired`);
      reply(chat, PAIRED);
      return;
    }
    recent.push(t);
    if (p) {
      p.wrong = (p.wrong ?? 0) + 1;
      if (p.wrong >= 10) store.delKv('pairing');
      else store.setKv('pairing', p);
    }
    notAuthorised(chat);
  }

  // ---- updates ----
  async function onMessage(m) {
    const old = m.migrate_to_chat_id != null && store.chat(String(m.chat?.id));
    if (old?.approved_at) { // a group upgraded to a supergroup gets a new id: move approval and settings
      const nid = String(m.migrate_to_chat_id);
      store.upsertChat({ chat_id: nid, name: m.chat?.title ?? old.name, approved_at: nowS() });
      store.updateChat(nid, { min_severity: old.min_severity, muted_until: old.muted_until, mute_all: old.mute_all });
      store.deleteChat(old.chat_id);
      log(`telegram: chat ${old.chat_id} migrated to ${nid}`);
      return;
    }
    if (!['private', 'group', 'supergroup'].includes(m.chat?.type)) return;
    const chat = String(m.chat.id);
    const text = String(m.text ?? '').trim();
    if (m.chat.type !== 'private' && !text.startsWith('/')) return; // group chatter and service messages
    const to = /^\/[^\s@]+@(\S+)/.exec(text)?.[1];
    if (to && botName && to.toLowerCase() !== botName.toLowerCase()) return; // a command for another bot in the group
    const approved = !!store.chat(chat)?.approved_at;
    if (m.date < nowS() - 120) {
      if (approved) reply(chat, `Ignored an old command: ${text}`);
      return;
    }
    if (approved) return command(chat, text);
    const start = /^\/start(?:@\S+)?\s+(\S+)$/.exec(text);
    if (start) pair(chat, start[1], m);
    else notAuthorised(chat);
  }

  async function onCallback(q, backlog) {
    // callback queries carry no date: a backlog press on a message older than 2 min is a replay from before the restart
    const stale = backlog && q.message?.date < startedAt / 1000 - 120;
    track(call('answerCallbackQuery', { callback_query_id: q.id, ...(stale && { text: 'Ignored an old button press' }) }).catch(logErr));
    const chat = String(q.message?.chat?.id ?? '');
    if (stale || !chat || !store.chat(chat)?.approved_at) return;
    const actor = `telegram:${chat}`;
    const data = String(q.data ?? '');
    const [act, arg] = data.split(':');
    const id = /^\d+$/.test(arg ?? '') ? Number(arg) : null;
    if (act === 'ack' && id != null) {
      await monitor.ack(id, actor);
      fire(chat, 'editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[LIVE], [BUZZ, WHERE]] } });
    } else if (act === 'false' && id != null) await monitor.falseAlarm(id, actor);
    else if (act === 'walk' && id != null) await monitor.itsAWalk(id, actor);
    else if (data === 'live:on') await monitor.setManualLive(true, actor);
    else if (data === 'buzz:on') await monitor.command(actor, tid(), 'buzzer_control', true);
    else if (data === 'where') reply(chat, where(chat));
  }

  async function handle(u, backlog) {
    lastUpdateAt = nowS();
    if (u.message) return onMessage(u.message);
    if (u.callback_query) return onCallback(u.callback_query, backlog);
  }

  async function poll() {
    polling = true;
    let backoff = backoffMinMs, first = true;
    startedAt = now();
    while (!stopped) {
      try {
        // calls do not wait (timeout 0) until one comes back empty: those pages (up to 100 updates each) are the backlog from while we were down
        const updates = await call('getUpdates', { offset: store.getKv('telegramOffset') ?? 0, timeout: first ? 0 : pollTimeoutS, allowed_updates: ['message', 'callback_query'] });
        const backlog = first;
        first = first && updates?.length > 0;
        backoff = backoffMinMs;
        for (const u of updates ?? []) {
          if (stopped) break;
          store.setKv('telegramOffset', u.update_id + 1);
          await track(handle(u, backlog)).catch(logErr);
          handled++;
        }
      } catch (e) {
        if (stopped) break;
        lastError = e.message;
        if (e.code === 409) {
          if (!conflictSeen) {
            conflictSeen = true;
            log('telegram: 409 conflict, deleting webhook');
            await call('deleteWebhook').catch(logErr);
          }
        } else log(`telegram: getUpdates failed: ${e.description ?? e.message}`);
        await nap(backoff);
        backoff = Math.min(backoff * 2, backoffMaxMs);
      }
    }
    polling = false;
  }

  // ---- alerts ----
  function keyboard(row) {
    const rows = [[btn('Got it', `ack:${row.id}`), LIVE], [BUZZ, WHERE]];
    if (row.incident === 1 && row.severity === 'critical') rows.push([btn("It's a walk", `walk:${row.id}`), btn('False alarm', `false:${row.id}`)]);
    return { inline_keyboard: rows };
  }
  function onAlert(row, reason) {
    if (!enabled || stopped || !['open', 'rise'].includes(reason)) return Promise.resolve();
    const text = `<b>${escapeHtml(row.title)}</b>\n${escapeHtml(row.body)}\n<i>${dateTime(row.t)}</i>`;
    const pos = row.data?.position;
    return track(Promise.all(store.chats().filter((c) => delivers(c, row.severity)).map(async (c) => {
      const msg = await fire(c.chat_id, 'sendMessage', { chat_id: c.chat_id, parse_mode: 'HTML', text, reply_markup: keyboard(row) }, 'alert', row.severity);
      if (!msg) return;
      store.setAlertMessage(row.id, c.chat_id, msg.message_id);
      if (pos) await fire(c.chat_id, 'sendLocation', { ...loc(c.chat_id, pos), reply_parameters: { message_id: msg.message_id } }, 'normal', row.severity);
    })));
  }
  function onRepeat(row) {
    if (!enabled || stopped) return Promise.resolve();
    const max = store.getKv('settings')?.thresholds?.repeatMax ?? 10;
    const text = `Repeat ${row.sent_count}/${max}: <b>${escapeHtml(row.title)}</b>`;
    const first = new Map(store.alertMessages(row.id).map((m) => [m.chat_id, m.message_id]));
    // every eligible chat: a reply to its first message, or a fresh message (that becomes the first) if that send failed
    return track(Promise.all(store.chats().filter((c) => delivers(c, row.severity)).map(async (c) => {
      const mid = first.get(c.chat_id);
      const msg = await fire(c.chat_id, 'sendMessage', {
        chat_id: c.chat_id, parse_mode: 'HTML', text, reply_markup: keyboard(row), ...(mid != null && { reply_parameters: { message_id: mid } }),
      }, 'alert', row.severity);
      if (msg && mid == null) store.setAlertMessage(row.id, c.chat_id, msg.message_id);
    })));
  }

  // ---- chase live location ----
  function setChaseMessage(chat, id) {
    if (id == null) delete chaseMsgs[chat];
    else chaseMsgs[chat] = id;
    monitor.setChaseMessage(chat, id);
  }
  // bound to the chase it was sent for: if that chase ended or another began before the send completed, stop it
  async function sendLive(chat, p, since = monitor.chaseState()?.since) {
    if (liveSending.has(chat)) return;
    liveSending.add(chat);
    const m = await fire(chat, 'sendLocation', { ...loc(chat, p), live_period: 86400 }, 'normal', 'critical').finally(() => liveSending.delete(chat));
    if (!m) return;
    if (since != null && monitor.chaseState()?.since === since) setChaseMessage(chat, m.message_id);
    else await send(chat, 'stopMessageLiveLocation', { chat_id: chat, message_id: m.message_id }).catch(() => null);
  }
  function editLive(chat, e) {
    e.last = Date.now();
    const mid = monitor.chaseState()?.messages?.[chat];
    if (mid == null) return;
    send(chat, 'editMessageLiveLocation', { ...loc(chat, e.pos), message_id: mid }, 'normal', 'critical').catch((err) => {
      const d = err.description ?? '';
      if (d.includes('message is not modified')) return null;
      if (d.includes("can't be edited") || d.includes('message to edit not found')) return track(sendLive(chat, e.pos));
      return logErr(err);
    });
  }
  function onChase(ev) {
    if (!enabled || stopped) return Promise.resolve();
    if (ev?.active) {
      const p = ev.position ?? live.get(tid())?.position;
      if (!p) return Promise.resolve();
      return track(Promise.all(store.chats().filter((c) => delivers(c, 'critical')).map((c) => sendLive(c.chat_id, p, ev.since))));
    }
    for (const e of edits.values()) clearTimeout(e.timer);
    edits.clear();
    const msgs = ev?.messages ?? { ...chaseMsgs, ...monitor.chaseState()?.messages };
    const mins = Math.round((ev?.durationS ?? 0) / 60), m = Math.round(ev?.distanceM ?? 0);
    const dur = mins < 120 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
    const dist = m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
    return track(Promise.all(Object.entries(msgs).map(async ([chat, id]) => {
      await send(chat, 'stopMessageLiveLocation', { chat_id: chat, message_id: id }).catch(() => null);
      setChaseMessage(chat, null);
      await reply(chat, `Chase ended after ${dur}, ${dist} travelled.`);
    })));
  }
  function onChasePosition(pos) {
    if (!enabled || stopped || !pos) return;
    const msgs = { ...monitor.chaseState()?.messages };
    Object.assign(chaseMsgs, msgs);
    const eligible = new Set(store.chats().filter((c) => delivers(c, 'critical')).map((c) => c.chat_id));
    for (const [chat, id] of Object.entries(msgs)) {
      if (eligible.has(chat)) continue;
      // removed (or muted) since the chase began: stop its live location and forget it
      clearTimeout(edits.get(chat)?.timer);
      edits.delete(chat);
      delete msgs[chat];
      setChaseMessage(chat, null);
      track(send(chat, 'stopMessageLiveLocation', { chat_id: chat, message_id: id }).catch(() => null));
    }
    for (const chat of eligible) {
      // no live location yet (no position at chase start, or the first send failed): send one now
      if (msgs[chat] == null) track(sendLive(chat, pos));
    }
    for (const chat of Object.keys(msgs)) {
      let e = edits.get(chat);
      if (!e) edits.set(chat, (e = { last: -Infinity, pos: null, timer: null }));
      e.pos = pos;
      if (e.timer) continue;
      const wait = e.last + editEveryMs - Date.now();
      if (wait <= 0) editLive(chat, e);
      else e.timer = setTimeout(() => { e.timer = null; editLive(chat, e); }, wait);
    }
  }

  async function sendTest(chatId) {
    if (!enabled) throw new Error('Telegram is not configured');
    const ids = chatId != null ? [String(chatId)] : store.chats().filter((c) => c.approved_at).map((c) => c.chat_id);
    await Promise.all(ids.map((id) => send(id, 'sendMessage', { chat_id: id, text: TEST_TEXT })));
    return ids.length;
  }

  return {
    async start() {
      if (!enabled || started) return;
      started = true;
      for (const id of chatIds) store.upsertChat({ chat_id: String(id), name: store.chat(String(id))?.name ?? null, approved_at: nowS() });
      try {
        botName = (await call('getMe'))?.username ?? botName;
      } catch (e) {
        lastError = e.message;
      }
      if (!stopped) pollDone = poll();
    },
    async stop() {
      stopped = true;
      ac.abort();
      for (const e of edits.values()) clearTimeout(e.timer);
      edits.clear();
      for (const q of queues.values()) {
        for (const job of q.alert.splice(0).concat(q.normal.splice(0))) job.reject(Object.assign(new Error('telegram stopped'), { stopped: true }));
      }
      await pollDone;
    },
    async idle() {
      while (busy > 0) await sleep(10);
    },
    status: () => ({ enabled, botName, polling, lastError, lastUpdateAt, handled }),
    createPairingCode, onAlert, onRepeat, onChase, onChasePosition, sendTest,
  };
}
