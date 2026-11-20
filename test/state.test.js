import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveState, normalizePosition, stateLabel, positionRow } from '../src/state.js';
import { fakeClock, TID } from './helpers.js';

const block = (o = {}) => ({ active: false, timeout: 300, remaining: 0, pending: false, reconnecting: false, ...o });
const status = (s, extra = {}) => ({
  message: 'tracker_status', tracker_id: TID, tracker_state: 'OPERATIONAL', tracker_state_reason: null,
  charging_state: 'NOT_CHARGING', battery_state: 'REGULAR', power_saving_zone_id: null,
  hardware: { time: s - 30, battery_level: 80, power_saving_zone_id: null },
  position: { time: s - 30, time_rcvd: s - 29, latlong: [41.0001, 2.0002], sensor_used: 'GPS', accuracy: 6, altitude: 120 },
  live_tracking: block(), led_control: block(), buzzer_control: block(),
  ...extra,
});
function setup() {
  const clock = fakeClock();
  const live = new LiveState({ now: clock.now });
  const changes = [];
  const positions = [];
  live.on('change', (id, st, keys, prev) => changes.push({ id, keys, prev }));
  live.on('position', (id, pos) => positions.push(pos));
  return { clock, live, changes, positions, s: clock.s() };
}

test('a full tracker_status fills the state and emits one position', () => {
  const { live, changes, positions, s } = setup();
  live.applyStatus(status(s));
  const st = live.get(TID);
  assert.equal(st.trackerId, TID);
  assert.equal(st.state, 'OPERATIONAL');
  assert.equal(st.stateLabel, 'Reporting');
  assert.equal(st.battery, 80);
  assert.equal(st.batteryState, 'REGULAR');
  assert.equal(st.charging, 'NOT_CHARGING');
  assert.deepEqual(st.position, { t: s - 30, lat: 41.0001, lng: 2.0002, acc: 6, sensor: 'GPS', alt: 120, speed: null, course: null, pszId: null });
  assert.equal(st.lastStatusAt, s);
  assert.equal(positions.length, 1);
  assert.ok(changes[0].keys.includes('battery') && changes[0].keys.includes('position'));
});

test('missing blocks keep the last values; an old or repeated position is not emitted again', () => {
  const { live, positions, s } = setup();
  live.applyStatus(status(s));
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, hardware: { time: s, battery_level: 70 } });
  const st = live.get(TID);
  assert.equal(st.battery, 70);
  assert.equal(st.position.t, s - 30);
  assert.equal(st.charging, 'NOT_CHARGING');
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, position: { time: s - 30, latlong: [41, 2], sensor_used: 'GPS', accuracy: 9 } });
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, position: { time: s - 100, latlong: [41, 2], sensor_used: 'GPS', accuracy: 9 } });
  assert.equal(positions.length, 1);
  assert.equal(live.get(TID).position.acc, 6);
});

test('a pending command keeps the previous active; LED and buzzer with remaining 0 are off', () => {
  const { live, s } = setup();
  live.applyStatus(status(s, { live_tracking: block({ active: true, remaining: 200 }) }));
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, live_tracking: block({ active: false, pending: true }) });
  assert.equal(live.get(TID).controls.live.active, true);
  assert.equal(live.get(TID).controls.live.pending, true);
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, led_control: block({ active: true, remaining: 0 }) });
  assert.equal(live.get(TID).controls.led.active, false);
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, buzzer_control: block({ active: true, remaining: 10 }) });
  assert.equal(live.get(TID).controls.buzzer.active, true);
  assert.equal(live.get(TID).controls.buzzer.remaining, 10);
  assert.equal(live.get(TID).controls.buzzer.at, s);
});

test('pszId: the top-level key wins (null included), then hardware, else unchanged; change carries prev', () => {
  const { live, changes, s } = setup();
  const Z = 'a'.repeat(24);
  live.applyStatus(status(s, { power_saving_zone_id: Z, tracker_state_reason: 'POWER_SAVING' }));
  assert.equal(live.get(TID).pszId, Z);
  assert.equal(live.get(TID).stateLabel, 'In Wi-Fi zone');
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, hardware: { time: s, battery_level: 80 } });
  assert.equal(live.get(TID).pszId, Z);
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, hardware: { time: s + 1, battery_level: 80, power_saving_zone_id: null } });
  assert.equal(live.get(TID).pszId, null);
  assert.ok(changes.at(-1).keys.includes('pszId'));
  assert.equal(changes.at(-1).prev.pszId, Z);
  live.applyStatus({ message: 'tracker_status', tracker_id: TID, power_saving_zone_id: null, hardware: { time: s + 2, battery_level: 80, power_saving_zone_id: Z } });
  assert.equal(live.get(TID).pszId, null);
});

