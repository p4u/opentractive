import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { LiveState } from '../src/state.js';
import { createTelegram, redact } from '../src/telegram.js';
import { startMock } from './mock/server.js';
import { TID, until, ll } from './helpers.js';

const TOKEN = '123456:TEST-TOKEN-abc';
function fakeMonitor() {
  const m = new EventEmitter();
  m.calls = [];
  m.chase = null;
  const rec = (name, ret) => (...args) => { m.calls.push([name, ...args]); return typeof ret === 'function' ? ret(...args) : ret; };
  Object.assign(m, {
    ack: rec('ack', (id) => ({ id })), falseAlarm: rec('falseAlarm', (id) => ({ id })), itsAWalk: rec('itsAWalk', (id) => ({ id })),
    setManualLive: rec('setManualLive', () => Promise.resolve()), setChase: rec('setChase', () => Promise.resolve()),
    setWalk: rec('setWalk'), setYardWatch: rec('setYardWatch'), command: rec('command', () => Promise.resolve({ active: true, pending: true })),
    status: () => ({ incident: null, chase: null, walk: null, yardWatch: { status: 'off' }, live: { wanted: false, manual: false, failures: 0 }, lastFix: { cls: 'inside', d: -12, t: 0 } }),
    chaseState: () => m.chase,
    setChaseMessage: (chatId, id) => {
      m.chase ??= { messages: {} };
      if (id == null) delete m.chase.messages[chatId];
      else m.chase.messages[chatId] = id;
    },
  });
  return m;
}
async function setup(t, { chatIds = ['1001'], mock, ...opts } = {}) {
  mock ??= await startMock();
  const store = new Store(':memory:');
  const live = new LiveState();
  const p = ll(3, 4);
  const nowS = Math.floor(Date.now() / 1000);
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, tracker_state: 'OPERATIONAL', charging_state: 'NOT_CHARGING',
    hardware: { time: nowS, battery_level: 77 }, position: { time: nowS - 60, latlong: [p.lat, p.lng], sensor_used: 'GPS', accuracy: 6 } });
  const monitor = fakeMonitor();
  const logs = [];
  const bot = createTelegram({
    token: TOKEN, apiUrl: `${mock.url}/telegram`, chatIds, store, monitor, live, trackerId: TID, petName: () => 'Rex',
    escapesSummary: () => [{ t_outside: 1_790_000_000, quality: 'good', gap_s: 3 }], appUrl: 'http://app.example',
    pollTimeoutS: 1, minIntervalMs: 50, backoffMinMs: 50, backoffMaxMs: 200, editEveryMs: 200, log: (m) => logs.push(m), ...opts,
  });
  t.after(async () => { await bot.stop(); await mock.close(); });
  await bot.start();
  return { mock, store, live, monitor, bot, logs };
}
const sent = (mock) => mock.get('/__mock/telegram/sent');
const say = (mock, chatId, text, extra = {}) => mock.post('/__mock/telegram/update', { update: { message: {
  message_id: Math.floor(Math.random() * 1e6), chat: { id: Number(chatId), type: 'private', first_name: 'T' },
  from: { id: Number(chatId), is_bot: false, first_name: 'T' }, text, ...extra } } });
const textsTo = async (mock, chatId) => (await sent(mock)).filter((s) => s.method === 'sendMessage' && String(s.body.chat_id) === String(chatId)).map((s) => s.body.text);

test('without a token the bot is off and sends nothing', async () => {
  const mock = await startMock();
  const bot = createTelegram({ token: '', apiUrl: `${mock.url}/telegram`, chatIds: [], store: new Store(':memory:'), monitor: fakeMonitor(), live: new LiveState(), trackerId: TID });
  await bot.start();
  assert.equal(bot.status().enabled, false);
  assert.deepEqual(await mock.get('/__mock/requests?host=telegram'), []);
  await bot.stop();
  await mock.close();
});

test('start: getMe gives the bot name; env chat ids are approved', async (t) => {
  const { bot, store } = await setup(t);
  assert.equal(bot.status().enabled, true);
  assert.equal(bot.status().botName, 'opentractive_test_bot');
  assert.ok(store.chat('1001').approved_at > 0);
});

test('pairing: a 6-digit code approves a private chat once and is consumed', async (t) => {
  const { bot, store, mock } = await setup(t);
  const { code, expiresAt } = bot.createPairingCode();
  assert.match(code, /^\d{6}$/);
  assert.ok(expiresAt >= Math.floor(Date.now() / 1000) + 590);
  await say(mock, 1002, `/start ${code}`);
  await until(() => store.chat('1002')?.approved_at);
  assert.match((await textsTo(mock, 1002)).join('\n'), /paired/i);
  assert.equal(store.getKv('pairing'), null);
  await say(mock, 1003, `/start ${code}`);
  await until(async () => (await textsTo(mock, 1003)).length === 1);
  assert.equal(store.chat('1003'), null);
});

test('pairing: 5 wrong codes per chat per hour, the code is dropped after 10 wrong in total', async (t) => {
  const { bot, store, mock } = await setup(t);
  const { code } = bot.createPairingCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await say(mock, 1003, `/start ${wrong}`);
  await say(mock, 1003, `/start ${code}`);
  await until(() => bot.status().handled >= 6);
  assert.equal(store.chat('1003'), null);
  for (let i = 0; i < 5; i++) await say(mock, 1004, `/start ${wrong}`);
  await until(() => bot.status().handled >= 11);
  assert.equal(store.getKv('pairing'), null);
  await say(mock, 1005, `/start ${code}`);
  await until(() => bot.status().handled >= 12);
  assert.equal(store.chat('1005'), null);
});

test('unauthorised chats get one reply per hour', async (t) => {
  const { bot, mock } = await setup(t);
  await say(mock, 2001, '/status');
  await say(mock, 2001, '/status');
  await until(() => bot.status().handled >= 2);
  await bot.idle();
  assert.deepEqual(await textsTo(mock, 2001), ['Not authorised. Pair this chat from the OpenTractive web app (Telegram page).']);
});

