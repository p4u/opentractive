import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { LiveState } from '../src/state.js';
import { createMonitor, validateSettings, DEFAULT_SETTINGS, RULE_KINDS, liveDecision, inWindow, yardWatchStatus, flattenPaths } from '../src/monitor.js';
import { ll, square, asPair, fakeClock, TID, IDS } from './helpers.js';

const YARD = { _id: IDS.yard, _type: 'geofence', _version: 'v1', name: 'Yard', shape: 'POLYGON', coords: square(20).map(asPair), radius: null, fence_type: 'SAFE', active: true, home_flag: true, icon: 'TRACTIVE' };
const PSZ_IN = { _id: IDS.pszIn, _type: 'power_saving_zone', name: 'Kitchen', zone_id: 'wifi-1', source: 'WIFI', latlong: asPair(ll(-5, 5)) };
const PSZ_OUT = { _id: IDS.pszOut, _type: 'power_saving_zone', name: 'Neighbour', zone_id: 'wifi-2', source: 'WIFI', latlong: asPair(ll(0, 150)) };
const clone = (o) => structuredClone(o);
const FULL_DAY = [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:59' }];

function status(h, patch) { h.live.applyStatus({ message: 'tracker_status', tracker_id: TID, ...patch }); }
function setup({ battery = 80, settings, store = new Store(':memory:'), clock = fakeClock(), fail = 0 } = {}) {
  if (!store.getRaw(`geofences:${TID}`)) {
    store.setRaw(`geofences:${TID}`, [YARD]);
    store.setRaw(`psz:${TID}`, [PSZ_IN, PSZ_OUT]);
  }
  if (settings) store.setKv('settings', settings);
  const live = new LiveState({ now: clock.now });
  const sent = [];
  let failures = fail;
  const sendCommand = async (id, name, on) => {
    sent.push({ name, on, at: clock.now() });
    if (failures > 0) { failures--; throw Object.assign(new Error('Tractive said no'), { status: 500 }); }
    return { active: on, pending: true, remaining: 0, timeout: 300 };
  };
  const mon = createMonitor({ store, live, trackerId: TID, sendCommand, now: clock.now, tz: 'Europe/Madrid' });
  const events = [];
  for (const e of ['alert', 'repeat', 'chase', 'chase-position', 'command']) mon.on(e, (...a) => events.push([e, ...a]));
  const h = { clock, store, live, mon, sent, events };
  status(h, { tracker_state: 'OPERATIONAL', tracker_state_reason: null, charging_state: 'NOT_CHARGING', battery_state: 'REGULAR', power_saving_zone_id: null,
    hardware: { time: clock.s(), battery_level: battery, power_saving_zone_id: null }, live_tracking: { active: false, pending: false, remaining: 0, timeout: 300 } });
  mon.start();
  return h;
}
async function gps(h, x, y, { acc = 5, dt = 3000 } = {}) {
  h.clock.advance(dt);
  const p = ll(x, y);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null, position: { time: h.clock.s(), latlong: [p.lat, p.lng], sensor_used: 'GPS', accuracy: acc } });
  await h.mon.idle();
}
async function wifi(h, zone, { dt = 3000 } = {}) {
  h.clock.advance(dt);
  status(h, { power_saving_zone_id: zone._id, tracker_state_reason: 'POWER_SAVING', position: { time: h.clock.s(), latlong: zone.latlong, sensor_used: 'KNOWN_WIFI', accuracy: 30, power_saving_zone_id: zone._id } });
  await h.mon.idle();
}
async function tick(h, ms) { h.clock.advance(ms); await h.mon.tick(); }
const ev = (h, name = 'alert') => h.events.filter((e) => e[0] === name);
const incidents = (h) => h.store.alerts({ limit: 100 }).filter((a) => a.incident === 1);
const repeatsOf = (h, id) => ev(h, 'repeat').filter((e) => e[1].id === id).length;
const kinds = (h, kind) => h.store.alerts({ limit: 200 }).filter((a) => a.kind === kind);
async function openCritical(h) { await gps(h, 0, 0); await gps(h, 60, 0); return h.store.openIncident(TID); }

test('settings: defaults valid; unknown keys, ranges and cross-field rules rejected with dotted paths', () => {
  assert.deepEqual(validateSettings(clone(DEFAULT_SETTINGS)), { settings: DEFAULT_SETTINGS });
  const bad = (patch, field) => {
    const s = clone(DEFAULT_SETTINGS);
    patch(s);
    const r = validateSettings(s);
    assert.ok(r.errors, `expected errors for ${field}`);
    assert.ok(Object.keys(r.errors).includes(field), `${field} not in ${Object.keys(r.errors)}`);
  };
  bad((s) => { s.extra = 1; }, 'extra');
  bad((s) => { s.thresholds.bogus = 1; }, 'thresholds.bogus');
  bad((s) => { s.v = 2; }, 'v');
  bad((s) => { s.yardGeofenceId = 'nope'; }, 'yardGeofenceId');
  bad((s) => { s.thresholds.batteryCritical = 30; }, 'thresholds.batteryCritical');
  bad((s) => { s.thresholds.repeatMin = 0; }, 'thresholds.repeatMin');
  bad((s) => { s.rules.out_possible.severity = 'loud'; }, 'rules.out_possible.severity');
  bad((s) => { delete s.rules.back_home; }, 'rules.back_home');
  bad((s) => { s.yardWatch.windows[0].from = '25:00'; }, 'yardWatch.windows.0.from');
  bad((s) => { s.yardWatch.windows[0].days = [0]; }, 'yardWatch.windows.0.days');
  bad((s) => { s.yardWatch.resumeBattery = 30; }, 'yardWatch.resumeBattery');
  bad((s) => { s.yardWatch.mode = 'always'; }, 'yardWatch.mode');
  bad((s) => { s.pszCoversYard = { nothex: true }; }, 'pszCoversYard.nothex');
  bad((s) => { s.chase.maxHours = 48; }, 'chase.maxHours');
  const ok = clone(DEFAULT_SETTINGS);
  ok.yardGeofenceId = IDS.yard;
  ok.pszCoversYard = { [IDS.pszIn]: false };
  assert.deepEqual(validateSettings(ok).settings, ok);
  assert.deepEqual([...RULE_KINDS].sort(), Object.keys(DEFAULT_SETTINGS.rules).sort());
  assert.equal(RULE_KINDS.length, 14);
});

