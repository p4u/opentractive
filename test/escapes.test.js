import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esc from '../src/escapes.js';
import { distanceM } from '../src/geo.js';
import { ll, square } from './helpers.js';

const yard = square(20);
const S = { ...esc.DEFAULTS };
const T0 = 1_790_000_000;
const NOW = T0 + 100_000;
const KITCHEN = 'b'.repeat(24);
const fix = (x, y, dt, extra = {}) => ({ ...ll(x, y), t: T0 + dt, acc: 5, sensor: 'GPS', psz_id: null, ...extra });
const pszFix = (x, y, dt, id = KITCHEN) => fix(x, y, dt, { acc: 30, sensor: 'KNOWN_WIFI', psz_id: id });
const pick = ({ t_inside, t_outside, confirmed, pending }) => ({ t_inside, t_outside, confirmed, pending });
const detect = (fixes, now = NOW) => esc.detectEpisodes(fixes, yard, { settings: S, now });

test('constants', () => {
  assert.deepEqual(esc.DEFAULTS, { marginM: 10, maxGapS: 600, homePszM: 50 });
  assert.deepEqual(esc.WEIGHT, { good: 1, fair: 0.5, poor: 0.2, none: 0 });
});

test('classify: inside, uncertain, outside, acc fallback, home psz and away', () => {
  const c = (f) => esc.classify(f, yard, S).cls;
  assert.equal(c(fix(0, 0, 0)), 'inside');
  assert.equal(c(fix(26, 0, 0)), 'uncertain');                 // 6 m out, max(5, 10) = 10
  assert.equal(c(fix(31, 0, 0)), 'outside');                   // 11 m out
  assert.equal(c(fix(31, 0, 0, { acc: 20 })), 'uncertain');
  assert.equal(c(fix(60, 0, 0, { acc: null })), 'uncertain');  // acc null counts as 50 m
  assert.equal(c(fix(75, 0, 0, { acc: 0 })), 'outside');
  assert.equal(c(pszFix(5, 5, 0)), 'psz');
  assert.equal(c(pszFix(60, 0, 0)), 'psz');                    // pin 40 m from the yard: within homePszM
  assert.equal(c(pszFix(90, 0, 0)), 'away');
  assert.equal(c(fix(5, 5, 0, { sensor: 'KNOWN_WIFI' })), 'psz'); // KNOWN_WIFI without zone id is still a pin
  assert.ok(Math.abs(esc.classify(fix(31, 0, 0), yard, S).d - 11) < 0.05);
});

test('detectEpisodes: first outside fix after home, confirmed by a second outside fix', () => {
  const fixes = [fix(0, 0, 0), fix(10, 0, 10), fix(35, 0, 20), fix(40, 0, 30)];
  assert.deepEqual(detect(fixes).map(pick), [{ t_inside: T0 + 10, t_outside: T0 + 20, confirmed: true, pending: false }]);
  assert.equal(detect(fixes)[0].lastHome.t, T0 + 10);
  assert.equal(detect(fixes)[0].firstOutside.t, T0 + 20);
});

test('detectEpisodes: outlier rule, far fix, 45 s rule and pending', () => {
  assert.deepEqual(detect([fix(0, 0, 0), fix(35, 0, 10), fix(0, 0, 30)]), []);
  assert.deepEqual(detect([fix(0, 0, 0), fix(35, 0, 10), fix(0, 0, 60)]).map(pick), [{ t_inside: T0, t_outside: T0 + 10, confirmed: true, pending: false }]);
  assert.deepEqual(detect([fix(0, 0, 0), fix(55, 0, 10), fix(0, 0, 15)]).map(pick), [{ t_inside: T0, t_outside: T0 + 10, confirmed: true, pending: false }]);
  const last = [fix(0, 0, 0), fix(35, 0, 10)];
  assert.deepEqual(detect(last, T0 + 20).map(pick), [{ t_inside: T0, t_outside: T0 + 10, confirmed: false, pending: true }]);
  assert.deepEqual(detect(last, T0 + 60).map(pick), [{ t_inside: T0, t_outside: T0 + 10, confirmed: true, pending: false }]);
});

