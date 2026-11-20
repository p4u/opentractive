// App wiring: recompute on a truncated read, dropped positions, startup without Tractive, tracker refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../src/store.js';
import { DEFAULT_SETTINGS } from '../src/monitor.js';
import { createApp } from '../src/app.js';
import { startMock } from './mock/server.js';
import { envFor, tmpDir, until, fakeClock, ll, square, asPair, TID, IDS } from './helpers.js';

const BOT = '123456:TEST-TOKEN-abc';
const YARD = { _id: IDS.yard, name: 'Yard', shape: 'POLYGON', coords: square(20).map(asPair), fence_type: 'SAFE', active: true, home_flag: true };
const OPTS = { tractiveOptions: { minGapMs: 0, penaltyBaseMs: 20, penaltyMaxMs: 100, random: () => 0.5 }, telegramOptions: { pollTimeoutS: 1, minIntervalMs: 20 } };

function offline(t, { log = () => {}, now } = {}) {
  const dir = tmpDir('app');
  const store = new Store(':memory:');
  const app = createApp({ env: envFor({ url: 'http://127.0.0.1:9' }), store, dataDir: dir, log, ...(now && { now }), ...OPTS });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { app, store };
}

async function online(t, { store = new Store(':memory:'), env = {}, now, before = async () => {} } = {}) {
  const mock = await startMock({ keepAliveMs: 200 });
  await before(mock);
  const dir = tmpDir('app');
  const app = createApp({ env: envFor(mock, env), store, dataDir: dir, log: () => {}, ...(now && { now }), ...OPTS });
  t.after(async () => { await app.stop(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, store, mock };
}

test('recompute refuses to reconcile when the position read is truncated', (t) => {
  const { app, store } = offline(t);
  store.setRaw(`geofences:${TID}`, [YARD]);
  app.followedId = TID;
  const now = Math.floor(Date.now() / 1000), t0 = now - 10 * 86400, inside = ll(0, 0), out = ll(60, 0);
  const ins = store.db.prepare('INSERT INTO positions(tracker_id,t,lat,lng,acc,sensor) VALUES(?,?,?,?,?,?)');
  store.tx(() => {
    for (let i = 0; i < 200_001; i++) ins.run(TID, t0 + i, inside.lat, inside.lng, 5, 'GPS');
    const te = t0 + 300_000; // a real escape after the first 200 000 rows
    ins.run(TID, te, inside.lat, inside.lng, 5, 'GPS');
    ins.run(TID, te + 3, out.lat, out.lng, 5, 'GPS');
    ins.run(TID, te + 6, out.lat, out.lng, 5, 'GPS');
  });
  store.insertEscape({ tracker_id: TID, t_inside: t0 + 300_000, t_outside: t0 + 300_003 });
  assert.deepEqual(app.recompute({ trackerId: TID, from: t0, to: now }), { inserted: 0, deleted: 0, truncated: true });
  assert.equal(store.escapes(TID, t0, now).length, 1);
});

test('F10: dropped positions are logged, except the ones that are not newer', (t) => {
  const logs = [];
  const { app } = offline(t, { log: (m) => logs.push(m) });
  const s = Math.floor(Date.now() / 1000), p = ll(0, 0);
  app.live.applyStatus({ tracker_id: TID, position: { time: 'soon', latlong: [p.lat, p.lng] } });
  app.live.applyStatus({ tracker_id: TID, position: { time: s, latlong: [p.lat, p.lng] } });
  app.live.applyStatus({ tracker_id: TID, position: { time: s - 10, latlong: [p.lat, p.lng] } });
  assert.deepEqual(logs.filter((m) => m.includes('dropped')), [`position dropped for ${TID}: invalid position`]);
});

test('after a restart with an open critical incident and a failing Tractive login, Telegram polls and repeats go on', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new Store(':memory:');
  const clock = fakeClock(Date.now());
  const id = store.insertAlert({ t: clock.s() - 600, tracker_id: TID, kind: 'out_confirmed', severity: 'critical', title: 'OUT of the yard', incident: 1 });
  store.updateAlert(id, { last_sent_at: clock.s() - 300, sent_count: 2 });
  const { app, mock } = await online(t, {
    store, now: clock.now, env: { TELEGRAM_BOT_TOKEN: BOT },
    before: (m) => m.post('/__mock/fail', { match: 'POST /graph/4/auth/token', status: 401 }),
  });
  const repeats = [];
  app.monitor.on('repeat', (row) => repeats.push(row.id));
  await app.start();
  assert.equal(app.tractive.status().login, 'bad-credentials');
  t.mock.timers.tick(10_000);
  await until(() => repeats.length === 1, { what: 'a repeat' });
  assert.deepEqual(repeats, [id]);
  assert.equal(store.alert(id).sent_count, 3);
  await until(async () => (await mock.get('/__mock/requests?host=telegram')).some((r) => r.path.endsWith('/getUpdates')), { what: 'telegram polling' });
});

test('F11: the 15-minute tracker refresh goes on past a failing tracker', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { app, mock } = await online(t);
  await app.start();
  await app.ready;
  const hits = async () => (await mock.get('/__mock/requests?host=graph')).filter((r) => r.method === 'GET' && r.path === `/graph/4/tracker/${TID}`).length;
  const before = await hits();
  await mock.post('/__mock/fail', { match: 'GET /graph/4/tracker/TRK00002', status: 404 });
  app.trackerIds = ['TRK00002', TID]; // the real account lists a secondary tracker first
  t.mock.timers.tick(15 * 60_000);
  await until(async () => (await hits()) > before, { what: 'the followed tracker refresh' });
});