test('yard: default is the active SAFE fence named Yard; an unknown selection turns the out rules off', async () => {
  const h = setup();
  assert.equal(h.mon.yard().id, IDS.yard);
  assert.equal(h.mon.yard().polygon.length, 4);
  const s = clone(DEFAULT_SETTINGS);
  s.yardGeofenceId = 'f'.repeat(24);
  assert.deepEqual(h.mon.putSettings(s), { settings: s });
  assert.equal(h.mon.yard(), null);
  await gps(h, 0, 0);
  await gps(h, 60, 0);
  await gps(h, 70, 0);
  assert.equal(ev(h).length, 0);
  assert.equal(h.store.escapes(TID, 0, 2e9).length, 0);
});

test('psz flags: geometric default and per-zone override', () => {
  const h = setup();
  assert.deepEqual(h.mon.pszFlags().map((z) => [z.id, z.name, z.coversYard, z.geometric]), [[IDS.pszIn, 'Kitchen', true, true], [IDS.pszOut, 'Neighbour', false, false]]);
  const s = clone(DEFAULT_SETTINGS);
  s.pszCoversYard = { [IDS.pszIn]: false };
  h.mon.putSettings(s);
  assert.equal(h.mon.pszFlags()[0].coversYard, false);
});

test('escape: out_possible opens a warn incident, the second outside fix rises to critical, chase starts', async () => {
  const h = setup();
  await gps(h, 0, 0);
  await gps(h, 10, 5);
  const tInside = h.clock.s();
  await gps(h, 35, 5);
  let inc = h.store.openIncident(TID);
  assert.equal(inc.kind, 'out_possible');
  assert.equal(inc.severity, 'warn');
  assert.deepEqual(ev(h).map((e) => [e[1].kind, e[2]]), [['out_possible', 'open']]);
  assert.equal(h.mon.status().chase.incidentId, inc.id);
  assert.deepEqual(h.sent.map((c) => [c.name, c.on]), [['live_tracking', true], ['pos_request', true]]);
  assert.equal(h.mon.status().lastFix.cls, 'outside');
  await gps(h, 45, 5);
  inc = h.store.openIncident(TID);
  assert.equal(inc.kind, 'out_confirmed');
  assert.equal(inc.severity, 'critical');
  assert.deepEqual(ev(h).map((e) => [e[1].kind, e[2]]), [['out_possible', 'open'], ['out_confirmed', 'rise']]);
  assert.equal(incidents(h).length, 1);
  const [esc] = h.store.escapes(TID, 0, 2e9);
  assert.equal(esc.t_inside, tInside);
  assert.equal(esc.t_outside, tInside + 3);
  assert.equal(esc.dismissed, 0);
  assert.equal(inc.data.escape_t_outside, tInside + 3);
  assert.equal(ev(h, 'chase')[0][1].active, true);
  assert.equal(ev(h, 'chase-position').length, 1);
  assert.deepEqual(h.store.commands(10).map((c) => c.actor).sort(), ['auto:chase', 'auto:live']);
});

test('a critical incident repeats every 2 min until acked, at most 10 times', async () => {
  const h = setup();
  const inc = await openCritical(h);
  assert.equal(inc.kind, 'out_confirmed');
  assert.equal(ev(h).filter((e) => e[1].severity === 'critical' && e[2] === 'open').length, 1);
  await tick(h, 60_000);
  assert.equal(repeatsOf(h, inc.id), 0);
  await tick(h, 60_000);
  assert.equal(repeatsOf(h, inc.id), 1);
  assert.equal(h.store.alert(inc.id).sent_count, 1);
  for (let i = 0; i < 30; i++) await tick(h, 60_000);
  assert.equal(repeatsOf(h, inc.id), 10);
  assert.equal(h.store.alert(inc.id).sent_count, 10);
});

test('ack stops repeats; back_home closes the incident and ends the chase', async () => {
  const h = setup();
  const inc = await openCritical(h);
  await tick(h, 120_000);
  assert.equal(repeatsOf(h, inc.id), 1);
  assert.equal(h.mon.ack(inc.id, 'web').acked_by, 'web');
  await tick(h, 120_000);
  await tick(h, 120_000);
  assert.equal(repeatsOf(h, inc.id), 1);
  await gps(h, 0, 0);
  assert.equal(h.store.alert(inc.id).closed_by, 'home');
  const back = kinds(h, 'back_home')[0];
  assert.equal(back.severity, 'info');
  assert.equal(back.incident, 0);
  assert.equal(h.mon.status().chase, null);
  assert.equal(ev(h, 'chase').at(-1)[1].active, false);
  assert.equal(ev(h, 'chase').at(-1)[1].reason, 'closed');
  assert.equal(h.store.getKv('chase'), null);
});

test('back_home without ack also stops repeats', async () => {
  const h = setup();
  const inc = await openCritical(h);
  await gps(h, 0, 0);
  for (let i = 0; i < 5; i++) await tick(h, 120_000);
  assert.equal(repeatsOf(h, inc.id), 0);
});