test('detectEpisodes: one episode per excursion; uncertain alone is no escape; away ends the home state', () => {
  const two = [fix(0, 0, 0), fix(35, 0, 10), fix(40, 0, 20), fix(45, 0, 30), fix(0, 0, 40), fix(35, 0, 100), fix(40, 0, 110)];
  assert.deepEqual(detect(two).map((e) => e.t_outside), [T0 + 10, T0 + 100]);
  assert.deepEqual(detect([fix(0, 0, 0), fix(25, 0, 10), fix(25, 0, 20), fix(25, 0, 30)]), []);
  assert.deepEqual(detect([fix(0, 0, 0), pszFix(90, 0, 10), fix(35, 0, 20), fix(40, 0, 25)]), []);
  const viaPsz = detect([pszFix(5, 5, 0), fix(0, 60, 10), fix(0, 70, 15)]);
  assert.equal(viaPsz.length, 1);
  assert.equal(viaPsz[0].lastHome.psz_id, KITCHEN);
});

test('crossing within 2 m of the scripted point, quality good, weight 1', () => {
  const fixes = [fix(0, 0, 0), fix(10, 5, 10), fix(16, 5, 13), fix(26, 5, 16), fix(34, 5, 19), fix(45, 5, 22)];
  const [ep] = detect(fixes);
  const r = esc.analyzeEpisode(fixes, ep, yard, S, {});
  assert.ok(distanceM(r.crossing, ll(20, 5)) <= 2, JSON.stringify(r.crossing));
  assert.ok(Math.abs(r.crossing.perimeter_m - 65) < 0.5);
  assert.equal(r.quality, 'good');
  assert.equal(r.weight, 1);
  assert.equal(r.gap_s, 3);
  assert.ok(Math.abs(r.segment_m - 10) < 0.05);
  assert.equal(r.acc, 5);
  assert.equal(r.a.t, T0 + 13);
  assert.equal(r.b.t, T0 + 16);
  assert.equal(r.firstOutside.t, T0 + 19);
  assert.ok(Math.abs(r.distance_m - 14) < 0.1);
  assert.equal(r.note, null);
});

test('quality classes follow the thresholds', () => {
  const q = ({ aAcc = 5, bx = 30, bdt = 10, bAcc = 5 } = {}) => {
    const fixes = [fix(0, 0, -50), fix(15, 0, 0, { acc: aAcc }), fix(bx, 0, bdt, { acc: bAcc }), fix(100, 0, bdt + 5), fix(110, 0, bdt + 10)];
    const [ep] = detect(fixes);
    return esc.analyzeEpisode(fixes, ep, yard, S, {});
  };
  assert.equal(q({ bdt: 30, aAcc: 15, bAcc: 15 }).quality, 'good');
  assert.equal(q({ bdt: 31 }).quality, 'fair');
  assert.equal(q({ aAcc: 16 }).quality, 'fair');
  assert.equal(q({ bx: 41 }).quality, 'fair');                 // segment 26 m
  assert.equal(q({ bdt: 180, aAcc: 30, bAcc: 30 }).quality, 'fair');
  assert.equal(q({ bdt: 181 }).quality, 'poor');
  assert.equal(q({ aAcc: 31 }).quality, 'poor');
  assert.equal(q({ bx: 96 }).quality, 'poor');                 // segment 81 m
  assert.equal(q({ bdt: 600 }).quality, 'poor');
  const none = q({ bdt: 601 });
  assert.equal(none.quality, 'none');
  assert.equal(none.crossing, null);
  assert.equal(none.weight, 0);
  assert.equal(q({ bdt: 31 }).weight, 0.5);
  assert.equal(q({ bdt: 181 }).weight, 0.2);
});