test('stateLabel keeps the raw state separate from the words', () => {
  assert.equal(stateLabel('NOT_REPORTING', 'SHUTDOWN_BY_USER'), 'Switched off by user');
  assert.equal(stateLabel('NOT_REPORTING', null), 'Not reporting');
  assert.equal(stateLabel('OPERATIONAL', 'POWER_SAVING'), 'In Wi-Fi zone');
  assert.equal(stateLabel('OPERATIONAL', null), 'Reporting');
  assert.equal(stateLabel('OUT_OF_BATTERY', null), 'Out of battery');
  assert.equal(stateLabel('NO_SUBSCRIPTION', null), 'No subscription');
  assert.equal(stateLabel('SOMETHING_NEW', null), 'Something new');
  assert.equal(stateLabel(null, null), 'Unknown');
});

test('normalizePosition: [lat, lng] order, fallbacks, drops and the PSZ pin match; positionRow', () => {
  const nowS = 1_790_000_000;
  const pin = { id: 'b'.repeat(24), lat: 41.00005, lng: 1.99994 };
  assert.deepEqual(normalizePosition({ time: nowS, latlong: [41.1, 2.2], pos_uncertainty: 30, alt: 7, sensor_used: 'KNOWN_WIFI' }, { nowS }),
    { t: nowS, lat: 41.1, lng: 2.2, acc: 30, sensor: 'KNOWN_WIFI', alt: 7, speed: null, course: null, pszId: null });
  assert.equal(normalizePosition({ time: nowS, latlong: [41.00005, 1.99994], sensor_used: 'KNOWN_WIFI' }, { nowS, pszPins: [pin] }).pszId, pin.id);
  assert.equal(normalizePosition({ time: nowS, latlong: [41, 2], power_saving_zone_id: 'c'.repeat(24) }, { nowS, pszPins: [pin] }).pszId, 'c'.repeat(24));
  const full = normalizePosition({ time: nowS, latlong: [41, 2], accuracy: 4, pos_uncertainty: 30, altitude: 5, speed: 1.5, course: 90 }, { nowS });
  assert.deepEqual([full.acc, full.alt, full.speed, full.course, full.sensor], [4, 5, 1.5, 90, null]);
  for (const bad of [{ time: nowS, latlong: 'x' }, { time: nowS, latlong: [41] }, { time: nowS, latlong: [NaN, 2] }, { time: nowS + 301, latlong: [41, 2] }, { latlong: [41, 2] }, null]) {
    assert.equal(normalizePosition(bad, { nowS }), null, JSON.stringify(bad));
  }
  assert.deepEqual(positionRow(TID, { t: 1, lat: 2, lng: 3, acc: 4, sensor: 'GPS', alt: null, speed: null, course: null, pszId: null }, 'rest'),
    { tracker_id: TID, t: 1, lat: 2, lng: 3, acc: 4, sensor: 'GPS', alt: null, speed: null, course: null, psz_id: null, source: 'rest' });
});

test('REST tracker fills device fields; state fields only until the channel speaks', () => {
  const { live, s } = setup();
  const rest = { _id: TID, hw_id: TID, model_number: 'TG6A', power_mode: 'PRECISION', custom_lt_timeout: 900, state: 'OPERATIONAL', state_reason: 'POWER_SAVING', charging_state: 'CHARGING', battery_state: 'LOW', power_saving_zone_id: 'd'.repeat(24) };
  live.applyTracker(rest);
  let st = live.get(TID);
  assert.equal(st.pszId, 'd'.repeat(24));
  assert.equal(st.charging, 'CHARGING');
  assert.equal(st.powerMode, 'PRECISION');
  assert.equal(st.liveTimeout, 900);
  assert.equal(st.model, 'TG6A');
  live.applyStatus(status(s));
  live.applyTracker({ ...rest, power_mode: 'LOW' });
  st = live.get(TID);
  assert.equal(st.pszId, null);
  assert.equal(st.charging, 'NOT_CHARGING');
  assert.equal(st.powerMode, 'LOW');
});

test('command states from bulk and command responses', () => {
  const { live, s } = setup();
  live.applyStatus(status(s));
  live.applyCommandStates(TID, [{ _id: 'trk00001_pos_request', active: true, pending: false, remaining: 20, timeout: 30 }, { _id: 'trk00001_live_tracking', active: false, pending: false, remaining: 0, timeout: 900 }]);
  assert.equal(live.get(TID).controls.posRequest.active, true);
  assert.equal(live.get(TID).controls.live.timeout, 900);
  live.applyCommandResult(TID, 'led_control', { active: true, pending: true, remaining: 0, timeout: 300 });
  assert.equal(live.get(TID).controls.led.pending, true);
  assert.equal(live.get(TID).controls.led.active, false);
});

test('channel status is copied to every tracker', () => {
  const { live, changes, s } = setup();
  live.applyStatus(status(s));
  live.setChannel({ connected: true, since: s, lastMessageAt: s, reconnects: 0 });
  assert.deepEqual(live.get(TID).channel, { connected: true, since: s, lastMessageAt: s });
  assert.deepEqual(changes.at(-1).keys, ['channel']);
  assert.deepEqual(live.all().map((x) => x.trackerId), [TID]);
});