test('repeats and the chase resume after a restart from the persisted state', async () => {
  const store = new Store(':memory:');
  const clock = fakeClock();
  const a = setup({ store, clock });
  const inc = await openCritical(a);
  for (let i = 0; i < 3; i++) await tick(a, 120_000);
  assert.equal(repeatsOf(a, inc.id), 3);
  a.mon.stop();
  const b = setup({ store, clock });
  assert.equal(b.mon.status().incident.id, inc.id);
  assert.ok(b.mon.status().chase);
  await tick(b, 120_000);
  assert.equal(repeatsOf(b, inc.id), 1);
  assert.equal(store.alert(inc.id).sent_count, 4);
});

test('four kinds of evidence for one escape make one incident and one critical message', async () => {
  const h = setup();
  await wifi(h, PSZ_IN);
  h.mon.onTimelineEvents([]);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null, hardware: { time: h.clock.s(), battery_level: 80, power_saving_zone_id: null } });
  await h.mon.idle();
  await gps(h, 35, 5);
  await gps(h, 45, 5);
  h.clock.advance(1000);
  h.mon.onTimelineEvents([{ id: 'e1', type: 'safezoneExit', occurredAt: new Date(h.clock.now()).toISOString(), zoneName: 'Yard' }]);
  await h.mon.idle();
  assert.equal(incidents(h).length, 1);
  const crit = ev(h).filter((e) => e[1].severity === 'critical' && ['open', 'rise'].includes(e[2]));
  assert.equal(crit.length, 1);
  assert.equal(crit[0][1].kind, 'left_psz');
  assert.equal(crit[0][1].title, 'Left Wi-Fi zone Kitchen');
  assert.deepEqual(incidents(h)[0].data.evidence.map((e) => e.kind), ['left_psz', 'out_possible', 'out_confirmed', 'fence_exit']);
});

test('an isolated outside fix followed by a home fix within 45 s is an outlier: no escape stored', async () => {
  const h = setup();
  await gps(h, 0, 0);
  await gps(h, 35, 0);
  await gps(h, 0, 0, { dt: 20_000 });
  assert.equal(h.store.openIncident(TID), null);
  assert.equal(h.store.escapes(TID, 0, 2e9).length, 0);
});

test('no home fix within 45 s after out_possible confirms the escape', async () => {
  const h = setup();
  await gps(h, 0, 0);
  await gps(h, 35, 0);
  await tick(h, 30_000);
  assert.equal(h.store.openIncident(TID).severity, 'warn');
  await tick(h, 16_000);
  const inc = h.store.openIncident(TID);
  assert.equal(inc.severity, 'critical');
  assert.equal(inc.kind, 'out_confirmed');
  assert.equal(h.store.escapes(TID, 0, 2e9).length, 1);
});

test('three uncertain fixes spanning 20 s raise out_possible; two do not', async () => {
  const h = setup();
  await gps(h, 0, 0);
  await gps(h, 25, 0, { dt: 10_000 });
  await gps(h, 26, 0, { dt: 10_000 });
  assert.equal(h.store.openIncident(TID), null);
  await gps(h, 27, 0, { dt: 10_000 });
  const inc = h.store.openIncident(TID);
  assert.equal(inc.kind, 'out_possible');
  assert.equal(inc.data.evidence[0].reason, 'uncertain');
});

test('one fix more than max(3 x acc, 30 m) out opens a critical incident at once', async () => {
  const h = setup();
  await gps(h, 0, 0);
  await gps(h, 60, 0);
  assert.equal(h.store.openIncident(TID).kind, 'out_confirmed');
  assert.deepEqual(ev(h).map((e) => e[2]), ['open']);
});

test('leaving a zone that does not cover the yard is a warning without incident or chase', async () => {
  const h = setup();
  await wifi(h, PSZ_OUT);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null });
  await h.mon.idle();
  const a = h.store.lastAlertOfKind(TID, 'left_psz');
  assert.equal(a.severity, 'warn');
  assert.equal(a.incident, 0);
  assert.equal(h.mon.status().chase, null);
});

test('clearing the covers-the-yard flag turns leaving that zone into a warning', async () => {
  const h = setup();
  const s = clone(DEFAULT_SETTINGS);
  s.pszCoversYard = { [IDS.pszIn]: false };
  h.mon.putSettings(s);
  await wifi(h, PSZ_IN);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null });
  await h.mon.idle();
  assert.equal(h.store.openIncident(TID), null);
  assert.equal(h.store.lastAlertOfKind(TID, 'left_psz').severity, 'warn');
});

test('walk mode: no incident, the episode is stored dismissed as a walk, the first home fix after an outside fix ends it', async () => {
  const h = setup();
  h.mon.setWalk(60, 'web');
  assert.equal(h.mon.status().walk.until, h.clock.s() + 3600);
  await gps(h, 0, 0);
  await gps(h, 60, 0);
  await gps(h, 70, 0);
  assert.equal(h.store.openIncident(TID), null);
  const [e] = h.store.escapes(TID, 0, 2e9);
  assert.equal(e.dismissed, 1);
  assert.equal(e.note, 'walk');
  await gps(h, 0, 0);
  assert.equal(h.mon.status().walk, null);
});

test('walk mode expires', async () => {
  const h = setup();
  h.mon.setWalk(1, 'web');
  await tick(h, 61_000);
  assert.equal(h.mon.status().walk, null);
});

