import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startMock } from './mock/server.js';
import { TID, IDS, until } from './helpers.js';

const TOKEN = '123456:TEST-TOKEN-abc';
async function withMock(t, opts) {
  const m = await startMock({ keepAliveMs: 100, ...opts });
  t.after(() => m.close());
  return m;
}
async function auth(m) {
  const r = await fetch(`${m.url}/graph/4/auth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tractive-client': 'c1' },
    body: JSON.stringify({ platform_email: 'a@b.c', platform_token: 'pw', grant_type: 'tractive' }),
  });
  const j = await r.json();
  return { 'x-tractive-client': 'c1', 'x-tractive-user': j.user_id, authorization: `Bearer ${j.access_token}`, 'content-type': 'application/json' };
}
const g = (m, h, p, init = {}) => fetch(`${m.url}/graph/4/${p}`, { ...init, headers: { ...h, ...init.headers } });
async function openChannel(m, h) {
  const ctrl = new AbortController();
  const res = await fetch(`${m.url}/channel/3/channel`, { method: 'POST', headers: h, signal: ctrl.signal });
  const msgs = [];
  const done = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const c of res.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) msgs.push(JSON.parse(line));
        }
      }
    } catch { /* aborted */ }
  })();
  return { res, msgs, done, close: () => ctrl.abort() };
}

test('graph needs a token from auth/token; the runtime tracker is in the yard on GPS', async (t) => {
  const m = await withMock(t);
  assert.equal((await fetch(`${m.url}/graph/4/tracker/${TID}`)).status, 401);
  const h = await auth(m);
  assert.equal(h['x-tractive-user'], IDS.user);
  const res = await g(m, h, `tracker/${TID}`);
  assert.equal(res.status, 200);
  const tr = await res.json();
  assert.equal(tr._id, TID);
  assert.equal(tr.state, 'OPERATIONAL');
  assert.equal(tr.power_saving_zone_id, null);
  assert.deepEqual((await (await g(m, h, `user/${IDS.user}/trackers`)).json()).map((x) => x._id), [TID]);
});

test('bulk hydrates geofences and command states; zones by id', async (t) => {
  const m = await withMock(t);
  const h = await auth(m);
  const stubs = await (await g(m, h, `tracker/${TID}/geofences`)).json();
  assert.deepEqual(stubs.map((s) => s._id), [IDS.yard]);
  const body = [{ _type: 'geofence', _id: IDS.yard }, { _type: 'tracker_command_state', _id: `${TID.toLowerCase()}_pos_request` }, { _type: 'geofence', _id: 'f'.repeat(24) }];
  const out = await (await g(m, h, 'bulk?partial=1', { method: 'POST', body: JSON.stringify(body) })).json();
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Yard');
  assert.equal(out[0].coords.length, 4);
  assert.equal(out[1].timeout, 30);
  const zones = await (await g(m, h, `tracker/${TID}/power_saving_zones`)).json();
  assert.deepEqual(zones.map((z) => z._id), [IDS.pszIn, IDS.pszOut]);
  assert.equal((await (await g(m, h, `power_saving_zone/${IDS.pszIn}`)).json()).name, 'Kitchen');
  const share = await (await g(m, h, `public_share/${IDS.share}`)).json();
  assert.match(share.share_link, /^https:\/\/example\.invalid\//);
});

test('geofence create, versioned update (409 when stale) and delete', async (t) => {
  const m = await withMock(t);
  const h = await auth(m);
  const body = { name: 'Test', shape: 'CIRCLE', coords: [[41, 2]], radius: 30, fence_type: 'SAFE', active: true, icon: 'TRACTIVE' };
  const created = await (await g(m, h, `geofence/tracker/${TID}/geofences`, { method: 'POST', body: JSON.stringify(body) })).json();
  assert.match(created._id, /^[a-f0-9]{24}$/);
  assert.equal((await g(m, h, `geofence/${created._id}?_version=bogus`, { method: 'PUT', body: JSON.stringify({ ...body, name: 'X' }) })).status, 409);
  const upd = await g(m, h, `geofence/${created._id}?_version=${created._version}`, { method: 'PUT', body: JSON.stringify({ ...body, name: 'Renamed' }) });
  assert.equal(upd.status, 200);
  const after = await upd.json();
  assert.equal(after.name, 'Renamed');
  assert.notEqual(after._version, created._version);
  assert.equal((await g(m, h, `geofence/${created._id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await g(m, h, `tracker/${TID}/geofences`)).json()).map((s) => s._id), [IDS.yard]);
});