test('a group pairs with /start@bot, any member uses commands and buttons, alerts reach it, a supergroup migration keeps it', async (t) => {
  const { bot, mock, store, monitor } = await setup(t);
  const group = { id: -100, type: 'group', title: 'Family' };
  const inGroup = (text, from = 5, chat = group, extra = {}) => mock.post('/__mock/telegram/update', { update: { message: {
    message_id: Math.floor(Math.random() * 1e6), chat, from: { id: from, is_bot: false, first_name: `M${from}` }, text, ...extra } } });
  await inGroup(`/start@opentractive_test_bot ${bot.createPairingCode().code}`);
  await until(() => store.chat('-100')?.approved_at);
  assert.equal(store.chat('-100').name, 'Family');
  await until(async () => (await textsTo(mock, -100)).some((x) => /paired/i.test(x)));
  await inGroup('/status@opentractive_test_bot', 6);                 // a second member
  await inGroup('/led on', 7);
  await inGroup('hello everyone', 6);                                // group chatter is not a command: no reply
  await inGroup('/status@some_other_bot', 6);                        // addressed to another bot: ignored
  await mock.post('/__mock/telegram/update', { update: { callback_query: { id: 'cbg', from: { id: 8 }, data: 'ack:7', message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: group } } } });
  await until(() => bot.status().handled >= 6);
  await bot.idle();
  assert.ok(monitor.calls.some((c) => c[0] === 'command' && c[1] === 'telegram:-100' && c[3] === 'led_control' && c[4] === true));
  assert.ok(monitor.calls.some((c) => c[0] === 'ack' && c[1] === 7 && c[2] === 'telegram:-100'));
  const texts = await textsTo(mock, -100);
  assert.equal(texts.length, 3, JSON.stringify(texts));
  assert.match(texts[1], /Rex/);
  assert.equal(texts[2], 'Light on requested.');
  // Telegram upgrades the group: the old chat says migrate_to_chat_id, the approval and settings move to the new id
  store.updateChat('-100', { min_severity: 'warn' });
  await inGroup('', 0, group, { text: undefined, migrate_to_chat_id: -1001234 });
  await until(() => store.chat('-1001234')?.approved_at);
  assert.equal(store.chat('-100'), null);
  assert.equal(store.chat('-1001234').name, 'Family');
  assert.equal(store.chat('-1001234').min_severity, 'warn');
  await inGroup('/where', 9, { id: -1001234, type: 'supergroup', title: 'Family' });
  await until(async () => (await sent(mock)).some((s) => s.method === 'sendVenue' && String(s.body.chat_id) === '-1001234'));
  const now = Math.floor(Date.now() / 1000);
  await bot.onAlert({ id: 31, t: now, tracker_id: TID, kind: 'out_confirmed', severity: 'critical', title: 'OUT', body: '', data: {}, incident: 1 }, 'open');
  await bot.idle();
  assert.ok((await textsTo(mock, -1001234)).some((x) => x.startsWith('🚨 <b>OUT</b>')));
});

test('/locate says so and sends nothing when the account does not allow pos_request', async (t) => {
  const { mock, monitor, bot } = await setup(t, { posRequestAllowed: () => false });
  await say(mock, 1001, '/locate');
  await until(() => bot.status().handled >= 1, { timeout: 5000 });
  await bot.idle();
  assert.ok((await textsTo(mock, 1001)).includes('Locate now is not available for this Tractive account.'));
  assert.ok(!monitor.calls.some((c) => c[0] === 'command'));
});

test('commands from an approved chat call the monitor, answer in plain text and are logged', async (t) => {
  const { mock, monitor, store, bot } = await setup(t);
  const cmds = ['/status', '/where', '/live on', '/locate', '/led on', '/buzz off', '/chase off', '/watch on', '/walk', '/walk 30', '/walk off',
    '/mute 30', '/mute all 15', '/unmute', '/escapes', '/help', '/mute abc'];
  for (const c of cmds) await say(mock, 1001, c);
  await until(() => bot.status().handled >= cmds.length, { timeout: 5000 });
  await bot.idle();
  const has = (...want) => assert.ok(monitor.calls.some((c) => JSON.stringify(c) === JSON.stringify(want)), JSON.stringify(want));
  has('setManualLive', true, 'telegram:1001');
  has('command', 'telegram:1001', TID, 'pos_request', true);
  has('command', 'telegram:1001', TID, 'led_control', true);
  has('command', 'telegram:1001', TID, 'buzzer_control', false);
  has('setChase', false, 'telegram:1001');
  has('setYardWatch', true, 'telegram:1001');
  has('setWalk', 120, 'telegram:1001');
  has('setWalk', 30, 'telegram:1001');
  has('setWalk', null, 'telegram:1001');
  assert.equal(store.chat('1001').mute_all, 0);
  assert.equal(store.chat('1001').muted_until, null);
  const texts = await textsTo(mock, 1001);
  assert.equal(texts.length, cmds.length - 1); // /where answers with a venue card, not a text
  assert.match(texts[0], /Rex/);
  assert.match(texts[0], /77 %/);
  assert.ok((await sent(mock)).some((s) => s.method === 'sendVenue' && String(s.body.chat_id) === '1001' && s.body.title === 'Rex · ±6 m'));
  assert.match(texts.find((x) => x.startsWith('Last escapes')), /good/);
  assert.match(texts.find((x) => x.includes('/walk') && x.includes('/mute') && x.includes('/escapes')), /\/help/);
  assert.match(texts.at(-1), /^Usage: \/mute <minutes>/);
  // replies are plain text (they may echo what a member typed); only the status panel is HTML, with every value escaped
  assert.ok((await sent(mock)).filter((s) => s.method === 'sendMessage' && !s.body.text.startsWith('🟢 <b>Rex</b>')).every((s) => s.body.parse_mode === undefined));
  assert.equal(store.commands(100).filter((c) => c.actor === 'telegram:1001').length, cmds.length);
});

test('updates older than 120 s are acknowledged but not executed', async (t) => {
  const { mock, monitor, bot } = await setup(t);
  await say(mock, 1001, '/led on', { date: Math.floor(Date.now() / 1000) - 200 });
  await until(() => bot.status().handled >= 1);
  await bot.idle();
  assert.equal(monitor.calls.filter((c) => c[0] === 'command').length, 0);
  assert.deepEqual(await textsTo(mock, 1001), ['Ignored an old command: /led on']);
  await until(async () => (await mock.get('/__mock/requests?host=telegram')).some((r) => r.path.endsWith('/getUpdates') && r.body?.offset >= 2));
});