test("It's a walk closes the incident, dismisses its episode and turns walk mode on for 2 h", async () => {
  const h = setup();
  const inc = await openCritical(h);
  const row = h.mon.itsAWalk(inc.id, 'telegram:1001');
  assert.equal(row.closed_by, 'walk');
  const [e] = h.store.escapes(TID, 0, 2e9);
  assert.equal(e.dismissed, 1);
  assert.equal(e.note, 'walk');
  assert.equal(h.mon.status().walk.until, h.clock.s() + 7200);
  assert.equal(h.mon.status().chase, null);
});

test('false alarm closes the incident without back_home', async () => {
  const h = setup();
  const inc = await openCritical(h);
  assert.equal(h.mon.falseAlarm(inc.id, 'web').closed_by, 'web');
  assert.equal(h.store.lastAlertOfKind(TID, 'back_home'), null);
  assert.equal(h.mon.falseAlarm(inc.id, 'web'), null);
});

test('battery thresholds, dedupe within 10 min unless the kind differs, charging info', async () => {
  const h = setup({ battery: 80 });
  const hw = (b, charging) => {
    h.clock.advance(60_000);
    status(h, { hardware: { time: h.clock.s(), battery_level: b }, ...(charging && { charging_state: charging }) });
    return h.mon.idle();
  };
  await hw(19);
  assert.equal(h.store.lastAlertOfKind(TID, 'battery_low').severity, 'warn');
  await hw(50);
  await hw(18);
  assert.equal(kinds(h, 'battery_low').length, 1);
  await hw(9);
  assert.equal(h.store.lastAlertOfKind(TID, 'battery_critical').severity, 'critical');
  h.clock.advance(11 * 60_000);
  await hw(50);
  await hw(19);
  assert.equal(kinds(h, 'battery_low').length, 2);
  await hw(19, 'CHARGING');
  assert.equal(h.store.lastAlertOfKind(TID, 'charging').title, 'Charging started');
  h.clock.advance(11 * 60_000);
  await hw(20, 'NOT_CHARGING');
  assert.equal(h.store.lastAlertOfKind(TID, 'charging').title, 'Charging stopped');
});

test('offline: raw state, silence for 75 min, 10 min and critical while an incident is open', async () => {
  const h = setup();
  status(h, { tracker_state: 'NOT_REPORTING', tracker_state_reason: 'SHUTDOWN_BY_USER' });
  await h.mon.idle();
  assert.equal(h.store.lastAlertOfKind(TID, 'offline').severity, 'warn');
  const h2 = setup();
  await gps(h2, 0, 0);
  await tick(h2, 74 * 60_000);
  assert.equal(h2.store.lastAlertOfKind(TID, 'offline'), null);
  await tick(h2, 2 * 60_000);
  assert.equal(h2.store.lastAlertOfKind(TID, 'offline').severity, 'warn');
  await tick(h2, 30 * 60_000);
  assert.equal(kinds(h2, 'offline').length, 1);              // once per outage
  const h3 = setup();
  await openCritical(h3);
  await tick(h3, 11 * 60_000);
  assert.equal(h3.store.lastAlertOfKind(TID, 'offline').severity, 'critical');
});

test('channel_down after 5 min disconnected, once per outage', async () => {
  const h = setup();
  h.mon.onChannelStatus({ connected: false, since: null, lastMessageAt: null, reconnects: 1 });
  await tick(h, 4 * 60_000);
  assert.equal(h.store.lastAlertOfKind(TID, 'channel_down'), null);
  await tick(h, 61_000);
  assert.equal(h.store.lastAlertOfKind(TID, 'channel_down').severity, 'warn');
  await tick(h, 20 * 60_000);
  assert.equal(kinds(h, 'channel_down').length, 1);
});

test('timeline: the first call sets the baseline; newer dangerzoneEnter raises a critical incident once', async () => {
  const h = setup();
  const iso = (ms) => new Date(ms).toISOString();
  h.mon.onTimelineEvents([{ id: 'old', type: 'safezoneExit', occurredAt: iso(h.clock.now() - 60_000), zoneName: 'Yard' }]);
  await h.mon.idle();
  assert.equal(h.store.openIncident(TID), null);
  h.clock.advance(5000);
  const fresh = { id: 'new', type: 'dangerzoneEnter', occurredAt: iso(h.clock.now()), zoneName: 'Road' };
  h.mon.onTimelineEvents([fresh, { id: 'old', type: 'safezoneExit', occurredAt: iso(h.clock.now() - 65_000), zoneName: 'Yard' }]);
  await h.mon.idle();
  const inc = h.store.openIncident(TID);
  assert.equal(inc.kind, 'danger_enter');
  assert.equal(inc.severity, 'critical');
  h.mon.onTimelineEvents([fresh]);
  await h.mon.idle();
  assert.equal(h.store.alert(inc.id).data.evidence.length, 1);
});

test('liveDecision truth table (manual x chase x yard watch x in-PSZ x active x countdown x starter)', () => {
  const B = [false, true];
  let rows = 0;
  for (const manual of B) for (const chase of B) for (const yard of B) for (const inPsz of B) for (const active of B) for (const low of B) for (const startedByApp of B) {
    const wanted = manual || chase || yard;
    const got = liveDecision({ wanted, inPsz, active, remainingS: low ? 30 : 600, startedByApp, userOff: false, sinceLastCmdS: 999 });
    let want = null;
    if (!inPsz) {
      if (wanted && (!active || low)) want = 'on';
      else if (!wanted && active && startedByApp) want = 'off';
    }
    assert.equal(got, want, JSON.stringify({ manual, chase, yard, inPsz, active, low, startedByApp }));
    rows++;
  }
  assert.equal(rows, 128);
  assert.equal(liveDecision({ wanted: true, inPsz: false, active: false, remainingS: 0, startedByApp: false, userOff: false, sinceLastCmdS: 29 }), null);
  assert.equal(liveDecision({ wanted: false, inPsz: false, active: true, remainingS: 600, startedByApp: false, userOff: true, sinceLastCmdS: 999 }), 'off');
});

