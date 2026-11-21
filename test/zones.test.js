import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createTractive } from '../src/tractive.js';
import { createZoneSwitch, OFF_MARKER, isOff, ssidOf } from '../src/zones.js';
import { startMock } from './mock/server.js';
import { tmpDir, fakeClock, TID, IDS } from './helpers.js';

const KITCHEN = IDS.pszIn, NEIGHBOUR = IDS.pszOut, SSID = 'a0:00:00:00:00:01';

async function setup(t, { inWindow = false, settings = {}, flags } = {}) {
  const mock = await startMock({ keepAliveMs: 100 });
  const dir = tmpDir('zones');
  const store = new Store(':memory:');
  const clock = fakeClock();
  const tractive = createTractive({
    graphUrl: `${mock.url}/graph/4`, channelUrl: `${mock.url}/channel/3/channel`, apsUrl: `${mock.url}/aps/api/1`,
    timelineUrl: `${mock.url}/timeline/api/1`, clientId: '625e533dc3c3b41c28a669f0', email: 'o@example.com', password: 'pw',
    tokenFile: path.join(dir, 'tok.json'), tz: 'UTC', minGapMs: 0, penaltyBaseMs: 50, log: () => {},
  });
  const refresh = async () => store.setRaw(`psz:${TID}`, await tractive.powerSavingZones(TID));
  await refresh();
  const alerts = [];
  const win = { on: inWindow };
  const conf = { yardWatch: { enabled: true, autoZones: true, ...settings } };
  const zs = createZoneSwitch({
    store, tractive, trackerId: TID, zones: () => store.getRaw(`psz:${TID}`), refresh, now: clock.now,
    inWindow: () => win.on, settings: () => conf,
    flags: flags ?? (() => (store.getRaw(`psz:${TID}`) ?? []).map((z) => ({ id: z._id, name: z.name, coversYard: z._id === KITCHEN, off: isOff(z) }))),
    raise: (kind, opts) => alerts.push({ kind, ...opts }),
  });
  const zoneId = async (id) => (await tractive.powerSavingZone(id)).zone_id;
  t.after(async () => { tractive.close(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { mock, store, tractive, zs, clock, alerts, win, conf, zoneId };
}
const puts = async (mock) => (await mock.get('/__mock/requests?host=graph')).filter((r) => r.method === 'PUT' && r.path.includes('/power_saving_zone/'));

test('marker helpers: off iff the zone_id ends with the marker, the SSID strips it', () => {
  assert.equal(isOff({ zone_id: `home${OFF_MARKER}` }), true);
  assert.equal(isOff({ zone_id: 'home' }), false);
  assert.equal(ssidOf({ zone_id: `home${OFF_MARKER}` }), 'home');
  assert.equal(ssidOf({ zone_id: 'home' }), 'home');
});

test('switch off renames the zone, stores the SSID first, is idempotent; switch on restores it', async (t) => {
  const { zs, store, mock, zoneId } = await setup(t);
  const st = await zs.switchZone(KITCHEN, false, 'web');
  assert.equal(st.off, true);
  assert.equal(await zoneId(KITCHEN), SSID + OFF_MARKER);
  assert.equal(store.getKv('zoneSwitch').zones[KITCHEN].ssid, SSID);
  await zs.switchZone(KITCHEN, false, 'web'); // already off: no second write, no double marker
  assert.equal(await zoneId(KITCHEN), SSID + OFF_MARKER);
  assert.equal((await puts(mock)).length, 1);
  const back = await zs.switchZone(KITCHEN, true, 'web');
  assert.equal(back.off, false);
  assert.equal(await zoneId(KITCHEN), SSID);
  assert.equal(store.getKv('zoneSwitch').zones[KITCHEN], undefined);
  assert.equal(await zoneId(NEIGHBOUR), 'a0:00:00:00:00:02'); // the other zone is untouched
});

test('switch on restores from the marker when the stored record is lost', async (t) => {
  const { zs, store, zoneId } = await setup(t);
  await zs.switchZone(KITCHEN, false, 'web');
  store.delKv('zoneSwitch');
  await zs.switchZone(KITCHEN, true, 'web');
  assert.equal(await zoneId(KITCHEN), SSID);
});

test('a version conflict re-reads the zone once and succeeds', async (t) => {
  const { zs, tractive, zoneId } = await setup(t);
  const z = await tractive.powerSavingZone(KITCHEN);
  await tractive.updatePowerSavingZone({ ...z, name: 'Kitchen' }); // bumps _version behind the switch's back
  const real = tractive.powerSavingZone;
  let first = true;
  tractive.powerSavingZone = async (id) => { if (first) { first = false; return z; } return real(id); }; // a stale read
  await zs.switchZone(KITCHEN, false, 'web');
  assert.equal(await zoneId(KITCHEN), SSID + OFF_MARKER);
});

test('the audit log names the zone but never the Wi-Fi name; an unknown zone is refused', async (t) => {
  const { zs, store } = await setup(t);
  await zs.switchZone(KITCHEN, false, 'web');
  const row = store.commands(1)[0];
  assert.equal(row.action, 'zone:off');
  assert.equal(row.params.zone, KITCHEN);
  assert.ok(!JSON.stringify(row).includes(SSID));
  await assert.rejects(zs.switchZone('5f1a000000000000000000ff', false, 'web'), /unknown zone/);
});

test('verification: a GPS fix after the switch confirms it once; Wi-Fi pins and older fixes do not', async (t) => {
  const { zs, clock, alerts } = await setup(t);
  await zs.switchZone(KITCHEN, false, 'web');
  const t0 = Math.floor(clock.now() / 1000);
  zs.onFix({ tracker_id: TID, t: t0 + 30, sensor: 'KNOWN_WIFI', psz_id: KITCHEN, acc: 30 });
  zs.onFix({ tracker_id: TID, t: t0 - 60, sensor: 'GPS', acc: 5 });
  zs.onFix({ tracker_id: 'OTHER001', t: t0 + 60, sensor: 'GPS', acc: 5 });
  assert.equal(zs.status().find((z) => z.id === KITCHEN).confirmedAt, null);
  zs.onFix({ tracker_id: TID, t: t0 + 90, sensor: 'GPS', acc: 6 });
  zs.onFix({ tracker_id: TID, t: t0 + 95, sensor: 'GPS', acc: 4 });
  const k = zs.status().find((z) => z.id === KITCHEN);
  assert.equal(k.confirmedAt, t0 + 90);
  assert.equal(k.confirmedAcc, 6);
  assert.equal(alerts.filter((a) => a.kind === 'zone_confirmed').length, 1);
});

test('automatic mode: a window start switches off the zones covering the yard once; the end restores only those', async (t) => {
  const { zs, win, mock, zoneId } = await setup(t);
  await zs.tick(); // outside the window at start: nothing to restore
  assert.equal((await puts(mock)).length, 0);
  win.on = true;
  await zs.tick();
  await zs.tick(); // same state: no second write
  assert.equal(await zoneId(KITCHEN), SSID + OFF_MARKER);
  assert.equal(await zoneId(NEIGHBOUR), 'a0:00:00:00:00:02'); // does not cover the yard
  assert.equal(zs.status().find((z) => z.id === KITCHEN).auto, true);
  assert.equal((await puts(mock)).length, 1);
  win.on = false;
  await zs.tick();
  assert.equal(await zoneId(KITCHEN), SSID);
  assert.equal((await puts(mock)).length, 2);
});

test('automatic mode leaves manual switches alone and restores auto ones after a restart', async (t) => {
  const { zs, store, tractive, win, zoneId } = await setup(t);
  await zs.switchZone(NEIGHBOUR, false, 'web'); // manual
  win.on = true;
  await zs.tick(); // auto-off Kitchen
  const again = createZoneSwitch({ // a restart outside the window, same store
    store, tractive, trackerId: TID, zones: () => store.getRaw(`psz:${TID}`),
    refresh: async () => store.setRaw(`psz:${TID}`, await tractive.powerSavingZones(TID)),
    inWindow: () => false, settings: () => ({ yardWatch: { enabled: true, autoZones: true } }), flags: () => [],
  });
  await again.tick();
  assert.equal(await zoneId(KITCHEN), SSID);
  assert.equal(await zoneId(NEIGHBOUR), `a0:00:00:00:00:02${OFF_MARKER}`);
});

test('automatic mode off: nothing is switched in a window', async (t) => {
  const { zs, win, conf, mock } = await setup(t);
  conf.yardWatch.autoZones = false;
  win.on = true;
  await zs.tick();
  assert.equal((await puts(mock)).length, 0);
});

test('a Wi-Fi name changed elsewhere during the switch is kept: the conflict is decided again from a fresh read', async (t) => {
  const { zs, tractive, store, zoneId } = await setup(t);
  const real = tractive.updatePowerSavingZone;
  let first = true;
  tractive.updatePowerSavingZone = async (z) => {
    if (first) { // someone renames the Wi-Fi between our read and our write
      first = false;
      const fresh = await tractive.powerSavingZone(KITCHEN);
      await real({ ...fresh, zone_id: 'NewWifi' });
    }
    return real(z);
  };
  await zs.switchZone(KITCHEN, false, 'web');
  assert.equal(await zoneId(KITCHEN), `NewWifi${OFF_MARKER}`);
  assert.equal(store.getKv('zoneSwitch').zones[KITCHEN].ssid, 'NewWifi');
  await zs.switchZone(KITCHEN, true, 'web');
  assert.equal(await zoneId(KITCHEN), 'NewWifi');
});

test('restore works from the stored record even when the cached zone list is stale or not loaded', async (t) => {
  const { zs, store, win, zoneId } = await setup(t);
  win.on = true;
  await zs.tick(); // auto-off Kitchen
  const stale = store.getRaw(`psz:${TID}`).map((z) => ({ ...z, zone_id: z.zone_id.replace(OFF_MARKER, '') }));
  store.setRaw(`psz:${TID}`, stale); // the refresh after the write "failed": the cache still shows the zone on
  win.on = false;
  await zs.tick();
  assert.equal(await zoneId(KITCHEN), SSID);
  assert.equal(store.getKv('zoneSwitch').zones[KITCHEN], undefined);
});

test('a manual switch takes a zone over: switched off by hand it stays off after the window, switched on it stays on', async (t) => {
  const { zs, win, zoneId } = await setup(t, {
    flags: undefined,
  });
  win.on = true;
  await zs.tick(); // auto-off Kitchen
  await zs.switchZone(KITCHEN, false, 'telegram:1'); // the user also wants it off: now the user's
  win.on = false;
  await zs.tick();
  assert.equal(await zoneId(KITCHEN), SSID + OFF_MARKER);
  await zs.switchZone(KITCHEN, true, 'web');
  win.on = true;
  await zs.tick(); // a new window: switched off again automatically
  await zs.switchZone(KITCHEN, true, 'web'); // the user switches it back on inside the window
  await zs.tick();
  await zs.tick();
  assert.equal(await zoneId(KITCHEN), SSID); // not switched off again in this window
});

test('overlapping ticks across a window end leave no zone off', async (t) => {
  const { zs, win, tractive, zoneId } = await setup(t, {
    flags: () => [{ id: KITCHEN, coversYard: true, off: false }, { id: NEIGHBOUR, coversYard: true, off: false }],
  });
  const real = tractive.updatePowerSavingZone;
  tractive.updatePowerSavingZone = async (z) => { await new Promise((r) => setTimeout(r, 150)); return real(z); };
  win.on = true;
  const a = zs.tick();
  await new Promise((r) => setTimeout(r, 50));
  win.on = false;
  const b = zs.tick(); // overlaps the first: ignored
  await Promise.all([a, b]);
  await zs.tick(); // the window end: restores every auto zone
  assert.equal(await zoneId(KITCHEN), SSID);
  assert.equal(await zoneId(NEIGHBOUR), 'a0:00:00:00:00:02');
});

test('one zone that keeps failing does not stop the others from being restored; three failures raise the rule severity', async (t) => {
  const { zs, win, tractive, alerts, zoneId, clock } = await setup(t, {
    flags: () => [{ id: KITCHEN, coversYard: true, off: false }, { id: NEIGHBOUR, coversYard: true, off: false }],
  });
  win.on = true;
  await zs.tick();
  const real = tractive.powerSavingZone;
  tractive.powerSavingZone = async (id) => { if (id === KITCHEN) throw new Error('boom'); return real(id); };
  win.on = false;
  await zs.tick();
  assert.equal(await real(NEIGHBOUR).then((z) => z.zone_id), 'a0:00:00:00:00:02');
  for (let i = 0; i < 2; i++) { clock.advance(301e3); await zs.tick(); }
  const failed = alerts.filter((a) => a.kind === 'zone_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, undefined); // the configured rule severity applies
  tractive.powerSavingZone = real;
  clock.advance(301e3);
  await zs.tick();
  assert.equal(await zoneId(KITCHEN), SSID);
});

const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('locate: switches the zones covering the yard off until the first GPS fix, then back on', async (t) => {
  const { zs, clock, alerts, zoneId } = await setup(t);
  const loc = await zs.locate('web');
  assert.deepEqual(loc.zones, [KITCHEN]);
  assert.equal(await zoneId(KITCHEN), SSID + OFF_MARKER);
  assert.equal(await zoneId(NEIGHBOUR), 'a0:00:00:00:00:02');
  assert.equal((await zs.locate('web')).since, loc.since); // a second press while running changes nothing
  const t0 = Math.floor(clock.now() / 1000);
  zs.onFix({ tracker_id: TID, t: t0 + 20, sensor: 'KNOWN_WIFI', psz_id: KITCHEN, acc: 30 }); // a Wi-Fi pin is no GPS fix
  assert.ok(zs.locateStatus().active);
  zs.onFix({ tracker_id: TID, t: t0 + 40, sensor: 'GPS', acc: 7, lat: 41, lng: 2 });
  await waitFor(async () => (await zoneId(KITCHEN)) === SSID);
  assert.equal(zs.locateStatus().active, null);
  assert.equal(zs.locateStatus().last.reason, 'fix');
  assert.equal(zs.locateStatus().last.acc, 7);
  assert.ok(alerts.some((a) => a.kind === 'zone_confirmed' && a.title.startsWith('Located')));
});

test('locate: no GPS fix within 2 h switches the zones back on; a zone the user took over is left alone', async (t) => {
  const { zs, clock, alerts, zoneId } = await setup(t, {
    flags: () => [{ id: KITCHEN, coversYard: true, off: false }, { id: NEIGHBOUR, coversYard: true, off: false }],
  });
  await zs.locate('web');
  await zs.switchZone(NEIGHBOUR, false, 'telegram:1'); // already off by the locate: the user now owns it
  clock.advance(2 * 3600e3 + 1000);
  await zs.tick();
  assert.equal(await zoneId(KITCHEN), SSID);
  assert.equal(await zoneId(NEIGHBOUR), `a0:00:00:00:00:02${OFF_MARKER}`);
  assert.equal(zs.locateStatus().last.reason, 'timeout');
  assert.ok(alerts.some((a) => a.kind === 'zone_failed'));
});

test('locate: refused with 409 when no zone covers the yard or holds the tracker', async (t) => {
  const { zs } = await setup(t, { flags: () => [] });
  await assert.rejects(zs.locate('web'), (e) => e.status === 409);
});