test('alerts: min severity, mute, HTML escaping, keyboard, location; one critical per chat, repeats reply to the first message', async (t) => {
  const { bot, mock, store } = await setup(t, { chatIds: ['1001', '1005'] });
  store.updateChat('1005', { min_severity: 'critical' });
  const now = Math.floor(Date.now() / 1000);
  const p = ll(40, 5);
  const warn = { id: 11, t: now, tracker_id: TID, kind: 'out_possible', severity: 'warn', title: 'Possibly <out>', body: 'b & c',
    data: { position: { lat: p.lat, lng: p.lng, acc: 5, t: now } }, incident: 1, acked_at: null, closed_at: null, sent_count: 0 };
  await bot.onAlert(warn, 'open');
  const crit = { ...warn, id: 12, kind: 'out_confirmed', severity: 'critical', title: 'OUT of the yard' };
  await bot.onAlert(crit, 'open');
  await bot.onAlert(crit, 'update');                     // updates send nothing
  await bot.onRepeat({ ...crit, sent_count: 1 });
  await bot.idle();
  const s = await sent(mock);
  const to = (id) => s.filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === id);
  assert.equal(to('1001').length, 3);
  assert.equal(to('1005').length, 2);
  assert.match(to('1001')[0].body.text, /Possibly &lt;out&gt;/);
  assert.match(to('1001')[0].body.text, /b &amp; c/);
  assert.equal(to('1001')[0].body.parse_mode, 'HTML');
  assert.deepEqual(to('1001')[1].body.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data).map((b) => b.callback_data), ['ack:12', 'live:on', 'buzz:on', 'where', 'walk:12', 'false:12']);
  assert.deepEqual(to('1005')[1].body.reply_parameters, { message_id: to('1005')[0].result.message_id });
  assert.match(to('1005')[1].body.text, /^🔁 Repeat 1\/10/);
  assert.ok(s.some((x) => x.method === 'sendLocation' && String(x.body.chat_id) === '1001' && x.body.horizontal_accuracy === 5));
  store.updateChat('1001', { muted_until: now + 600, mute_all: 0 });
  await bot.onAlert({ ...warn, id: 13 }, 'open');
  await bot.onAlert({ ...crit, id: 14 }, 'open');
  store.updateChat('1001', { mute_all: 1 });
  await bot.onAlert({ ...crit, id: 15 }, 'open');
  await bot.idle();
  assert.equal((await textsTo(mock, 1001)).length, 4);
  const nonIncident = (await (async () => { await bot.onAlert({ ...warn, id: 16, incident: 0, kind: 'battery_low', severity: 'critical', data: {} }, 'open'); await bot.idle(); return sent(mock); })())
    .filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '1005').at(-1);
  assert.deepEqual(nonIncident.body.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data).map((b) => b.callback_data), ['ack:16', 'live:on', 'buzz:on', 'where']);
});

test('callback queries are authorised by the message chat and always answered', async (t) => {
  const { mock, monitor, bot } = await setup(t);
  const cb = (chatId, data) => mock.post('/__mock/telegram/update', { update: { callback_query: { id: `cb${Math.random()}`, from: { id: chatId }, data, message: { message_id: 5, chat: { id: chatId, type: 'private' } } } } });
  for (const d of ['ack:7', 'false:8', 'walk:9', 'live:on', 'buzz:on', 'where']) await cb(1001, d);
  await cb(3001, 'ack:7');
  await until(() => bot.status().handled >= 7);
  await bot.idle();
  assert.equal(monitor.calls.filter((c) => c[0] === 'ack').length, 1);
  assert.ok(monitor.calls.some((c) => c[0] === 'ack' && c[1] === 7 && c[2] === 'telegram:1001'));
  assert.ok(monitor.calls.some((c) => c[0] === 'falseAlarm' && c[1] === 8));
  assert.ok(monitor.calls.some((c) => c[0] === 'itsAWalk' && c[1] === 9));
  assert.ok(monitor.calls.some((c) => c[0] === 'setManualLive' && c[1] === true));
  assert.ok(monitor.calls.some((c) => c[0] === 'command' && c[3] === 'buzzer_control' && c[4] === true));
  const s = await sent(mock);
  assert.equal(s.filter((x) => x.method === 'answerCallbackQuery').length, 7);
  assert.ok(s.some((x) => x.method === 'sendVenue' && String(x.body.chat_id) === '1001'));
  assert.ok(s.some((x) => x.method === 'editMessageReplyMarkup' && x.body.message_id === 5));
});

test('callback replay guard: a backlog press on a message older than 2 min is answered but not executed', async (t) => {
  const mock = await startMock();
  let shift = 0;
  const date = Math.floor(Date.now() / 1000);
  const cb = (data, msgDate) => mock.post('/__mock/telegram/update', { update: { callback_query: { id: `cb${Math.random()}`, from: { id: 1001 }, data, message: { message_id: 5, date: msgDate, chat: { id: 1001, type: 'private' } } } } });
  await cb('buzz:on', date - 600);
  await cb('live:on', date - 30);
  const { monitor, bot } = await setup(t, { mock, now: () => Date.now() + shift });
  await until(() => bot.status().handled >= 2);
  await bot.idle();
  assert.equal(monitor.calls.some((c) => c[0] === 'command'), false);
  assert.ok(monitor.calls.some((c) => c[0] === 'setManualLive' && c[1] === true));
  const answers = (await sent(mock)).filter((x) => x.method === 'answerCallbackQuery');
  assert.deepEqual(answers.map((x) => x.body.text), ['Ignored a button press from before a restart. Press it again.', undefined]);
  shift = 3000; // past the backlog window: a fresh press on the same old message runs
  await cb('buzz:on', date - 600);
  await until(() => bot.status().handled >= 3);
  await bot.idle();
  assert.ok(monitor.calls.some((c) => c[0] === 'command' && c[3] === 'buzzer_control' && c[4] === true));
});

