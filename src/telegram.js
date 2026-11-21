// Telegram bot: long polling, pairing, chat authorisation (private chats, groups, supergroups), commands, callback buttons, alert/repeat delivery,
// chase live locations and a two-lane per-chat rate limiter. The token never leaves this module unredacted.
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const NOT_AUTH = 'Not authorised. Pair this chat from the OpenTractive web app (Telegram page).';
const PAIRED = 'Paired. This chat now gets OpenTractive alerts. Send /panel for the control panel, /pin to keep a live one at the top, /help for every command.';
const TEST_TEXT = 'Test message from OpenTractive. Alerts will look like this.';
const RANK = { info: 0, warn: 1, critical: 2 };
const CHARGING = { CHARGING: 'charging', NOT_CHARGING: 'not charging', FULLY_CHARGED: 'fully charged' };
const USAGE = {
  live: 'Usage: /live on|off', led: 'Usage: /led on|off', buzz: 'Usage: /buzz on|off', chase: 'Usage: /chase on|off',
  watch: 'Usage: /watch on|off', zone: 'Usage: /zone, /zone off|on or /zone off|on <name>', walk: 'Usage: /walk [minutes] (1-720) or /walk off',
  mute: 'Usage: /mute <minutes> (1-720) or /mute all <minutes>',
};
const HELP = [
  'OpenTractive commands:',
  '/panel - control panel: status and buttons for everything below',
  '/pin - pin a panel that keeps itself up to date (the bot needs the pin right)',
  '/status - where the dog is, battery, last fix and modes',
  '/where - last position on the map',
  '/live on|off - live tracking',
  '/locate - ask the tracker for a fresh position',
  '/led on|off - tracker light',
  '/buzz on|off - tracker buzzer',
  '/chase on|off - chase mode with a live location',
  '/watch on|off - yard watch',
  '/zone - Wi-Fi zones; /zone off|on [name] switches them (off: GPS in the zone too)',
  '/walk [minutes]|off - walk mode (default 120 min)',
  '/mute <minutes> - mute info and warning alerts (1-720)',
  '/mute all <minutes> - mute every alert, critical included',
  '/unmute - end a mute',
  '/escapes - last escapes',
  '/help - this list',
].join('\n');

// the "/" menu Telegram shows while typing
const MENU = [
  ['panel', 'Control panel with buttons'], ['status', 'Where the dog is, battery and modes'], ['where', 'Last position on the map'],
  ['locate', 'Ask the tracker for a fresh position'], ['live', 'Live tracking: on or off'], ['chase', 'Chase mode with a live location: on or off'],
  ['watch', 'Yard watch: on or off'], ['zone', 'Wi-Fi zones: list, or off/on [name]'], ['walk', 'Walk mode: [minutes] or off'],
  ['mute', 'Mute alerts: <minutes> or all <minutes>'], ['unmute', 'End a mute'], ['led', 'Tracker light: on or off'],
  ['buzz', 'Tracker buzzer: on or off'], ['escapes', 'Last escapes'], ['pin', 'Pin a self-updating panel'], ['help', 'Every command'],
].map(([command, description]) => ({ command, description }));
const SEV = { critical: '🚨', warn: '⚠️', info: 'ℹ️' };
const SENSOR = { GPS: 'GPS', KNOWN_WIFI: 'Wi-Fi zone', WIFI: 'Wi-Fi', GSM: 'cell', CELL: 'cell' };
const VIEWS = new Set(['main', 'walk', 'mute', 'light', 'buzz', 'zones']);
const PANEL_CMDS = new Set(['where', 'locate', 'live', 'chase', 'watch', 'zone', 'walk', 'mute', 'unmute', 'led', 'buzz']);
const NO_PREVIEW = { is_disabled: true };
const PANELS = 'telegramPanels';