test('the reconciler sends at most one live command per 30 s and re-sends when the countdown runs low', async () => {
  const h = setup();
  const s = clone(DEFAULT_SETTINGS);
  s.yardWatch.enabled = true;
  s.yardWatch.windows = FULL_DAY;
  h.mon.putSettings(s);
  await h.mon.reconcile();
  assert.deepEqual(h.sent.map((c) => [c.name, c.on]), [['live_tracking', true]]);
  await tick(h, 10_000);
  await tick(h, 10_000);
  assert.equal(h.sent.length, 1);
  status(h, { live_tracking: { active: true, pending: false, remaining: 300, timeout: 300 } });
  await tick(h, 10_000);
  assert.equal(h.sent.length, 1);
  await tick(h, 250_000);                                   // local countdown 300 - 260 = 40 s < 60
  assert.deepEqual(h.sent.map((c) => c.on), [true, true]);
  assert.ok(h.sent[1].at - h.sent[0].at >= 30_000);
  assert.equal(h.mon.status().yardWatch.status, 'active');
});

test('nothing is sent inside a Wi-Fi zone; a user toggle off stops the session the app started', async () => {
  const h = setup();
  await wifi(h, PSZ_OUT);
  await h.mon.setManualLive(true, 'web');
  assert.equal(h.sent.length, 0);
  assert.equal(h.mon.status().live.wanted, true);
  await gps(h, 0, 0);
  await tick(h, 10_000);
  assert.deepEqual(h.sent.map((c) => c.on), [true]);
  status(h, { live_tracking: { active: true, pending: false, remaining: 300, timeout: 300 } });
  await h.mon.idle();
  await h.mon.setManualLive(false, 'web');
  assert.deepEqual(h.sent.map((c) => c.on), [true, false]);
});

test('a session started from the phone is left alone; the end of a session clears manual', async () => {
  const h = setup();
  status(h, { live_tracking: { active: true, pending: false, remaining: 300, timeout: 300 } });
  await tick(h, 10_000);
  assert.equal(h.sent.length, 0);
  await h.mon.setManualLive(true, 'web');
  assert.equal(h.sent.length, 0);
  status(h, { live_tracking: { active: false, pending: false, remaining: 0, timeout: 300 } });
  await h.mon.idle();
  assert.equal(h.mon.status().live.manual, false);
  assert.equal(h.sent.length, 0);
});

test('three failed live commands raise live_failed and back off to 2 min', async () => {
  const h = setup({ fail: 10 });
  await h.mon.setManualLive(true, 'web');
  await tick(h, 31_000);
  await tick(h, 31_000);
  assert.equal(h.store.lastAlertOfKind(TID, 'live_failed').severity, 'warn');
  assert.equal(h.mon.status().live.failures, 3);
  const n = h.sent.length;
  await tick(h, 60_000);
  assert.equal(h.sent.length, n);
  await tick(h, 61_000);
  assert.equal(h.sent.length, n + 1);
});

test('chase ends on manual stop, after maxHours and at the battery floor', async () => {
  const a = setup();
  await a.mon.setChase(true, 'web');
  assert.ok(a.mon.status().chase);
  await a.mon.setChase(false, 'web');
  assert.equal(ev(a, 'chase').at(-1)[1].reason, 'manual');
  const b = setup();
  await b.mon.setChase(true, 'web');
  await tick(b, 6 * 3600_000 + 1000);
  assert.equal(ev(b, 'chase').at(-1)[1].reason, 'timeout');
  assert.equal(b.store.getKv('chase'), null);
  const c = setup();
  await c.mon.setChase(true, 'web');
  status(c, { hardware: { time: c.clock.s() + 1, battery_level: 15 } });
  await c.mon.idle();
  const end = ev(c, 'chase').at(-1)[1];
  assert.equal(end.active, false);
  assert.equal(end.reason, 'battery');
  assert.equal(typeof end.durationS, 'number');
  assert.equal(typeof end.distanceM, 'number');
  const low = c.store.lastAlertOfKind(TID, 'chase_low_battery');
  assert.equal(low.severity, 'critical');
  assert.equal(low.title, 'Live tracking stopped to save the last battery; normal tracking continues');
});

test('chase asks for a fresh fix at most once per 60 s while live tracking is not active', async () => {
  const h = setup();
  await h.mon.setChase(true, 'web');
  const pr = () => h.sent.filter((c) => c.name === 'pos_request').length;
  assert.equal(pr(), 1);
  await tick(h, 30_000);
  assert.equal(pr(), 1);
  await tick(h, 31_000);
  assert.equal(pr(), 2);
  status(h, { live_tracking: { active: true, pending: false, remaining: 300, timeout: 300 } });
  await tick(h, 61_000);
  assert.equal(pr(), 2);
});

test('chase emits positions for GPS fixes only and survives a restart with its message ids', async () => {
  const store = new Store(':memory:');
  const clock = fakeClock();
  const h = setup({ store, clock });
  await h.mon.setChase(true, 'web');
  await gps(h, 0, 0);
  await wifi(h, PSZ_OUT);
  await gps(h, 5, 5);
  assert.equal(ev(h, 'chase-position').length, 2);
  h.mon.setChaseMessage('1001', 42);
  h.mon.stop();
  const h2 = setup({ store, clock });
  assert.deepEqual(h2.mon.chaseState().messages, { 1001: 42 });
  assert.ok(h2.mon.status().chase);
});