test('chase end uses the messages carried by the event when the monitor state is already gone', async (t) => {
  const { mock, monitor, bot } = await setup(t);
  monitor.chase = null;
  await bot.onChase({ active: false, reason: 'manual', durationS: 60, distanceM: 5, messages: { 1001: 42 } });
  await bot.idle();
  const stops = (await sent(mock)).filter((x) => x.method === 'stopMessageLiveLocation');
  assert.deepEqual(stops.map((x) => [String(x.body.chat_id), x.body.message_id]), [['1001', 42]]);
});

test('chase live location per chat, throttled edits, re-send when it cannot edit, stop at the end', async (t) => {
  const { mock, monitor, bot } = await setup(t, { chatIds: ['1001', '1002'] });
  const p0 = ll(30, 0);
  monitor.chase = { since: Math.floor(Date.now() / 1000), incidentId: 1, messages: {} }; // the monitor stores the chase before it emits
  await bot.onChase({ active: true, since: monitor.chase.since, incidentId: 1, position: { lat: p0.lat, lng: p0.lng, acc: 8 } });
  await bot.idle();
  let s = await sent(mock);
  assert.equal(s.filter((x) => x.method === 'sendLocation' && x.body.live_period === 86400).length, 2);
  assert.equal(Object.keys(monitor.chase.messages).length, 2);
  const p1 = ll(40, 0);
  const p2 = ll(50, 0);
  bot.onChasePosition({ lat: p1.lat, lng: p1.lng, acc: 6, t: 1 });
  bot.onChasePosition({ lat: p2.lat, lng: p2.lng, acc: 6, t: 2 });
  await until(async () => (await sent(mock)).filter((x) => x.method === 'editMessageLiveLocation').length >= 4, { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 300));
  s = await sent(mock);
  const edits = s.filter((x) => x.method === 'editMessageLiveLocation');
  assert.equal(edits.length, 4);
  assert.ok(edits.slice(-2).every((e) => e.body.latitude === p2.lat));
  const locs = s.filter((x) => x.method === 'sendLocation').length;
  bot.onChasePosition({ lat: p2.lat, lng: p2.lng, acc: 6, t: 3 });       // not modified: ignored
  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await sent(mock)).filter((x) => x.method === 'sendLocation').length, locs);
  const mid = monitor.chase.messages['1001'];
  await fetch(`${mock.url}/telegram/bot${TOKEN}/stopMessageLiveLocation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 1001, message_id: mid }) });
  const p3 = ll(60, 0);
  bot.onChasePosition({ lat: p3.lat, lng: p3.lng, acc: 6, t: 4 });
  await until(() => monitor.chase.messages['1001'] !== mid, { timeout: 2000 });
  await bot.onChase({ active: false, reason: 'closed', durationS: 600, distanceM: 120 });
  await bot.idle();
  s = await sent(mock);
  assert.equal(s.filter((x) => x.method === 'stopMessageLiveLocation').length, 3);
  assert.ok((await textsTo(mock, 1001)).some((x) => x === '🏁 Chase ended after 10 min, 120 m travelled.'));
  assert.deepEqual(monitor.chase.messages, {});
});

test('409 conflict: logs once, deletes the webhook once, keeps polling', async (t) => {
  const mock = await startMock();
  await mock.post('/__mock/fail', { match: `POST /telegram/bot${TOKEN}/getUpdates`, status: 409, times: 3, body: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } });
  const { logs } = await setup(t, { mock });
  await until(async () => (await mock.get('/__mock/requests?host=telegram')).filter((r) => r.path.endsWith('/getUpdates')).length >= 5, { timeout: 4000 });
  assert.equal((await sent(mock)).filter((x) => x.method === 'deleteWebhook').length, 1);
  assert.equal(logs.filter((l) => /409/.test(l)).length, 1);
});

test('the bot token never appears in logs, status or errors', async (t) => {
  const mock = await startMock();
  await mock.post('/__mock/fail', { match: `POST /telegram/bot${TOKEN}/getUpdates`, status: 500, times: 2 });
  const { bot, logs } = await setup(t, { mock });
  await until(() => logs.some((l) => /getUpdates/.test(l)));
  for (const s of [...logs, JSON.stringify(bot.status())]) assert.ok(!s.includes(TOKEN) && !s.includes('TEST-TOKEN'), s);
  assert.equal(redact(`POST https://api.telegram.org/bot${TOKEN}/sendMessage failed`, TOKEN), 'POST https://api.telegram.org/bot<redacted>/sendMessage failed');
  const deadLogs = [];
  const dead = createTelegram({ token: TOKEN, apiUrl: 'http://127.0.0.1:9', chatIds: [], store: new Store(':memory:'), monitor: fakeMonitor(), live: new LiveState(), trackerId: TID, log: (m) => deadLogs.push(m), backoffMinMs: 50, backoffMaxMs: 100 });
  await dead.start();
  await until(() => dead.status().lastError);
  await dead.stop();
  for (const s of [dead.status().lastError, ...deadLogs]) assert.ok(!s.includes(TOKEN), s);
});

test('one message per minIntervalMs per chat; 429 waits retry_after', async (t) => {
  const mock = await startMock();
  await mock.post('/__mock/fail', { match: `POST /telegram/bot${TOKEN}/sendMessage`, status: 429, times: 1, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } });
  const { bot } = await setup(t, { mock, minIntervalMs: 200 });
  const t0 = Date.now();
  await Promise.all([bot.sendTest('1001'), bot.sendTest('1001'), bot.sendTest('1001')]);
  await bot.idle();
  const times = (await sent(mock)).filter((x) => x.method === 'sendMessage').map((x) => x.at);
  assert.equal(times.length, 3);
  assert.ok(times[0] - t0 >= 950, String(times[0] - t0));
  assert.ok(times[1] - times[0] >= 190 && times[2] - times[1] >= 190, String(times));
});

test('alert texts jump the normal lane; trackerId may be a function', async (t) => {
  const { bot, mock } = await setup(t, { minIntervalMs: 100, trackerId: () => TID });
  const tests = [bot.sendTest('1001'), bot.sendTest('1001'), bot.sendTest('1001')];
  const now = Math.floor(Date.now() / 1000);
  await bot.onAlert({ id: 21, t: now, tracker_id: TID, kind: 'out_confirmed', severity: 'critical', title: 'OUT', body: '', data: {}, incident: 1 }, 'open');
  await Promise.all(tests);
  const texts = await textsTo(mock, 1001);
  const i = texts.findIndex((x) => x.startsWith('🚨 <b>OUT</b>'));
  assert.ok(i >= 0 && i <= 1, JSON.stringify(texts));
  await say(mock, 1001, '/where');
  await until(async () => (await sent(mock)).some((s) => s.method === 'sendVenue'));
});