// ---- more app wiring ----

const ZONES = JSON.parse(fs.readFileSync(new URL('./mock/fixtures/power-saving-zone.json', import.meta.url)));
const FENCES = JSON.parse(fs.readFileSync(new URL('./mock/fixtures/geofences-bulk.json', import.meta.url)));

test('S2: a return home seen only as a zone entry splits two escapes, and recompute keeps both', async (t) => {
  const clock = fakeClock(Date.now());
  const { app, store } = offline(t, { now: clock.now });
  store.setRaw(`geofences:${TID}`, [YARD]);
  store.setRaw(`psz:${TID}`, ZONES);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.chase.auto = false; // no Tractive commands offline
  store.setKv('settings', settings);
  app.followedId = TID;
  app.monitor.start();
  t.after(() => app.monitor.stop());
  const t0 = clock.s();
  const fix = (x, y) => {
    clock.advance(3000);
    const p = ll(x, y);
    app.live.applyStatus({ tracker_id: TID, power_saving_zone_id: null, tracker_state_reason: null,
      position: { time: clock.s(), latlong: [p.lat, p.lng], sensor_used: 'GPS', accuracy: 5 } });
  };
  fix(0, 0);
  fix(60, 0);
  fix(65, 0);
  clock.advance(60_000);
  app.live.applyStatus({ tracker_id: TID, power_saving_zone_id: IDS.pszIn, tracker_state_reason: 'POWER_SAVING' }); // no position
  await app.monitor.idle();
  assert.equal(store.openIncident(TID), null);
  clock.advance(3600_000);
  app.live.applyStatus({ tracker_id: TID, power_saving_zone_id: null, tracker_state_reason: null });
  fix(80, 0);
  fix(90, 0);
  await app.monitor.idle();
  const stored = store.escapes(TID, t0, clock.s());
  assert.equal(stored.length, 2);
  assert.deepEqual(app.recompute({ trackerId: TID, from: t0, to: clock.s() }), { inserted: 0, deleted: 0 });
  assert.deepEqual(store.escapes(TID, t0, clock.s()).map((e) => e.t_outside), stored.map((e) => e.t_outside));
});

test('S3: after a restart already inside a home zone with no fresh position, the open incident closes and the chase ends', async (t) => {
  const store = new Store(':memory:');
  store.setRaw(`geofences:${TID}`, FENCES);
  store.setRaw(`psz:${TID}`, ZONES);
  const s = Math.floor(Date.now() / 1000);
  const id = store.insertAlert({ t: s - 600, tracker_id: TID, kind: 'left_psz', severity: 'critical', title: 'Left Wi-Fi zone Kitchen', incident: 1 });
  store.updateAlert(id, { last_sent_at: s - 600 });
  store.setKv('chase', { since: s - 600, incidentId: id, messages: {}, distanceM: 0, last: null });
  const { app } = await online(t, {
    store,
    before: (m) => m.post('/__mock/tracker', { patch: {
      power_saving_zone_id: IDS.pszIn, tracker_state_reason: 'POWER_SAVING', position: { time: s - 3 * 3600, power_saving_zone_id: IDS.pszIn },
    } }),
  });
  await app.start();
  await app.ready;
  await until(() => store.alert(id).closed_at != null, { what: 'the incident to close' });
  assert.equal(store.alert(id).closed_by, 'home');
  assert.equal(store.getKv('chase'), null);
});