test('channel: handshake, full status, keep-alives, pushed fixes, command echo, REST history', async (t) => {
  const m = await withMock(t);
  const h = await auth(m);
  const ch = await openChannel(m, h);
  t.after(ch.close);
  assert.equal(ch.res.status, 200);
  await until(() => ch.msgs.some((x) => x.message === 'keep-alive'));
  assert.equal(ch.msgs[0].message, 'handshake');
  const st = ch.msgs[1];
  assert.equal(st.message, 'tracker_status');
  assert.equal(st.tracker_id, TID);
  assert.equal(st.position.sensor_used, 'GPS');
  assert.equal(st.power_saving_zone_id, null);
  assert.equal(st.tracker_state_reason, null);
  await m.post('/__mock/fix', { lat: 41.0001, lng: 2.0001, acc: 7, sensor: 'GPS', dtS: -5 });
  const fix = await until(() => ch.msgs.find((x) => x.position?.accuracy === 7));
  assert.deepEqual(fix.position.latlong, [41.0001, 2.0001]);
  assert.ok(Math.abs(fix.position.time - (Math.floor(Date.now() / 1000) - 5)) <= 1);
  await m.post('/__mock/fix', { lat: 41.000045, lng: 1.99994, acc: 30, sensor: 'KNOWN_WIFI', pszId: IDS.pszIn });
  const wifi = await until(() => ch.msgs.find((x) => x.position?.power_saving_zone_id === IDS.pszIn));
  assert.equal(wifi.power_saving_zone_id, IDS.pszIn);
  assert.equal(wifi.tracker_state_reason, 'POWER_SAVING');
  assert.equal(wifi.hardware.power_saving_zone_id, IDS.pszIn);
  const cmd = await (await g(m, h, `tracker/${TID}/command/live_tracking/on`)).json();
  assert.equal(cmd.pending, true);
  const live = await until(() => ch.msgs.find((x) => x.live_tracking?.active === true));
  assert.ok(live.live_tracking.remaining > 0);
  const now = Math.floor(Date.now() / 1000);
  const hist = await (await g(m, h, `tracker/${TID}/positions?time_from=${now - 3600}&time_to=${now + 60}&format=json_segments`)).json();
  assert.ok(hist.flat().some((p) => p.pos_uncertainty === 7));
  await m.post('/__mock/tracker', { patch: { charging_state: 'CHARGING', hardware: { battery_level: 55 } } });
  const patched = await until(() => ch.msgs.find((x) => x.charging_state === 'CHARGING'));
  assert.equal(patched.hardware.battery_level, 55);
  assert.equal((await (await g(m, h, `tracker/${TID}`)).json()).charging_state, 'CHARGING');
});

test('channel drop ends the stream; silence stops writes on the streams open at that moment only', async (t) => {
  const m = await withMock(t);
  const h = await auth(m);
  const a = await openChannel(m, h);
  t.after(a.close);
  await until(() => a.msgs.length >= 3);
  await m.post('/__mock/channel/silence', { seconds: 0.5 });
  await new Promise((r) => setTimeout(r, 50));
  const n = a.msgs.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.msgs.length, n);
  const b = await openChannel(m, h);
  t.after(b.close);
  await until(() => b.msgs.some((x) => x.message === 'keep-alive'));
  await until(() => a.msgs.length > n, { timeout: 2000 });
  await m.post('/__mock/channel/drop', {});
  await Promise.race([Promise.all([a.done, b.done]), new Promise((_, rej) => setTimeout(() => rej(new Error('streams still open')), 2000))]);
});