const crit = (id) => ({ id, t: Math.floor(Date.now() / 1000), tracker_id: TID, kind: 'out_confirmed', severity: 'critical', title: 'OUT', body: '', data: {}, incident: 1, sent_count: 0 });
const failOnce = (mock, method, rule) => mock.post('/__mock/fail', { match: `POST /telegram/bot${TOKEN}/${method}`, times: 1, ...rule });
const alertsTo = async (mock, chatId) => (await textsTo(mock, chatId)).filter((x) => x.startsWith('🚨 <b>OUT</b>'));

test('a hung call is aborted and an alert is retried; a 502 then 200 delivers the alert once; send failures set lastError', async (t) => {
  const mock = await startMock();
  const { bot, store } = await setup(t, { mock, callTimeoutMs: 300 });
  await failOnce(mock, 'sendMessage', { hang: true });
  const t0 = Date.now();
  await bot.onAlert(crit(41), 'open');
  await bot.idle();
  assert.ok(Date.now() - t0 < 5000, String(Date.now() - t0));
  assert.equal((await alertsTo(mock, 1001)).length, 1);
  assert.equal(store.alertMessages(41).length, 1);
  await failOnce(mock, 'sendMessage', { status: 502, body: { ok: false, error_code: 502, description: 'Bad Gateway' } });
  await bot.onAlert(crit(42), 'open');
  await bot.idle();
  assert.equal((await alertsTo(mock, 1001)).length, 2);
  assert.equal(store.alertMessages(42).length, 1);
  await failOnce(mock, 'sendMessage', { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' } });
  await say(mock, 1001, '/help');
  await until(() => bot.status().lastError);
  assert.match(bot.status().lastError, /kicked/);
});

test('a chat removed during a chase gets no more live edits and a queued alert is not sent to it', async (t) => {
  const { mock, monitor, bot, store } = await setup(t, { chatIds: ['1001', '1002'] });
  const p0 = ll(30, 0), p1 = ll(40, 0);
  monitor.chase = { since: Math.floor(Date.now() / 1000), incidentId: 1, messages: {} }; // the monitor stores the chase before it emits
  await bot.onChase({ active: true, since: monitor.chase.since, incidentId: 1, position: { lat: p0.lat, lng: p0.lng, acc: 8 } });
  await bot.idle();
  assert.equal(Object.keys(monitor.chase.messages).length, 2);
  store.deleteChat('1002');
  bot.onChasePosition({ lat: p1.lat, lng: p1.lng, acc: 6, t: 1 });
  await new Promise((r) => setTimeout(r, 400));
  await bot.idle();
  const edits = (await sent(mock)).filter((x) => x.method === 'editMessageLiveLocation');
  assert.deepEqual(edits.map((x) => String(x.body.chat_id)), ['1001']);
  assert.deepEqual(Object.keys(monitor.chase.messages), ['1001']);
  // an alert queued behind another message re-checks approval when its turn comes
  const tests = bot.sendTest('1001');
  const alert = bot.onAlert(crit(43), 'open');
  store.deleteChat('1001');
  await Promise.all([tests, alert]);
  await bot.idle();
  assert.equal((await alertsTo(mock, 1001)).length, 0);
});

test('a repeat reaches an eligible chat whose first alert send failed, as a fresh message', async (t) => {
  const { mock, bot, store } = await setup(t);
  await failOnce(mock, 'sendMessage', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: something' } });
  await bot.onAlert(crit(44), 'open');
  await bot.idle();
  assert.equal(store.alertMessages(44).length, 0);
  await bot.onRepeat({ ...crit(44), sent_count: 1 });
  await bot.idle();
  const repeats = (await sent(mock)).filter((x) => x.method === 'sendMessage' && /^🔁 Repeat 1\/10/.test(x.body.text));
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].body.reply_parameters, undefined);
  assert.equal(store.alertMessages(44).length, 1);
});

test('after a failed first poll, the first successful batch is still the backlog', async (t) => {
  const mock = await startMock();
  await failOnce(mock, 'getUpdates', { status: 500 });
  const date = Math.floor(Date.now() / 1000);
  await mock.post('/__mock/telegram/update', { update: { callback_query: { id: 'old', from: { id: 1001 }, data: 'buzz:on', message: { message_id: 5, date: date - 600, chat: { id: 1001, type: 'private' } } } } });
  const { monitor, bot } = await setup(t, { mock, backoffMinMs: 2100, backoffMaxMs: 2100 });
  await until(() => bot.status().handled >= 1, { timeout: 5000 });
  await bot.idle();
  assert.equal(monitor.calls.some((c) => c[0] === 'command'), false);
  assert.deepEqual((await sent(mock)).filter((x) => x.method === 'answerCallbackQuery').map((x) => x.body.text), ['Ignored a button press from before a restart. Press it again.']);
});

test('a chat whose first live location failed gets a new one on the next chase fix', async (t) => {
  const mock = await startMock();
  const { monitor, bot } = await setup(t, { mock });
  await failOnce(mock, 'sendLocation', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: something' } });
  const p0 = ll(30, 0), p1 = ll(40, 0);
  monitor.chase = { since: Math.floor(Date.now() / 1000), incidentId: 1, messages: {} }; // the monitor stores the chase before it emits
  await bot.onChase({ active: true, since: monitor.chase.since, incidentId: 1, position: { lat: p0.lat, lng: p0.lng, acc: 8 } });
  await bot.idle();
  assert.equal(monitor.chase?.messages?.['1001'], undefined);
  bot.onChasePosition({ lat: p1.lat, lng: p1.lng, acc: 6, t: 1 });
  bot.onChasePosition({ lat: p1.lat, lng: p1.lng, acc: 6, t: 2 });
  await until(() => monitor.chase?.messages?.['1001'] != null);
  await bot.idle();
  const lives = (await sent(mock)).filter((x) => x.method === 'sendLocation' && x.body.live_period === 86400);
  assert.equal(lives.length, 1);
  assert.equal(lives[0].body.latitude, p1.lat);
});

test('a queued /where reply is dropped when the chat is removed before its turn', async (t) => {
  const { mock, bot, store } = await setup(t, { minIntervalMs: 300 });
  const pending = bot.sendTest('1001');
  await say(mock, 1001, '/where');
  await until(() => bot.status().handled >= 1);
  store.deleteChat('1001');
  await pending;
  await bot.idle();
  const s = (await sent(mock)).filter((x) => String(x.body.chat_id) === '1001');
  assert.deepEqual(s.map((x) => x.method), ['sendMessage']);
  assert.equal(s[0].body.text, 'Test message from OpenTractive. Alerts will look like this.');
});

test('the backlog spans every getUpdates page until an empty one', async (t) => {
  const mock = await startMock();
  const date = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 130; i++) {
    await mock.post('/__mock/telegram/update', { update: { callback_query: { id: `old${i}`, from: { id: 1001 }, data: 'buzz:on', message: { message_id: 5, date: date - 600, chat: { id: 1001, type: 'private' } } } } });
  }
  const { monitor, bot } = await setup(t, { mock });
  await until(() => bot.status().handled >= 130, { timeout: 5000 });
  await bot.idle();
  const polls = (await mock.get('/__mock/requests?host=telegram')).filter((r) => r.path.endsWith('/getUpdates'));
  assert.deepEqual(polls.slice(0, 3).map((r) => r.body.timeout), [0, 0, 0]);
  assert.equal(monitor.calls.some((c) => c[0] === 'command'), false);
  const answers = (await sent(mock)).filter((x) => x.method === 'answerCallbackQuery');
  assert.equal(answers.length, 130);
  assert.ok(answers.every((x) => x.body.text === 'Ignored a button press from before a restart. Press it again.'));
});

test('a response that sends its headers and then hangs is a transient failure: the alert is retried', async (t) => {
  const { mock, bot, store } = await setup(t, { callTimeoutMs: 300 });
  await failOnce(mock, 'sendMessage', { status: 200, headersThenHang: true });
  await bot.onAlert(crit(45), 'open');
  await bot.idle();
  assert.equal((await alertsTo(mock, 1001)).length, 1);
  assert.equal(store.alertMessages(45).length, 1);
});

test('a live location that lands after its chase ended or changed is stopped, never attached to the next chase', async (t) => {
  const { mock, monitor, bot } = await setup(t, { minIntervalMs: 300 });
  const p0 = ll(30, 0);
  const since = Math.floor(Date.now() / 1000);
  const lives = async () => (await sent(mock)).filter((x) => x.method === 'sendLocation' && x.body.live_period === 86400);
  const stops = async () => (await sent(mock)).filter((x) => x.method === 'stopMessageLiveLocation').map((x) => x.body.message_id);
  // the chase ends while its live location waits behind a test message
  monitor.chase = { since, incidentId: 1, messages: {} };
  const busy = bot.sendTest('1001');
  const start = bot.onChase({ active: true, since, incidentId: 1, position: { lat: p0.lat, lng: p0.lng, acc: 8 } });
  monitor.chase = null;
  await Promise.all([busy, start]);
  await bot.idle();
  assert.deepEqual(await stops(), [(await lives())[0].result.message_id]);
  // a new chase began while the old one's send was pending
  monitor.chase = { since, incidentId: 2, messages: {} };
  const busy2 = bot.sendTest('1001');
  const start2 = bot.onChase({ active: true, since, incidentId: 2, position: { lat: p0.lat, lng: p0.lng, acc: 8 } });
  monitor.chase = { since: since + 5, incidentId: 3, messages: {} };
  await Promise.all([busy2, start2]);
  await bot.idle();
  assert.deepEqual(monitor.chase.messages, {});
  assert.equal((await stops()).length, 2);
  assert.equal((await stops())[1], (await lives())[1].result.message_id);
});

test('/chase on during walk mode answers with the refusal', async (t) => {
  const { mock, monitor, bot } = await setup(t);
  const base = monitor.status();
  monitor.status = () => ({ ...base, walk: { until: Math.floor(Date.now() / 1000) + 3600 } });
  await say(mock, 1001, '/chase on');
  await until(() => bot.status().handled >= 1);
  await bot.idle();
  const [text] = await textsTo(mock, 1001);
  assert.doesNotMatch(text, /Chase started/);
  assert.match(text, /walk mode/i);
});

test('/zone lists the Wi-Fi zones and switches the ones covering the yard, or one by name', async (t) => {
  const zones = [{ id: 'z1', name: 'Home', off: false }, { id: 'z2', name: 'Shed', off: false }];
  const calls = [];
  const zoneSwitch = {
    status: () => zones.map((z) => ({ ...z })),
    switchZone: async (id, on, actor) => { calls.push([id, on, actor]); const z = zones.find((x) => x.id === id); z.off = !on; z.offAt = on ? null : 1_790_000_000; return { ...z }; },
  };
  const { mock, monitor, bot } = await setup(t, { zoneSwitch: () => zoneSwitch });
  monitor.pszFlags = () => [{ id: 'z1', coversYard: true }, { id: 'z2', coversYard: false }];
  await say(mock, 1001, '/zone');
  await say(mock, 1001, '/zone off');
  await say(mock, 1001, '/zone off shed');
  await say(mock, 1001, '/zone on');
  await say(mock, 1001, '/zone maybe');
  await until(() => bot.status().handled >= 5, { timeout: 5000 });
  await bot.idle();
  const texts = await textsTo(mock, 1001);
  assert.ok(texts.some((x) => x.includes('📶 <b>Wi-Fi zones</b>\nHome: on\nShed: on'))); // bare /zone: the panel at its zone switches
  assert.ok(texts.some((x) => x.includes('Home: off since') && x.includes('waiting for the tracker to move')));
  assert.ok(texts.some((x) => x.includes('Usage: /zone')));
  assert.deepEqual(calls, [['z1', false, 'telegram:1001'], ['z2', false, 'telegram:1001'], ['z1', true, 'telegram:1001'], ['z2', true, 'telegram:1001']]);
});

test('/locate without Tractive position requests switches the Wi-Fi zone off until the first GPS fix', async (t) => {
  const calls = [];
  const zoneSwitch = { status: () => [], locate: async (actor) => { calls.push(actor); return { since: 1_790_000_000, until: 1_790_007_200, zones: ['z1'] }; } };
  const { mock, monitor, bot } = await setup(t, { posRequestAllowed: () => false, zoneSwitch: () => zoneSwitch });
  await say(mock, 1001, '/locate');
  await until(() => bot.status().handled >= 1, { timeout: 5000 });
  await bot.idle();
  assert.deepEqual(calls, ['telegram:1001']);
  assert.ok((await textsTo(mock, 1001)).some((x) => x.startsWith('Locating: the Wi-Fi zone is off until the first GPS fix')));
  assert.ok(!monitor.calls.some((c) => c[0] === 'command'));
});

const press = (mock, chatId, data, message = {}, from = { id: 5, first_name: 'Ana' }) => mock.post('/__mock/telegram/update', { update: { callback_query: {
  id: `cb${Math.random()}`, from, data, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: 'group' }, ...message } } } });