const btn = (text, data) => ({ text, callback_data: data });
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r.length) });
const LIVE = btn('📡 Live on', 'live:on'), BUZZ = btn('🔔 Buzz', 'buzz:on'), WHERE = btn('📍 Where', 'where');
const replyTo = (ctx) => ({
  ...(ctx?.thread != null && { message_thread_id: ctx.thread }),
  ...(ctx?.to != null && { reply_parameters: { message_id: ctx.to, allow_sending_without_reply: true } }),
});
const topicOf = (m) => ({ thread: m?.is_topic_message ? m.message_thread_id : null });
const who = (from) => from?.first_name ?? (from?.username ? `@${from.username}` : 'someone');

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
  token, apiUrl = 'https://api.telegram.org', chatIds = [], store, monitor, live, trackerId, posRequestAllowed = () => true, zoneSwitch = () => null, petName = () => 'The dog',
  escapesSummary = () => [], appUrl = '', now = Date.now, log = () => {}, pollTimeoutS = 50, minIntervalMs = 1000,
  backoffMinMs = 5000, backoffMaxMs = 60000, editEveryMs = 5000, botName: botNameOpt = null, callTimeoutMs = 15000, panelEveryMs = 20000,
}) {
  const enabled = !!token;
  const ac = new AbortController(), pollAc = new AbortController(); // pollAc ends the long poll only, so accepted commands can finish
  const nowS = () => Math.floor(now() / 1000);
  const tid = () => (typeof trackerId === 'function' ? trackerId() : trackerId);
  const nap = (ms) => sleep(ms, undefined, { signal: ac.signal }).catch(() => {});
  let botName = botNameOpt, polling = false, lastError = null, lastUpdateAt = null, handled = 0;
  let stopped = false, started = false, pollDone = null, conflictSeen = false, busy = 0, panelTimer = null;
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
        signal: AbortSignal.any([ac.signal, ...(method === 'getUpdates' ? [pollAc.signal] : []), AbortSignal.timeout(method === 'getUpdates' ? (pollTimeoutS + 15) * 1000 : callTimeoutMs)]),
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
  const reply = (chat, text, severity, ctx) => fire(chat, 'sendMessage', { chat_id: chat, text, ...replyTo(ctx) }, 'normal', severity);
  const appRow = (label, hash) => (appUrl ? [{ text: label, url: `${appUrl}/#/${hash}` }] : []);
  const loc = (chat, p) => ({
    chat_id: chat, latitude: p.lat, longitude: p.lng, ...(p.acc != null && { horizontal_accuracy: Math.min(p.acc, 1500) }),
  });

  function delivers(chat, severity) {
    if (!chat?.approved_at) return false;
    if ((RANK[severity] ?? 0) < (RANK[chat.min_severity] ?? 0)) return false;
    return !(chat.muted_until > nowS() && (severity !== 'critical' || chat.mute_all));
  }

  // ---- answers ----
  const when = (t) => (nowS() - t < 86400 ? hhmm(t) : dateTime(t));
  const accText = (p) => (p.acc == null ? '?' : Math.round(p.acc));
  const zoneLine = (z) => `${z.name}: ${z.off ? `off since ${hhmm(z.offAt)}${z.confirmedAt ? `, GPS confirmed at ${hhmm(z.confirmedAt)}` : ', waiting for the tracker to move'}` : 'on'}`;

  // The status card: absolute times only, so an unchanged state renders the same text and the panel refresh sends no edit.
  function card(chat, view = 'main', foot = null) {
    const st = live.get(tid()), s = monitor.status(), f = s.lastFix, p = st?.position, zone = st?.pszName ?? 'unknown';
    const [dot, words] = {
      inside: ['🟢', 'In the yard'], psz: ['🏠', `In Wi-Fi zone ${zone}`], away: ['📍', `At Wi-Fi zone ${zone}`],
      outside: ['🔴', `OUT, ${Math.round(f?.d ?? 0)} m from the fence`], uncertain: ['🟡', 'Near the fence'],
    }[f?.cls] ?? ['⚪', st?.stateLabel ?? 'Unknown'];
    const c = st?.controls ?? {}, ch = store.chat(chat), zs = zoneSwitch()?.status() ?? [], loc = zoneSwitch()?.locateStatus?.().active;
    const yw = s.yardWatch?.status ?? 'off';
    const lines = [
      `${dot} <b>${escapeHtml(petName())}</b> · ${escapeHtml(words)}`,
      `🔋 ${st?.battery ?? '?'} % · ${CHARGING[st?.charging] ?? 'unknown'}`,
      p ? `📍 Last fix ${when(p.t)} · ±${accText(p)} m · ${escapeHtml(SENSOR[p.sensor] ?? p.sensor ?? 'unknown sensor')}` : '📍 No position yet',
      `📡 Live ${c.live?.active ? 'on' : 'off'}${c.live?.pending ? ' (pending)' : ''}${s.live?.wanted && !s.live?.manual ? ' (automatic)' : ''} · 🏃 Chase ${s.chase ? `since ${hhmm(s.chase.since)}` : 'off'}`,
      `👁 Yard watch ${escapeHtml(yw.replace(/-/g, ' '))} · 🦮 Walk ${s.walk ? `until ${hhmm(s.walk.until)}` : 'off'}`,
    ];
    if (view === 'zones') lines.push('', '📶 <b>Wi-Fi zones</b>', ...(zs.length ? zs.map((z) => escapeHtml(zoneLine(z))) : ['No Wi-Fi zones.']));
    else if (zs.length) lines.push(`📶 ${zs.map((z) => `${escapeHtml(z.name)} ${z.off ? 'off' : 'on'}`).join(' · ')}`);
    if (loc) lines.push(`🎯 Locating: Wi-Fi zone off until the first GPS fix (at most ${hhmm(loc.until)})`);
    if (ch?.muted_until > nowS()) lines.push(`🔕 ${ch.mute_all ? 'Every alert' : 'Info and warning alerts'} muted until ${hhmm(ch.muted_until)}`);
    if (view === 'buzz') lines.push('', '🔔 <b>The buzzer is loud.</b> Press “Yes, buzz” to sound it.');
    if (foot) lines.push('', `<i>${escapeHtml(foot)}</i>`);
    return lines.join('\n');
  }
  function panelKeyboard(view) {
    const B = (text, a) => btn(text, `p:${a}`), back = [B('« Back', 'v:main')];
    const zs = zoneSwitch()?.status() ?? [];
    if (view === 'walk') return kb([B('30 min', 'walk:30'), B('1 h', 'walk:60'), B('2 h', 'walk:120'), B('4 h', 'walk:240')], [B('🏠 Walk off', 'walk:off')], back);
    if (view === 'mute') return kb([B('30 min', 'mute:30'), B('1 h', 'mute:60'), B('2 h', 'mute:120')], [B('🔕 Every alert for 1 h', 'mute:all:60')], [B('🔔 Unmute', 'unmute')], back);
    if (view === 'light') return kb([B('💡 Light on', 'led:on'), B('Light off', 'led:off')], back);
    if (view === 'buzz') return kb([B('🔔 Yes, buzz', 'buzz:on'), B('🔕 Stop the buzzer', 'buzz:off')], back);
    if (view === 'zones') return kb(...zs.map((z) => [B(`${z.off ? '📶 Switch on' : '📴 Switch off'} ${z.name}`, `z:${z.id}:${z.off ? 'on' : 'off'}`)]), back);
    const s = monitor.status(), liveOn = !!s.live?.manual, chase = !!s.chase;
    const watching = (s.yardWatch?.status ?? 'off') !== 'off';
    const yard = (monitor.pszFlags?.() ?? []).filter((f) => f.coversYard), yardOff = yard.some((f) => f.off);
    return kb(
      [B('📍 Where', 'where'), B('🎯 Locate', 'locate'), B('🔄 Refresh', 'refresh')],
      [B(liveOn ? '📡 Stop live' : '📡 Start live', `live:${liveOn ? 'off' : 'on'}`), B(chase ? '🏁 Stop chase' : '🏃 Chase', `chase:${chase ? 'off' : 'on'}`)],
      [B(watching ? '👁 Yard watch off' : '👁 Yard watch on', `watch:${watching ? 'off' : 'on'}`), ...(yard.length ? [B(yardOff ? '📶 Wi-Fi zone on' : '📴 Wi-Fi zone off', `zone:${yardOff ? 'on' : 'off'}`)] : [])],
      [B('🦮 Walk ▸', 'v:walk'), B('🔕 Mute ▸', 'v:mute'), ...(zs.length ? [B('📶 Zones ▸', 'v:zones')] : [])],
      [B('💡 Light ▸', 'v:light'), B('🔔 Buzz ▸', 'v:buzz')],
      appRow('🌐 Open the app', ''),
    );
  }

  // ---- panels: status cards with buttons, edited in place; the last few per chat refresh themselves ----
  const panelMsg = (chat, view, foot) => ({ text: card(chat, view, foot), parse_mode: 'HTML', link_preview_options: NO_PREVIEW, reply_markup: panelKeyboard(view) });
  const sigOf = (m) => JSON.stringify([m.text, m.reply_markup]);
  const panels = () => store.getKv(PANELS) ?? {};
  const panelRec = (chat, id) => panels()[chat]?.find((p) => p.id === id) ?? null;
  function rememberPanel(chat, id, rec) {
    const all = panels();
    const list = [...(all[chat] ?? []).filter((p) => p.id !== id), { id, ...rec }];
    // the latest pinned panel and the two latest others
    all[chat] = [...list.filter((p) => p.pinned).slice(-1), ...list.filter((p) => !p.pinned).slice(-2)].sort((a, b) => a.id - b.id);
    store.setKv(PANELS, all);
  }
  function dropPanels(chat) { const all = panels(); delete all[chat]; store.setKv(PANELS, all); }
  function forgetPanel(chat, id) {
    const all = panels();
    all[chat] = (all[chat] ?? []).filter((p) => p.id !== id);
    if (!all[chat].length) delete all[chat];
    store.setKv(PANELS, all);
  }
  async function sendPanel(chat, view = 'main', ctx = {}) {
    const m = panelMsg(chat, view, null);
    const sent = await fire(chat, 'sendMessage', { chat_id: chat, ...m, ...replyTo(ctx) });
    if (sent) rememberPanel(chat, sent.message_id, { view, foot: null, sig: sigOf(m), pinned: false, at: nowS() });
    return sent;
  }
  const editing = new Set(); // "chat:id" with an edit queued: the refresh never stacks a second one
  async function editPanel(chat, id, view, foot) {
    const m = panelMsg(chat, view, foot), key = `${chat}:${id}`, prev = panelRec(chat, id);
    rememberPanel(chat, id, { view, foot, sig: prev?.sig ?? null, pinned: !!prev?.pinned, at: nowS() });
    editing.add(key);
    let done = false;
    try {
      await send(chat, 'editMessageText', { chat_id: chat, message_id: id, ...m });
      done = true;
    } catch (e) {
      const d = e.description ?? '';
      if (d.includes('message is not modified')) done = true;
      else if (d.includes('message to edit not found') || d.includes("can't be edited")) forgetPanel(chat, id);
      else logErr(e);
    } finally {
      editing.delete(key);
    }
    const r = done && panelRec(chat, id);
    if (r && r.view === view && r.foot === foot) rememberPanel(chat, id, { ...r, sig: sigOf(m) });
  }
  function refreshPanels() {
    for (const [chat, list] of Object.entries(panels())) {
      if (!store.chat(chat)?.approved_at) { dropPanels(chat); continue; }
      for (const p of list) {
        if (!p.pinned || editing.has(`${chat}:${p.id}`)) continue; // other panels refresh when pressed
        if (sigOf(panelMsg(chat, p.view, p.foot)) !== p.sig) track(editPanel(chat, p.id, p.view, p.foot));
      }
    }
  }

  function where(chat, ctx = null) {
    const p = live.get(tid())?.position;
    if (!p) return 'No position yet.';
    fire(chat, 'sendVenue', {
      chat_id: chat, latitude: p.lat, longitude: p.lng, title: `${petName()} · ±${accText(p)} m`,
      address: `${when(p.t)} · ${SENSOR[p.sensor] ?? p.sensor ?? 'unknown sensor'} · ${age(nowS() - p.t)} ago`, ...replyTo(ctx),
    });
    return null;
  }
  function escapesText() {
    const list = escapesSummary().slice(0, 5);
    if (!list.length) return 'No escapes recorded.';
    return ['Last escapes:', ...list.map((e) => `${dateTime(e.t_outside)} · ${e.quality} · gap ${e.gap_s} s`)].join('\n');
  }

  async function zoneCommand([a, ...rest], actor) {
    const zs = zoneSwitch();
    if (!zs) return 'Wi-Fi zones are not available yet.';
    const list = zs.status();
    const on = need(onOff(a), 'zone');
    const name = rest.join(' ').trim().toLowerCase();
    const covers = new Set(monitor.pszFlags().filter((f) => f.coversYard).map((f) => f.id));
    const targets = name ? list.filter((z) => String(z.name ?? '').toLowerCase() === name)
      : list.filter((z) => (on ? z.off : covers.has(z.id) && !z.off));
    if (!targets.length) return name ? `No Wi-Fi zone named ${rest.join(' ')}.` : `Nothing to switch ${on ? 'on' : 'off'}.`;
    const done = [];
    for (const z of targets) done.push(await zs.switchZone(z.id, on, actor));
    return [...done.filter(Boolean).map(zoneLine), on ? '' : 'The tracker applies it the next time it moves.'].filter(Boolean).join('\n');
  }

  const need = (v, cmd) => { if (v == null) throw Object.assign(new Error(USAGE[cmd]), { usage: true }); return v; };
  // a command sent without its argument opens the panel where its buttons are
  const panelCmd = (view) => async (chat, args, actor, ctx) => { await sendPanel(chat, view, ctx); return null; };
  const orPanel = (view, fn) => (chat, args, actor, ctx) => (args[0] === undefined ? panelCmd(view)(chat, args, actor, ctx) : fn(chat, args, actor, ctx));
  const trackerCmd = (name, label) => async (chat, [a], actor) => {
    const on = need(onOff(a), label);
    await monitor.command(actor, tid(), name, on);
    return `${name === 'led_control' ? 'Light' : 'Buzzer'} ${on ? 'on' : 'off'} requested.`;
  };
  const COMMANDS = {
    status: panelCmd('main'),
    panel: panelCmd('main'),
    start: panelCmd('main'),
    pin: async (chat, args, actor, ctx) => {
      const m = await sendPanel(chat, 'main', ctx);
      if (!m) return 'Could not send the panel.';
      try {
        await send(chat, 'pinChatMessage', { chat_id: chat, message_id: m.message_id, disable_notification: true });
      } catch (e) {
        return `Could not pin it (${redact(e.description ?? e.message, token)}). In a group the bot must be an admin with the right to pin messages.`;
      }
      rememberPanel(chat, m.message_id, { ...panelRec(chat, m.message_id), pinned: true });
      return null;
    },
    where: (chat, args, actor, ctx) => where(chat, ctx),
    live: orPanel('main', async (chat, [a], actor) => { const on = need(onOff(a), 'live'); await monitor.setManualLive(on, actor); return `Live tracking ${on ? 'on' : 'off'} requested.`; }),
    locate: async (chat, args, actor) => {
      if (posRequestAllowed()) { await monitor.command(actor, tid(), 'pos_request', true); return 'Position requested.'; }
      const zs = zoneSwitch();
      if (!zs) return 'Locate now is not available for this Tractive account.';
      const loc = await zs.locate(actor);
      return `Locating: the Wi-Fi zone is off until the first GPS fix (at most until ${hhmm(loc.until)}). The tracker reports it once it moves.`;
    },
    led: orPanel('light', trackerCmd('led_control', 'led')),
    buzz: orPanel('buzz', trackerCmd('buzzer_control', 'buzz')),
    chase: orPanel('main', async (chat, [a], actor) => {
      const on = need(onOff(a), 'chase');
      await monitor.setChase(on, actor);
      if (on && !monitor.chaseState()) return monitor.status().walk ? 'Chase not started: walk mode is on. Send /walk off first.' : 'Chase not started: the battery is too low.';
      return `Chase ${on ? 'started' : 'stopped'}.`;
    }),
    watch: orPanel('main', async (chat, [a], actor) => { const on = need(onOff(a), 'watch'); await monitor.setYardWatch(on, actor); return `Yard watch ${on ? 'on' : 'off'}.`; }),
    walk: (chat, [a], actor) => {
      const m = a === undefined ? 120 : a === 'off' ? null : need(minutes(a), 'walk');
      monitor.setWalk(m, actor);
      return m == null ? 'Walk mode off.' : `Walk mode for ${m} min.`;
    },
    mute: orPanel('mute', (chat, args) => {
      const all = args[0] === 'all';
      const m = need(minutes(all ? args[1] : args[0]), 'mute');
      store.updateChat(chat, { muted_until: nowS() + m * 60, mute_all: all ? 1 : 0 });
      return all ? `Every alert muted for ${m} min.` : `Info and warning alerts muted for ${m} min. Critical alerts still come through.`;
    }),
    unmute: (chat) => { store.updateChat(chat, { muted_until: null, mute_all: 0 }); return 'Alerts unmuted.'; },
    zone: orPanel('zones', async (chat, args, actor) => zoneCommand(args, actor)),
    escapes: async (chat, args, actor, ctx) => {
      await fire(chat, 'sendMessage', { chat_id: chat, text: escapesText(), ...replyTo(ctx), ...(appUrl && { reply_markup: kb(appRow('🕳 Open the escapes', 'escapes')) }) });
      return null;
    },
    help: () => HELP,
  };

  // Runs one command and logs it; a null result means the command already sent its own message.
  async function exec(chat, cmd, args, actor, ctx = {}) {
    let out, ok = true;
    try {
      const fn = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
      out = fn ? await fn(chat, args, actor, ctx) : 'Unknown command. Send /help to see the commands.';
      ok = !!fn;
    } catch (e) {
      ok = false;
      out = e.usage ? e.message : `Failed: ${redact(e?.message ?? e, token)}`;
    }
    store.logCommand({ t: nowS(), actor, action: `telegram:${cmd}`, params: { args }, ok, result: out ?? 'sent' });
    return out;
  }
  async function command(chat, text, m) {
    const [head, ...args] = text.split(/\s+/);
    const cmd = head.replace(/^\//, '').replace(/@\S*$/, '').toLowerCase();
    // in a group the answer replies to the asker, inside the same topic of a forum group
    const ctx = { to: m?.chat?.type === 'private' ? null : m?.message_id ?? null, thread: m?.is_topic_message ? m.message_thread_id : null };
    const out = await exec(chat, cmd, args, `telegram:${chat}`, ctx);
    if (out != null) reply(chat, out, undefined, ctx);
  }

  // A panel button: navigation only swaps the keyboard; an action runs the command and shows its result, who pressed it
  // and when at the bottom of the same message.
  async function panelButton(q, chat, [a, ...args], actor) {
    const id = q.message?.message_id;
    if (id == null) return;
    const rec = panelRec(chat, id);
    let view = rec?.view ?? 'main', foot = rec?.foot ?? null;
    if (a === 'v') view = VIEWS.has(args[0]) ? args[0] : 'main';
    else if (a === 'z' || PANEL_CMDS.has(a)) {
      let out;
      if (a === 'z') {
        try {
          const zs = zoneSwitch();
          const z = zs ? await zs.switchZone(args[0], need(onOff(args[1]), 'zone'), actor) : null;
          out = z ? zoneLine(z) : 'Wi-Fi zones are not available yet.';
        } catch (e) { out = e.usage ? e.message : `Failed: ${redact(e?.message ?? e, token)}`; }
      } else out = (await exec(chat, a, args, actor, topicOf(q.message))) ?? (a === 'where' ? 'Position sent' : 'Done');
      foot = `${out.split('\n')[0]} · ${who(q.from)} · ${hhmm(nowS())}`;
      view = 'main';
    } else if (a !== 'refresh') return;
    await editPanel(chat, id, view, foot);
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
      dropPanels(old.chat_id);
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
    if (approved) return command(chat, text, m);
    const start = /^\/start(?:@\S+)?\s+(\S+)$/.exec(text);
    if (start) pair(chat, start[1], m);
    else notAuthorised(chat);
  }

  // Telegram shows a spinner until the answer and gives up after a few seconds: answer before any queued action.
  function answer(q, backlog) {
    // callback queries carry no date: a backlog press on a message older than 2 min is a replay from before the restart
    const stale = backlog && q.message?.date < startedAt / 1000 - 120;
    track(call('answerCallbackQuery', { callback_query_id: q.id, ...(stale && { text: 'Ignored a button press from before a restart. Press it again.' }) }).catch(logErr));
    return stale;
  }
  async function onCallback(q) {
    const chat = String(q.message?.chat?.id ?? '');
    if (!chat || !store.chat(chat)?.approved_at) return;
    const actor = `telegram:${chat}`;
    const data = String(q.data ?? '');
    const [act, arg] = data.split(':');
    const id = /^\d+$/.test(arg ?? '') ? Number(arg) : null;
    if (act === 'p') return panelButton(q, chat, data.split(':').slice(1), actor);
    const by = `${who(q.from)} · ${hhmm(nowS())}`;
    if (act === 'ack' && id != null) {
      const was = store.alert(id)?.acked_at;
      settled(q, chat, (await monitor.ack(id, actor)) && was == null ? `✅ Got it · ${by}` : null); // a second ack only tidies the buttons
    }
    else if (act === 'false' && id != null) settled(q, chat, (await monitor.falseAlarm(id, actor)) ? `🙅 False alarm · ${by}` : null);
    else if (act === 'walk' && id != null) settled(q, chat, (await monitor.itsAWalk(id, actor)) ? `🦮 It's a walk · ${by}` : null);
    else if (data === 'live:on') await monitor.setManualLive(true, actor);
    else if (data === 'buzz:on') await monitor.command(actor, tid(), 'buzzer_control', true);
    else if (data === 'where') { const ctx = topicOf(q.message), t = where(chat, ctx); if (t) reply(chat, t, undefined, ctx); }
  }
  // An alert someone handled: append who did what (the entities still fit, the text only grows at the end) and keep
  // only the buttons that still make sense.
  function settled(q, chat, line) {
    const m = q.message, markup = kb([LIVE, BUZZ, WHERE], appRow('🗺 Open the map', ''));
    if (m?.message_id == null) return;
    if (!line || !m.text || m.text.length + line.length > 4000) fire(chat, 'editMessageReplyMarkup', { chat_id: chat, message_id: m.message_id, reply_markup: markup });
    else fire(chat, 'editMessageText', { chat_id: chat, message_id: m.message_id, text: `${m.text}\n\n${line}`, entities: m.entities ?? [], reply_markup: markup });
  }

  const chains = new Map();
  function handle(u, backlog) {
    lastUpdateAt = nowS();
    const q = u.callback_query, stale = q ? answer(q, backlog) : false;
    const key = String(u.message?.chat?.id ?? q?.message?.chat?.id ?? '');
    const run = () => (u.message ? onMessage(u.message) : q && !stale ? onCallback(q) : null);
    const p = (chains.get(key) ?? Promise.resolve()).then(run).catch(logErr).finally(() => {
      handled++;
      if (chains.get(key) === p) chains.delete(key);
    });
    chains.set(key, p);
    return track(p);
  }

  async function poll() {
    polling = true;
    let backoff = backoffMinMs, first = true;
    startedAt = now();
    while (!stopped && !pollAc.signal.aborted) {
      try {
        // calls do not wait (timeout 0) until one comes back empty: those pages (up to 100 updates each) are the backlog from while we were down
        const updates = await call('getUpdates', { offset: store.getKv('telegramOffset') ?? 0, timeout: first ? 0 : pollTimeoutS, allowed_updates: ['message', 'callback_query'] });
        const backlog = first;
        first = first && updates?.length > 0;
        backoff = backoffMinMs;
        for (const u of updates ?? []) {
          if (stopped) break;
          store.setKv('telegramOffset', u.update_id + 1);
          handle(u, backlog); // a slow command (Tractive is rate limited) holds up its own chat only
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
    const rows = [[btn('✅ Got it', `ack:${row.id}`), LIVE], [BUZZ, WHERE]];
    if (row.incident === 1 && row.severity === 'critical') rows.push([btn("🦮 It's a walk", `walk:${row.id}`), btn('🙅 False alarm', `false:${row.id}`)]);
    return kb(...rows, appRow('🗺 Open the map', ''));
  }
  function onAlert(row, reason) {
    if (!enabled || stopped || !['open', 'rise'].includes(reason)) return Promise.resolve();
    const text = `${SEV[row.severity] ?? ''} <b>${escapeHtml(row.title)}</b>\n${escapeHtml(row.body)}\n<i>${dateTime(row.t)}</i>`;
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
    const text = `🔁 Repeat ${row.sent_count}/${max}: ${SEV[row.severity] ?? ''} <b>${escapeHtml(row.title)}</b>`;
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
      await reply(chat, `🏁 Chase ended after ${dur}, ${dist} travelled.`);
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
        track(call('setMyCommands', { commands: MENU }).catch(logErr));
      } catch (e) {
        lastError = e.message;
      }
      if (stopped) return;
      pollDone = poll();
      panelTimer = setInterval(refreshPanels, panelEveryMs);
      panelTimer.unref?.();
    },
    async stop() {
      // the offset of every accepted update is already stored: let their commands finish (10 s at most) before closing
      pollAc.abort();
      await Promise.race([Promise.all([...chains.values()]), sleep(10000, undefined, { ref: false })]);
      stopped = true;
      clearInterval(panelTimer);
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