test('inWindow handles days, times and windows that wrap past midnight', () => {
  const at = (iso) => Date.parse(iso);
  const w = [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '22:00' }];
  assert.equal(inWindow(w, at('2026-11-20T10:00:00+01:00'), 'Europe/Madrid'), true);   // Friday
  assert.equal(inWindow(w, at('2026-11-20T23:00:00+01:00'), 'Europe/Madrid'), false);
  assert.equal(inWindow(w, at('2026-11-21T10:00:00+01:00'), 'Europe/Madrid'), false);  // Saturday
  const night = [{ days: [5], from: '22:00', to: '06:00' }];
  assert.equal(inWindow(night, at('2026-11-20T23:30:00+01:00'), 'Europe/Madrid'), true);
  assert.equal(inWindow(night, at('2026-11-21T05:59:00+01:00'), 'Europe/Madrid'), true);
  assert.equal(inWindow(night, at('2026-11-21T06:00:00+01:00'), 'Europe/Madrid'), false);
  assert.equal(inWindow(night, at('2026-11-20T05:00:00+01:00'), 'Europe/Madrid'), false);
});

test('yardWatchStatus order and battery hysteresis', () => {
  const yw = { ...DEFAULT_SETTINGS.yardWatch, enabled: true, windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '22:00' }] };
  const nowMs = Date.parse('2026-11-20T10:00:00+01:00');
  const st = (o) => yardWatchStatus({ yw, nowMs, tz: 'Europe/Madrid', battery: 80, charging: false, inPsz: false, lowLatched: false, ...o });
  assert.equal(st({ yw: { ...yw, enabled: false } }).status, 'off');
  assert.equal(st({ nowMs: Date.parse('2026-11-20T23:00:00+01:00') }).status, 'outside-window');
  assert.equal(st({ charging: true }).status, 'paused-charging');
  assert.equal(st({ inPsz: true }).status, 'paused-in-psz');
  assert.deepEqual(st({ battery: 34 }), { status: 'low-battery', lowLatched: true });
  assert.deepEqual(st({ battery: 38, lowLatched: true }), { status: 'low-battery', lowLatched: true });
  assert.deepEqual(st({ battery: 40, lowLatched: true }), { status: 'active', lowLatched: false });
  assert.deepEqual(st({}), { status: 'active', lowLatched: false });
});

test('near-fence yard watch wants live tracking for nearFenceHoldMin after a fix near the boundary', async () => {
  const h = setup();
  const s = clone(DEFAULT_SETTINGS);
  Object.assign(s.yardWatch, { enabled: true, mode: 'near-fence', windows: FULL_DAY });
  h.mon.putSettings(s);
  await gps(h, 0, 0);
  await tick(h, 10_000);
  assert.equal(h.sent.length, 0);
  await gps(h, 10, 0);
  assert.deepEqual(h.sent.map((c) => c.on), [true]);
  assert.equal(h.mon.status().yardWatch.status, 'active');
  await gps(h, 0, 0);
  await tick(h, 11 * 60_000);
  assert.equal(h.mon.status().live.wanted, false);
});

test('unknown-field detector: silent baseline, one new_field per new path, redaction, daily cap', () => {
  const h = setup();
  const obj = { a: 1, details: { name: 'Rex', list: [{ x: 1 }] } };
  assert.deepEqual(h.mon.detectFields('pet', obj), []);
  assert.equal(h.store.knownFieldCount('pet'), 6);
  assert.deepEqual(h.mon.detectFields('pet', obj), []);
  h.clock.advance(3600_000); // the first hour is learned silently
  const added = h.mon.detectFields('pet', { ...obj, b: 'hello', details: { ...obj.details, owner_email: 'x@y.z', list: [{ x: 1, latlong: [41, 2] }] } });
  assert.deepEqual(added.sort(), ['b', 'details.list[].latlong', 'details.owner_email']);
  const nf = kinds(h, 'new_field');
  assert.equal(nf.length, 3);
  const byPath = Object.fromEntries(nf.map((a) => [a.data.path, a.data.example]));
  assert.equal(byPath.b, 'hello');
  assert.equal(byPath['details.owner_email'], '<redacted>');
  assert.equal(byPath['details.list[].latlong'], '<redacted>');
  assert.ok(nf.every((a) => a.severity === 'info' && a.data.kind === 'pet'));
  assert.deepEqual(h.mon.detectFields('pet', { ...obj, b: 'again' }), []);
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
  assert.equal(h.mon.detectFields('pet', { ...obj, ...many }).length, 25);
  assert.equal(kinds(h, 'new_field').length, 20);
  assert.deepEqual([...flattenPaths({ a: { b: [{ c: 1 }] } }).keys()], ['a', 'a.b', 'a.b[]', 'a.b[].c']);
  assert.deepEqual(h.mon.detectFields('tracker', { z: 1 }), []);  // a new kind gets its own silent baseline
});

test('commands from web and telegram are logged with their actor and emitted; live goes through setManualLive', async () => {
  const h = setup();
  await h.mon.command('telegram:1001', TID, 'led_control', true);
  const [c] = h.store.commands(5);
  assert.equal(c.actor, 'telegram:1001');
  assert.equal(c.action, 'command:led_control');
  assert.deepEqual(c.params, { tracker: TID, on: true });
  assert.equal(c.ok, 1);
  assert.equal(ev(h, 'command').length, 1);
  await assert.rejects(h.mon.command('web', TID, 'live_tracking', true), /use setManualLive/);
});