const lastTo = async (mock, method, chatId) => (await sent(mock)).filter((x) => x.method === method && String(x.body.chat_id) === String(chatId)).at(-1);

test('the command menu is registered at start', async (t) => {
  const { mock } = await setup(t);
  await until(async () => (await sent(mock)).some((x) => x.method === 'setMyCommands'));
  const cmds = (await sent(mock)).find((x) => x.method === 'setMyCommands').body.commands;
  assert.ok(['panel', 'status', 'locate', 'zone', 'pin', 'help'].every((c) => cmds.some((x) => x.command === c && x.description)));
});

test('panel: one HTML card with buttons; menus swap only the keyboard, actions run in place and show who and what', async (t) => {
  const { mock, bot, store, monitor, logs } = await setup(t);
  await say(mock, 1001, '/panel');
  await until(async () => await lastTo(mock, 'sendMessage', 1001));
  const panel = await lastTo(mock, 'sendMessage', 1001);
  const id = panel.result.message_id;
  assert.equal(panel.body.parse_mode, 'HTML');
  assert.match(panel.body.text, /^🟢 <b>Rex<\/b> · In the yard\n🔋 77 %/);
  const data = panel.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? b.url);
  assert.deepEqual(data, ['p:where', 'p:locate', 'p:refresh', 'p:live:on', 'p:chase:on', 'p:watch:on', 'p:v:walk', 'p:v:mute', 'p:v:light', 'p:v:buzz', 'http://app.example/#/']);
  const edits = async () => (await sent(mock)).filter((x) => x.method === 'editMessageText' && x.body.message_id === id);
  await press(mock, 1001, 'p:v:mute', { message_id: id });
  await until(async () => (await edits()).length === 1);
  const menu = (await edits())[0].body;
  assert.equal(menu.text, panel.body.text); // only the keyboard changed
  assert.ok(menu.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'p:mute:all:60'));
  await press(mock, 1001, 'p:mute:30', { message_id: id }, { id: 6, first_name: 'Bob' });
  await until(async () => (await edits()).length === 2);
  const after = (await edits())[1].body;
  assert.ok(store.chat('1001').muted_until > Date.now() / 1000);
  assert.match(after.text, /🔕 Info and warning alerts muted until \d\d:\d\d/);
  assert.match(after.text, /<i>Info and warning alerts muted for 30 min\. Critical alerts still come through\. · Bob · \d\d:\d\d<\/i>$/);
  assert.ok(after.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'p:locate')); // back on the main view
  await press(mock, 1001, 'p:led:on', { message_id: id });
  await until(() => monitor.calls.some((c) => c[0] === 'command' && c[3] === 'led_control' && c[4] === true));
  await press(mock, 1001, 'p:refresh', { message_id: id }); // nothing changed: Telegram says "not modified", which is fine
  await until(() => bot.status().handled >= 5);
  await bot.idle();
  assert.ok(!logs.some((l) => /not modified/.test(l)), logs.join('\n'));
  assert.ok(store.commands(100).some((c) => c.action === 'telegram:mute' && c.ok === 1));
});