test('fail rules: status, retry-after and body, consumed in order; requests are recorded', async (t) => {
  const m = await withMock(t);
  const h = await auth(m);
  await m.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}`, status: 429, times: 1, retryAfter: 2 });
  const r1 = await g(m, h, `tracker/${TID}`);
  assert.equal(r1.status, 429);
  assert.equal(r1.headers.get('retry-after'), '2');
  assert.equal((await g(m, h, `tracker/${TID}`)).status, 200);
  await m.post('/__mock/fail', { match: 'PUT /graph/4/tracker', status: 400, times: 1, body: { code: 4002, message: 'invalid' } });
  const r2 = await g(m, h, `tracker/${TID}/power_mode`, { method: 'PUT', body: '{"power_mode":"X"}' });
  assert.equal(r2.status, 400);
  assert.deepEqual(await r2.json(), { code: 4002, message: 'invalid' });
  const log = await m.get('/__mock/requests?host=graph');
  const put = log.find((r) => r.method === 'PUT' && r.path === `/graph/4/tracker/${TID}/power_mode`);
  assert.deepEqual(put.body, { power_mode: 'X' });
  assert.equal(put.status, 400);
  assert.equal(typeof put.at, 'number');
  assert.ok(log.every((r) => r.host === 'graph'));
});

test('aps health, timeline with injected events (newest first, filtered by types), media', async (t) => {
  const m = await withMock(t);
  const h = await auth(m);
  const health = await (await fetch(`${m.url}/aps/api/1/pet/${IDS.pet}/health/overview`, { headers: h })).json();
  assert.equal(health.activity.hourlyDistribution.length, 24);
  await m.post('/__mock/timeline', { event: { type: 'safezoneExit', zoneName: 'Yard' } });
  const tl = await (await fetch(`${m.url}/timeline/api/1/events?petId=${IDS.pet}&timezone=Europe/Madrid&types=safezoneExit`, { headers: h })).json();
  assert.equal(tl.events[0].type, 'safezoneExit');
  assert.ok(Date.parse(tl.events[0].occurredAt) > Date.now() - 5000);
  assert.ok(tl.events.every((e) => e.type === 'safezoneExit'));
  assert.equal(typeof tl.paging.nextUrl, 'string');
  const img = await g(m, h, `media/resource/${IDS.picture}.jpg`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.ok((await img.arrayBuffer()).byteLength > 0);
});

test('telegram: token check, long poll, recorded sends, live location edits, reset', async (t) => {
  const m = await withMock(t);
  const tg = (method, body = {}, token = TOKEN) => fetch(`${m.url}/telegram/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());
  assert.equal((await tg('getMe', {}, 'wrong')).ok, false);
  assert.equal((await tg('getMe')).result.username, 'opentractive_test_bot');
  const poll = tg('getUpdates', { offset: 0, timeout: 5 });
  await m.post('/__mock/telegram/update', { update: { message: { message_id: 1, chat: { id: 1001, type: 'private' }, text: '/help' } } });
  const got = await poll;
  assert.equal(got.result.length, 1);
  const uid = got.result[0].update_id;
  assert.equal(typeof got.result[0].message.date, 'number');
  assert.deepEqual((await tg('getUpdates', { offset: uid + 1, timeout: 0 })).result, []);
  const mid = (await tg('sendLocation', { chat_id: 1001, latitude: 41, longitude: 2, live_period: 86400 })).result.message_id;
  assert.equal((await tg('editMessageLiveLocation', { chat_id: 1001, message_id: mid, latitude: 41, longitude: 2 })).description, 'Bad Request: message is not modified');
  assert.equal((await tg('editMessageLiveLocation', { chat_id: 1001, message_id: mid, latitude: 41.1, longitude: 2 })).ok, true);
  await tg('stopMessageLiveLocation', { chat_id: 1001, message_id: mid });
  assert.match((await tg('editMessageLiveLocation', { chat_id: 1001, message_id: mid, latitude: 41.2, longitude: 2 })).description, /message can't be edited/);
  const sent = await m.get('/__mock/telegram/sent');
  assert.deepEqual(sent.map((s) => s.method), ['sendLocation', 'editMessageLiveLocation', 'stopMessageLiveLocation']);
  assert.equal(sent[0].result.message_id, mid);
  await m.post('/__mock/reset', {});
  assert.deepEqual(await m.get('/__mock/telegram/sent'), []);
  assert.deepEqual(await m.get('/__mock/requests'), []);
});

test('fixtures are synthetic: every coordinate lies within 0.05 degrees of 41.0, 2.0', () => {
  const dir = new URL('./mock/fixtures/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 25);
  let pairs = 0;
  const walk = (v, key) => {
    if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') && /latlong|coords|home_location/.test(key)) {
      pairs++;
      assert.ok(Math.abs(v[0] - 41) < 0.05 && Math.abs(v[1] - 2) < 0.05, `${key}: ${v}`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const f of files) walk(JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')), '');
  assert.ok(pairs >= 10, String(pairs));
});