test('reclassify seeds the home state from the current position once the yard is known', async () => {
  const store = new Store(':memory:');
  store.setRaw(`geofences:${TID}`, []);
  store.setRaw(`psz:${TID}`, [PSZ_IN, PSZ_OUT]);
  const h = setup({ store });
  await gps(h, 0, 0);
  assert.equal(h.mon.status().lastFix, null);
  store.setRaw(`geofences:${TID}`, [YARD]);
  h.mon.reclassify();
  assert.equal(h.mon.status().lastFix.cls, 'inside');
  assert.equal(ev(h).length, 0);
  await gps(h, 35, 5);
  assert.equal(h.store.openIncident(TID).kind, 'out_possible');
});

// ---- fix freshness and zones ----

const iso = (ms) => new Date(ms).toISOString();
const opens = (h) => ev(h).filter((e) => e[1].incident === 1 && e[2] === 'open');

test('F1: re-entering a home Wi-Fi zone without a position closes the incident; a later escape opens a new critical one', async () => {
  const h = setup();
  await wifi(h, PSZ_IN);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null });
  await h.mon.idle();
  const first = h.store.openIncident(TID);
  assert.equal(first.kind, 'left_psz');
  h.clock.advance(60_000);
  status(h, { power_saving_zone_id: PSZ_IN._id, tracker_state_reason: 'POWER_SAVING' });
  await h.mon.idle();
  assert.equal(h.store.alert(first.id).closed_by, 'home');
  assert.equal(kinds(h, 'back_home').length, 1);
  assert.equal(h.mon.status().chase, null);
  h.mon.ack(first.id, 'web');
  h.clock.advance(3600_000);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null });
  await h.mon.idle();
  for (const x of [80, 100, 140]) await gps(h, x, 0);
  const second = h.store.openIncident(TID);
  assert.ok(second && second.id !== first.id);
  assert.equal(second.severity, 'critical');
  assert.equal(opens(h).length, 2);
  assert.ok(h.mon.status().chase);
});

test('F1: a zone flap left alone does not repeat for hours once the tracker is back in the zone', async () => {
  const h = setup();
  await wifi(h, PSZ_IN);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null });
  await h.mon.idle();
  const inc = h.store.openIncident(TID);
  status(h, { power_saving_zone_id: PSZ_IN._id, tracker_state_reason: 'POWER_SAVING' });
  await h.mon.idle();
  const pr = h.sent.filter((c) => c.name === 'pos_request').length;
  for (let i = 0; i < 180; i++) await tick(h, 120_000);
  assert.equal(h.store.openIncident(TID), null);
  assert.equal(repeatsOf(h, inc.id), 0);
  assert.equal(h.sent.filter((c) => c.name === 'pos_request').length, pr);
});

test('F1: new evidence after 10 quiet minutes re-alerts an acked incident and restarts its repeats', async () => {
  const h = setup();
  h.mon.onTimelineEvents([]);
  h.clock.advance(5000);
  h.mon.onTimelineEvents([{ id: 'a', type: 'safezoneExit', occurredAt: iso(h.clock.now()), zoneName: 'Yard' }]);
  await h.mon.idle();
  const inc = h.store.openIncident(TID);
  h.mon.ack(inc.id, 'web');
  for (let i = 0; i < 6; i++) await tick(h, 120_000);
  assert.equal(repeatsOf(h, inc.id), 0);
  await gps(h, 60, 0);
  assert.equal(ev(h).at(-1)[1].id, inc.id);
  assert.equal(ev(h).at(-1)[2], 'rise');
  const row = h.store.alert(inc.id);
  assert.equal(row.acked_at, null);
  assert.equal(row.sent_count, 0);
  await tick(h, 120_000);
  assert.equal(repeatsOf(h, inc.id), 1);
});

test('F2: a timeline fence exit read after the dog is back home opens nothing', async () => {
  const h = setup();
  h.mon.onTimelineEvents([]);
  await gps(h, 0, 0);
  await gps(h, 35, 0);
  const escMs = h.clock.now();
  await gps(h, 45, 0);
  assert.equal(h.store.openIncident(TID).severity, 'critical');
  await gps(h, 0, 0, { dt: 120_000 });
  assert.equal(h.store.openIncident(TID), null);
  h.mon.onTimelineEvents([{ id: 'x', type: 'safezoneExit', occurredAt: iso(escMs), zoneName: 'Yard' }]);
  await h.mon.idle();
  assert.equal(h.store.openIncident(TID), null);
  assert.equal(incidents(h).length, 1);
  assert.equal(h.mon.status().chase, null);
});

test('F3: leaving the zone with a GPS fix inside the yard in the same status raises nothing; a status without fix still does', async () => {
  const h = setup();
  await wifi(h, PSZ_IN);
  h.clock.advance(3000);
  const p = ll(0, 0);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null, position: { time: h.clock.s(), latlong: [p.lat, p.lng], sensor_used: 'GPS', accuracy: 5 } });
  await h.mon.idle();
  assert.equal(kinds(h, 'left_psz').length, 0);
  assert.equal(ev(h, 'chase').length, 0);
  assert.equal(h.sent.filter((c) => c.name === 'pos_request').length, 0);
  // the other order: the status leaves the zone first, the inside fix comes after
  await wifi(h, PSZ_IN);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null });
  await h.mon.idle();
  const inc = h.store.openIncident(TID);
  assert.equal(inc.kind, 'left_psz');
  await gps(h, 0, 0);
  assert.equal(h.store.alert(inc.id).closed_by, 'home');
});