test('bare /mute, /led, /buzz and /zone open the panel at their buttons; /walk alone still means 120 min', async (t) => {
  const { mock, bot, monitor } = await setup(t);
  for (const c of ['/mute', '/led', '/buzz', '/walk']) await say(mock, 1001, c);
  await until(() => bot.status().handled >= 4);
  await bot.idle();
  const kbs = (await sent(mock)).filter((x) => x.method === 'sendMessage' && x.body.reply_markup).map((x) => x.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data));
  assert.ok(kbs[0].includes('p:unmute'));
  assert.ok(kbs[1].includes('p:led:off'));
  assert.ok(kbs[2].includes('p:buzz:on') && (await textsTo(mock, 1001))[2].includes('The buzzer is loud'));
  assert.ok(monitor.calls.some((c) => c[0] === 'setWalk' && c[1] === 120));
});

test('alert buttons: the card records who handled it and keeps its formatting; a later press never rewrites it', async (t) => {
  const { mock, bot, store } = await setup(t);
  const id = store.insertAlert({ t: Math.floor(Date.now() / 1000), tracker_id: TID, kind: 'out_confirmed', severity: 'critical', title: 'OUT', incident: 1 });
  const msg = { message_id: 77, text: '🚨 OUT\nDog 😀 out\n2026-11-21 11:00', entities: [{ type: 'bold', offset: 3, length: 3 }, { type: 'italic', offset: 17, length: 16 }] };
  await press(mock, 1001, `ack:${id}`, msg);
  await until(async () => await lastTo(mock, 'editMessageText', 1001));
  const e = (await lastTo(mock, 'editMessageText', 1001)).body;
  assert.match(e.text, /^🚨 OUT\nDog 😀 out\n2026-11-21 11:00\n\n✅ Got it · Ana · \d\d:\d\d$/);
  assert.deepEqual(e.entities, msg.entities);
  assert.equal(e.parse_mode, undefined);
  assert.deepEqual(e.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data).map((b) => b.callback_data), ['live:on', 'buzz:on', 'where']);
  // a second member pressed Got it on the same card before the first edit landed: its stale snapshot must not replace "Got it · Ana"
  store.updateAlert(id, { acked_at: 1, acked_by: 'telegram:1001' });
  await press(mock, 1001, `ack:${id}`, msg, { id: 6, first_name: 'Bob' });
  await press(mock, 1001, 'false:999', { ...msg, message_id: 79 }); // fake monitor: falseAlarm returns a row, so this one is "closed"
  await until(() => bot.status().handled >= 3);
  await bot.idle();
  const all = (await sent(mock)).filter((x) => x.method === 'editMessageText');
  assert.deepEqual(all.filter((x) => x.body.message_id === 77).map((x) => x.body.text.split('\n').at(-1).replace(/\d\d:\d\d/, 'T')), ['✅ Got it · Ana · T']);
  assert.ok((await sent(mock)).some((x) => x.method === 'editMessageReplyMarkup' && x.body.message_id === 77));
  assert.match(all.find((x) => x.body.message_id === 79).body.text, /🙅 False alarm · Ana/);
});