test('a psz last home fix gives quality none with the note and the first fix outside', () => {
  const fixes = [pszFix(5, 5, 0), pszFix(5, 5, 60), fix(0, 60, 120), fix(0, 70, 125)];
  const [ep] = detect(fixes);
  const r = esc.analyzeEpisode(fixes, ep, yard, S, { [KITCHEN]: 'Kitchen' });
  assert.equal(r.quality, 'none');
  assert.equal(r.crossing, null);
  assert.equal(r.note, 'dog left Wi-Fi zone Kitchen: no GPS before the exit');
  assert.equal(r.firstOutside.t, T0 + 120);
  assert.equal(r.gap_s, 60);
});

function threeEscapes() {
  const fixes = [];
  for (let k = 0; k < 3; k++) {
    const b = k * 1000, y = 4 + k;
    fixes.push(fix(0, 0, b), fix(16, y, b + 10), fix(26, y, b + 13), fix(34, y, b + 16), fix(45, y, b + 19), fix(0, 0, b + 40));
  }
  const stored = detect(fixes).map((e, i) => ({ id: i + 1, t_inside: e.t_inside, t_outside: e.t_outside, note: null, dismissed: 0 }));
  return { fixes, stored };
}

test('heat peak within 3 m of the crossing for 3 escapes through the same spot', () => {
  const { fixes, stored } = threeEscapes();
  assert.equal(stored.length, 3);
  const r = esc.analyze({ fixes, poly: yard, settings: S, now: NOW, stored, pszNames: {} });
  assert.equal(r.episodes.length, 3);
  assert.ok(r.episodes.every((e) => e.quality === 'good' && e.id >= 1 && e.missing === false));
  assert.equal(r.strip.length, 80);
  assert.equal(Math.max(...r.strip.map((s) => s.value)), 1);
  assert.ok(r.peaks.length >= 1 && r.peaks.length <= 3);
  assert.ok(distanceM(r.peaks[0], ll(20, 5)) <= 3, JSON.stringify(r.peaks[0]));
  assert.equal(r.peaks[0].count, 3);
  assert.ok(r.peaks[0].widthM >= 3 && r.peaks[0].widthM <= 12, String(r.peaks[0].widthM));
  stored[2].dismissed = 1;
  assert.equal(esc.analyze({ fixes, poly: yard, settings: S, now: NOW, stored, pszNames: {} }).peaks[0].count, 2);
});

test('heat strip without crossings is flat with no peaks; a stored row without a detected episode is marked missing', () => {
  const r = esc.analyze({ fixes: [fix(0, 0, 0)], poly: yard, settings: S, now: NOW, stored: [{ id: 9, t_inside: T0, t_outside: T0 + 5, note: 'x', dismissed: 0 }], pszNames: {} });
  assert.ok(r.strip.every((s) => s.value === 0));
  assert.deepEqual(r.peaks, []);
  assert.equal(r.episodes[0].missing, true);
  assert.equal(r.episodes[0].quality, 'none');
  assert.equal(r.episodes[0].note, 'x');
});

test('reconcileStored: insert missing confirmed episodes, remove unannotated ones that no longer qualify', () => {
  const detected = [{ t_inside: 90, t_outside: 100, confirmed: true }, { t_inside: 290, t_outside: 300, confirmed: true }, { t_inside: 390, t_outside: 400, confirmed: false }];
  const stored = [{ id: 1, t_outside: 100, note: null, dismissed: 0 }, { id: 2, t_outside: 200, note: null, dismissed: 0 },
    { id: 3, t_outside: 250, note: 'gate', dismissed: 0 }, { id: 4, t_outside: 260, note: null, dismissed: 1 }, { id: 5, t_outside: 900, note: null, dismissed: 0 }];
  assert.deepEqual(esc.reconcileStored(detected, stored, 0, 500), { insert: [{ t_inside: 290, t_outside: 300 }], remove: [2] });
});