test('F4: GPS jitter at the fence opens at most one out_possible incident per dedupe period', async () => {
  const h = setup();
  await gps(h, 0, 0);
  for (let c = 0; c < 60; c++) { // one hour: 8 uncertain fixes 3 m out, then 12 fixes 2 m in, every 3 s
    for (let i = 0; i < 8; i++) await gps(h, 23, 0, { acc: 8 });
    for (let i = 0; i < 12; i++) await gps(h, 18, 0, { acc: 8 });
  }
  assert.equal(incidents(h).length, 6);
  assert.equal(ev(h, 'chase').filter((e) => e[1].active).length, 6);
});

test('F4: the evidence list of an open incident keeps the last 50 items', async () => {
  const h = setup();
  h.mon.onTimelineEvents([]);
  for (let i = 0; i < 60; i++) {
    h.clock.advance(1000);
    h.mon.onTimelineEvents([{ id: `e${i}`, type: 'safezoneExit', occurredAt: iso(h.clock.now()), zoneName: 'Yard' }]);
  }
  await h.mon.idle();
  const ids = h.store.openIncident(TID).data.evidence.map((e) => e.eventId);
  assert.equal(ids.length, 50);
  assert.equal(ids.at(-1), 'e59');
});

test('F7: the field detector learns silently for the first hour', () => {
  const h = setup();
  assert.deepEqual(h.mon.detectFields('tracker', { _id: 'a', state: 'X' }), []);
  h.clock.advance(30 * 60_000);
  assert.deepEqual(h.mon.detectFields('tracker', { _id: 'b', state: 'X', power_mode: 'Y', hw_edition: 'Z' }), []);
  assert.equal(kinds(h, 'new_field').length, 0);
  assert.equal(h.store.knownFieldCount('tracker'), 4);
  h.clock.advance(31 * 60_000);
  assert.deepEqual(h.mon.detectFields('tracker', { _id: 'b', charging_state: 'C' }), ['charging_state']);
  assert.equal(kinds(h, 'new_field').length, 1);
});

test('a live command that stays pending across resends raises live_failed', async () => {
  const h = setup();
  await h.mon.setManualLive(true, 'web');
  for (let i = 0; i < 60; i++) await tick(h, 10_000);
  assert.equal(h.store.lastAlertOfKind(TID, 'live_failed')?.severity, 'warn');
});

test('entering walk mode ends the chase; a chase cannot start while walking', async () => {
  const a = setup();
  await a.mon.setChase(true, 'web');
  a.mon.setWalk(60, 'web');
  await a.mon.idle();
  assert.equal(a.mon.status().chase, null);
  assert.equal(ev(a, 'chase').at(-1)[1].active, false);
  const b = setup();
  b.mon.setWalk(60, 'web');
  await b.mon.setChase(true, 'web');
  assert.equal(b.mon.status().chase, null);
  assert.equal(ev(b, 'chase').length, 0);
  assert.equal(b.sent.length, 0);
});

test('a fix more than 15 min old updates lastFix but raises nothing', async () => {
  const h = setup();
  h.clock.advance(3000);
  const p = ll(60, 0);
  status(h, { power_saving_zone_id: null, tracker_state_reason: null, position: { time: h.clock.s() - 3600, latlong: [p.lat, p.lng], sensor_used: 'GPS', accuracy: 5 } });
  await h.mon.idle();
  assert.equal(h.mon.status().lastFix.cls, 'outside');
  assert.equal(h.store.openIncident(TID), null);
  assert.equal(ev(h).length, 0);
  assert.equal(h.store.escapes(TID, 0, 2e9).length, 0);
});

test('left_psz by reason only when the reason clears to null and the tracker is not charging', async () => {
  const h = setup();
  await wifi(h, PSZ_IN);
  const st = async (patch) => { h.clock.advance(3000); status(h, patch); await h.mon.idle(); };
  await st({ tracker_state_reason: 'CHARGING', charging_state: 'CHARGING' });
  await st({ tracker_state_reason: 'POWER_SAVING' });
  await st({ tracker_state_reason: null });
  assert.equal(kinds(h, 'left_psz').length, 0); // still charging
  await st({ tracker_state_reason: 'POWER_SAVING', charging_state: 'NOT_CHARGING' });
  await st({ tracker_state_reason: 'SOMETHING_ELSE' });
  assert.equal(kinds(h, 'left_psz').length, 0);
  await st({ tracker_state_reason: 'POWER_SAVING' });
  await st({ tracker_state_reason: null });
  assert.equal(h.store.openIncident(TID).kind, 'left_psz');
});

test('S3: starting already in a home zone without an incident raises nothing, stores one zone row and arms escape detection', async () => {
  const store = new Store(':memory:'), clock = fakeClock();
  store.setRaw(`geofences:${TID}`, [YARD]);
  store.setRaw(`psz:${TID}`, [PSZ_IN, PSZ_OUT]);
  const live = new LiveState({ now: clock.now });
  live.applyTracker({ _id: TID, state: 'OPERATIONAL', state_reason: 'POWER_SAVING', power_saving_zone_id: PSZ_IN._id });
  const mon = createMonitor({ store, live, trackerId: TID, sendCommand: async () => ({}), now: clock.now });
  const alerts = [];
  mon.on('alert', (row, reason) => alerts.push([row.kind, reason]));
  mon.start();
  mon.reclassify();
  await mon.idle();
  assert.deepEqual(alerts, []);
  assert.deepEqual(store.positionsAsc(TID, 0, clock.s()).map((r) => [r.source, r.psz_id]), [['zone', PSZ_IN._id]]);
  await gps({ clock, live, mon }, 60, 0); // leaves the zone and is out at once
  assert.deepEqual(alerts, [['left_psz', 'open'], ['left_psz', 'update']]);
  assert.equal(store.escapes(TID, 0, clock.s()).length, 1); // needs the zone row as the last home observation
});