test('/pin pins a panel that refreshes itself when the state changes; other panels do not; no pin right is explained', async (t) => {
  const { mock, bot, live, store } = await setup(t, { chatIds: ['1001', '-9999'], panelEveryMs: 150 });
  await say(mock, 1001, '/pin');
  await until(async () => (await sent(mock)).some((x) => x.method === 'pinChatMessage'));
  const pin = (await sent(mock)).find((x) => x.method === 'pinChatMessage').body;
  assert.equal(pin.disable_notification, true);
  await say(mock, 1001, '/panel');
  await until(() => bot.status().handled >= 2);
  await bot.idle();
  const [pinned, other] = (await sent(mock)).filter((x) => x.method === 'sendMessage' && String(x.body.chat_id) === '1001').map((x) => x.result.message_id);
  assert.equal(pin.message_id, pinned);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await sent(mock)).filter((x) => x.method === 'editMessageText').length, 0); // unchanged state: no edits
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, hardware: { time: Math.floor(Date.now() / 1000), battery_level: 55 } });
  await until(async () => (await sent(mock)).some((x) => x.method === 'editMessageText'));
  await new Promise((r) => setTimeout(r, 400));
  const edits = (await sent(mock)).filter((x) => x.method === 'editMessageText');
  assert.deepEqual(edits.map((x) => x.body.message_id), [pinned]);
  assert.match(edits[0].body.text, /🔋 55 %/);
  assert.ok(!edits.some((x) => x.body.message_id === other));
  await mock.post('/__mock/telegram/update', { update: { message: { message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: -9999, type: 'group', title: 'G' }, from: { id: 5, first_name: 'Ana' }, text: '/pin' } } });
  await until(async () => (await textsTo(mock, -9999)).some((x) => x.startsWith('Could not pin it')));
  assert.match((await textsTo(mock, -9999)).at(-1), /admin with the right to pin messages/);
  store.deleteChat('1001'); // a removed chat's panels are forgotten
  await until(() => !(store.getKv('telegramPanels') ?? {})['1001']);
});

test('a slow command holds up only its own chat, and button presses are answered at once', async (t) => {
  const { mock, bot, monitor } = await setup(t, { chatIds: ['1001', '1002'] });
  let release;
  const gate = new Promise((r) => { release = r; });
  monitor.command = (...args) => { monitor.calls.push(['command', ...args]); return gate; };
  try {
    await say(mock, 1001, '/led on');
    await until(() => monitor.calls.some((c) => c[0] === 'command'));
    await press(mock, 1001, 'p:refresh');
    await say(mock, 1002, '/help');
    await until(async () => (await textsTo(mock, 1002)).length === 1);
    await until(async () => (await sent(mock)).some((x) => x.method === 'answerCallbackQuery'));
    assert.equal((await textsTo(mock, 1001)).length, 0); // still waiting for Tractive
    assert.ok(!(await sent(mock)).some((x) => x.method === 'editMessageText')); // the press runs after the command, in order
  } finally {
    release({ active: true }); // never leave the bot stuck on a failure
  }
  await until(async () => (await textsTo(mock, 1001)).includes('Light on requested.'));
  await until(() => bot.status().handled >= 3);
  await until(async () => (await sent(mock)).some((x) => x.method === 'editMessageText'));
});

test('stop lets accepted commands finish before it closes', async (t) => {
  const { mock, bot, monitor } = await setup(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  monitor.command = (...args) => { monitor.calls.push(['command', ...args]); return gate; };
  await say(mock, 1001, '/led on');
  await say(mock, 1001, '/walk 30');
  await until(() => monitor.calls.some((c) => c[0] === 'command'));
  await until(async () => (await mock.get('/__mock/requests?host=telegram')).some((r) => r.path.endsWith('/getUpdates') && r.body?.offset >= 3));
  const stopping = bot.stop();
  setTimeout(() => release({ active: true }), 200);
  await stopping;
  assert.ok(monitor.calls.some((c) => c[0] === 'setWalk' && c[1] === 30), 'the queued /walk ran before stop returned');
  assert.ok((await textsTo(mock, 1001)).includes('Light on requested.'));
});

test('in a forum group the answer goes to the asking topic, as a reply', async (t) => {
  const { mock, bot } = await setup(t, { chatIds: ['-100777'] });
  await mock.post('/__mock/telegram/update', { update: { message: { message_id: 42, date: Math.floor(Date.now() / 1000), is_topic_message: true, message_thread_id: 7,
    chat: { id: -100777, type: 'supergroup', title: 'F', is_forum: true }, from: { id: 5, first_name: 'Ana' }, text: '/help' } } });
  await until(() => bot.status().handled >= 1);
  await bot.idle();
  const m = await lastTo(mock, 'sendMessage', -100777);
  assert.equal(m.body.message_thread_id, 7);
  assert.deepEqual(m.body.reply_parameters, { message_id: 42, allow_sending_without_reply: true });
  for (const d of ['p:where', 'where']) await press(mock, -100777, d, { is_topic_message: true, message_thread_id: 7 }); // buttons too
  await until(() => bot.status().handled >= 3);
  await bot.idle();
  const venues = (await sent(mock)).filter((x) => x.method === 'sendVenue');
  assert.deepEqual(venues.map((x) => x.body.message_thread_id), [7, 7]);
});
