import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { labCheck, redactSecrets } from '../src/server.js';
import { startMock } from './mock/server.js';
import { startTestServer, envFor, tmpDir, until, TID, IDS, square, asPair } from './helpers.js';

const BOT = '123456:TEST-TOKEN-abc';
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com; frame-ancestors 'none'";

async function setup(t, { env = {} } = {}) {
  const mock = await startMock({ keepAliveMs: 200 });
  const dir = tmpDir('server');
  const store = new Store(':memory:');
  const app = createApp({
    env: envFor(mock, env), store, dataDir: dir, log: () => {},
    tractiveOptions: { minGapMs: 0, penaltyBaseMs: 20, penaltyMaxMs: 100, random: () => 0.5 }, telegramOptions: { pollTimeoutS: 1, minIntervalMs: 20 },
  });
  await app.start();
  await app.ready;
  const srv = await startTestServer({ store, app });
  t.after(async () => { await srv.close(); await app.stop(); await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { mock, store, app, dir, ...srv };
}
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });

const ROUTES = [
  ['GET', '/api/state'], ['GET', '/api/stream'], ['POST', `/api/tracker/${TID}/command`], ['PUT', `/api/tracker/${TID}/power-mode`],
  ['PUT', `/api/tracker/${TID}/live-timeout`], ['GET', `/api/tracker/${TID}`], ['POST', `/api/tracker/${TID}/reachable-notification`],
  ['POST', `/api/tracker/${TID}/share`], ['DELETE', `/api/share/${IDS.share}`], ['DELETE', `/api/psz/${IDS.pszIn}`], ['POST', `/api/psz/${IDS.pszIn}/switch`], ['POST', '/api/locate'], ['POST', '/api/zones/yard'],
  ['GET', `/api/tracker/${TID}/geofences`], ['POST', `/api/tracker/${TID}/geofences`], ['PUT', `/api/geofences/${IDS.yard}`], ['DELETE', `/api/geofences/${IDS.yard}`],
  ['GET', '/api/positions'], ['GET', '/api/positions.gpx'], ['POST', '/api/positions/backfill'], ['GET', '/api/escapes'], ['POST', '/api/escapes/recompute'],
  ['PATCH', '/api/escapes/1'], ['GET', '/api/alerts'], ['POST', '/api/alerts/1/ack'], ['POST', '/api/alerts/1/false-alarm'], ['GET', '/api/settings'],
  ['PUT', '/api/settings'], ['POST', '/api/chase'], ['GET', `/api/pet/${IDS.pet}`], ['PUT', `/api/pet/${IDS.pet}`], ['GET', `/api/pet/${IDS.pet}/photo`],
  ['POST', '/api/walk'], ['POST', '/api/tractive/retry-login'], ['GET', '/api/tractive/notifications'], ['PUT', '/api/tractive/notifications'],
  ['GET', '/api/telegram'], ['POST', '/api/telegram/pairing'], ['DELETE', '/api/telegram/chats/1001'], ['PUT', '/api/telegram/chats/1001'],
  ['POST', '/api/telegram/test'], ['GET', '/api/lab/raw'], ['GET', '/api/lab/channel'], ['GET', '/api/lab/fields'], ['POST', '/api/lab/request'],
  ['GET', '/api/commands'],
];

test('every api route needs the session; every mutating method needs origin, json and the size cap', async (t) => {
  const { base, request } = await setup(t);
  for (const [method, p] of ROUTES) {
    const res = await fetch(base + p, { method, headers: { origin: base, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(res.status, 401, `${method} ${p}`);
    assert.deepEqual(await res.json(), { error: 'login required' });
  }
  const targets = { POST: '/api/chase', PUT: '/api/settings', DELETE: `/api/geofences/${IDS.yard}`, PATCH: '/api/escapes/1' };
  for (const [method, p] of Object.entries(targets)) {
    assert.equal((await request(p, { method, headers: { origin: 'http://evil.example' }, body: '{}' })).status, 403, `${method} origin`);
    assert.equal((await request(p, { method, headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415, `${method} type`);
    assert.equal((await request(p, { method, body: JSON.stringify({ x: 'y'.repeat(17 * 1024) }) })).status, 413, `${method} size`);
    assert.equal((await request(p, { method, body: '{' })).status, 400, `${method} json`);
  }
});

test('login cookie ot_session, limiter, security headers and the map CSP', async (t) => {
  const { base } = await setup(t);
  const login = (password) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password }) });
  const ok = await login('pw-test');
  assert.equal(ok.status, 204);
  assert.match(ok.headers.get('set-cookie'), /^ot_session=\d+\.[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  for (let i = 0; i < 5; i++) assert.equal((await login('nope')).status, 401);
  assert.equal((await login('pw-test')).status, 429);
  for (const r of [await fetch(`${base}/healthz`), await fetch(`${base}/api/state`), await fetch(`${base}/`, { redirect: 'manual' })]) {
    assert.equal(r.headers.get('content-security-policy'), CSP);
    assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login?next=%2F');
});

test('healthz reports tractive and channel state and fails only when the database fails', async (t) => {
  const { base, store, request } = await setup(t);
  await until(async () => (await (await fetch(`${base}/healthz`)).json()).channel === 'connected');
  const h = await json(await fetch(`${base}/healthz`));
  assert.equal(h.status, 200);
  assert.deepEqual(h.body, { ok: true, tractive: 'ok', channel: 'connected' });
  const st = await json(await request('/api/state'));      // the Lab queue card shows the channel reconnect count
  assert.equal(st.body.channel.connected, true);
  assert.equal(typeof st.body.channel.reconnects, 'number');
  store.close();
  const bad = await json(await fetch(`${base}/healthz`));
  assert.equal(bad.status, 503);
  assert.equal(bad.body.ok, false);
});

test('state, telegram, settings, tracker, lab and error responses carry no secrets', async (t) => {
  const { request, dir, mock } = await setup(t, { env: { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_IDS: '1001' } });
  const access = JSON.parse(fs.readFileSync(path.join(dir, '.tractive-token.json'), 'utf8')).access_token;
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}/command/led_control/on`, status: 400, times: 1, body: { code: 1, message: 'nope' } });
  const bodies = [];
  for (const p of ['/api/state', '/api/telegram', '/api/settings', `/api/tracker/${TID}`, '/api/lab/raw', '/api/commands', '/api/lab/channel', '/api/tractive/notifications']) {
    const r = await request(p);
    assert.equal(r.status, 200, p);
    bodies.push(await r.text());
  }
  const err = await request(`/api/tracker/${TID}/command`, { method: 'POST', body: JSON.stringify({ name: 'led', on: true }) });
  assert.equal(err.status, 502);
  bodies.push(await err.text());
  for (const b of bodies) for (const secret of [BOT, 'TEST-TOKEN', access, 'secret-pw-123', 'pw-test']) assert.ok(!b.includes(secret), `${secret} leaked in ${b.slice(0, 120)}`);
  const state = JSON.parse(bodies[0]);
  assert.equal(state.followed, TID);
  assert.equal(state.trackers[0].trackerId, TID);
  assert.equal(state.trackers[0].battery, 80);
  assert.equal(state.trackers[0].petName, 'Rex');
  assert.equal(state.telegram.enabled, true);
  assert.equal(state.yard.id, IDS.yard);
  assert.deepEqual(state.psz.map((z) => [z.name, z.coversYard]), [['Kitchen', true], ['Neighbour', false]]);
  assert.equal(state.tractive.login, 'ok');
  assert.equal(state.monitor.lastFix.cls, 'inside');
});

test('pos_request is refused with 409 and never reaches Tractive when the account does not allow it', async (t) => {
  const { request, mock, store } = await setup(t);
  assert.equal(JSON.parse(await (await request('/api/state')).text()).capabilities.posRequest, true);
  store.setRaw('user', { settings: {} });
  assert.equal(JSON.parse(await (await request('/api/state')).text()).capabilities.posRequest, false);
  const r = await request(`/api/tracker/${TID}/command`, { method: 'POST', body: JSON.stringify({ name: 'pos_request', on: true }) });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /^Locate now is not available for this Tractive account/);
  const reqs = await mock.get('/__mock/requests?host=graph');
  assert.ok(!reqs.some((q) => q.path.includes('pos_request')));
});

test('commands reach Tractive; Tractive errors map to 502, rate limits to 503 with retryAfter; validation is 400/404', async (t) => {
  const { request, mock } = await setup(t);
  const post = (body, tid = TID) => request(`/api/tracker/${tid}/command`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ name: 'led', on: true })).status, 200);
  assert.equal((await post({ name: 'pos_request', on: true })).status, 200);
  const live = await json(await post({ name: 'live', on: true }));
  assert.equal(live.status, 202);
  assert.deepEqual(live.body, { manual: true });
  const reqs = await mock.get('/__mock/requests?host=graph');
  for (const p of ['led_control/on', 'pos_request/on', 'live_tracking/on']) assert.ok(reqs.some((r) => r.path === `/graph/4/tracker/${TID}/command/${p}`), p);
  assert.equal((await post({ name: 'nope', on: true })).status, 400);
  assert.equal((await post({ name: 'pos_request', on: false })).status, 400);
  assert.equal((await post({ name: 'led', on: 'yes' })).status, 400);
  assert.equal((await post({ name: 'led', on: true }, 'trk1')).status, 400);
  assert.equal((await post({ name: 'led', on: true }, 'ZZZ00000')).status, 404);
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}/command/buzzer_control`, status: 429, times: 2 });
  const rl = await json(await post({ name: 'buzzer', on: true }));
  assert.equal(rl.status, 503);
  assert.equal(typeof rl.body.retryAfter, 'number');
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}/command/buzzer_control`, status: 400, times: 1, body: { code: 7, message: 'tracker busy' } });
  const bad = await json(await post({ name: 'buzzer', on: true }));
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /tracker busy/);
  assert.equal((await request(`/api/tracker/${TID}/power-mode`, { method: 'PUT', body: '{"mode":"PRECISION"}' })).status, 200);
  assert.equal((await request(`/api/tracker/${TID}/power-mode`, { method: 'PUT', body: '{"mode":"TURBO"}' })).status, 400);
  assert.equal((await request(`/api/tracker/${TID}/live-timeout`, { method: 'PUT', body: '{"seconds":900}' })).status, 200);
  assert.equal((await request(`/api/tracker/${TID}/live-timeout`, { method: 'PUT', body: '{"seconds":600}' })).status, 400);
  const audit = await json(await request('/api/commands?limit=50'));
  assert.ok(audit.body.some((c) => c.actor === 'web' && c.action === 'command:led_control' && c.ok === 1));
  assert.ok(audit.body.some((c) => c.actor === 'web' && c.action === 'power-mode'));
});

test('geofences: validated create, versioned update with 409, delete', async (t) => {
  const { request, mock } = await setup(t);
  const poly = { name: 'Back', shape: 'POLYGON', coords: square(10).map(asPair), fence_type: 'SAFE', active: true };
  const created = await json(await request(`/api/tracker/${TID}/geofences`, { method: 'POST', body: JSON.stringify(poly) }));
  assert.equal(created.status, 201);
  assert.equal(created.body.icon, 'TRACTIVE');
  const post = (await mock.get('/__mock/requests?host=graph')).find((r) => r.method === 'POST' && r.path === `/graph/4/geofence/tracker/${TID}/geofences`);
  assert.deepEqual(post.body.coords, poly.coords);
  const invalid = [
    { ...poly, coords: poly.coords.slice(0, 2) }, { ...poly, name: '' }, { ...poly, name: 'x'.repeat(41) }, { ...poly, fence_type: 'MAYBE' },
    { ...poly, coords: [[91, 2], ...poly.coords.slice(1)] }, { ...poly, shape: 'CIRCLE', coords: [[41, 2]], radius: 5 },
    { ...poly, shape: 'CIRCLE', coords: [[41, 2]], radius: 6000 }, { ...poly, shape: 'RECTANGLE' }, { ...poly, extra: 1 },
    { ...poly, coords: Array.from({ length: 101 }, (_, i) => [41 + i * 1e-5, 2]) }, { ...poly, active: 'yes' },
  ];
  for (const b of invalid) assert.equal((await request(`/api/tracker/${TID}/geofences`, { method: 'POST', body: JSON.stringify(b) })).status, 400, JSON.stringify(b).slice(0, 80));
  const id = created.body._id;
  const stale = await json(await request(`/api/geofences/${id}`, { method: 'PUT', body: JSON.stringify({ ...poly, name: 'B2', _version: 'old' }) }));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'changed elsewhere' });
  const upd = await json(await request(`/api/geofences/${id}`, { method: 'PUT', body: JSON.stringify({ ...poly, name: 'B2', _version: created.body._version }) }));
  assert.equal(upd.status, 200);
  assert.equal(upd.body.name, 'B2');
  assert.equal(upd.body.icon, 'TRACTIVE');                       // no icon sent: the current one is kept
  const iconed = await json(await request(`/api/geofences/${id}`, { method: 'PUT', body: JSON.stringify({ ...poly, name: 'B2', icon: 'BONE', _version: upd.body._version }) }));
  assert.equal(iconed.status, 200);
  assert.equal(iconed.body.icon, 'BONE');
  const put = (await mock.get('/__mock/requests?host=graph')).filter((r) => r.method === 'PUT' && r.path.startsWith(`/graph/4/geofence/${id}`)).at(-1);
  assert.equal(put.body.icon, 'BONE');
  assert.equal((await request(`/api/geofences/${id}`, { method: 'PUT', body: JSON.stringify({ ...poly, icon: 'bone<', _version: iconed.body._version }) })).status, 400);
  const list = await json(await request(`/api/tracker/${TID}/geofences`));
  assert.deepEqual(list.body.map((g) => g.name).sort(), ['B2', 'Yard']);
  assert.equal((await request(`/api/geofences/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await request('/api/geofences/xyz', { method: 'DELETE' })).status, 400);
});

test('positions: range rules, step, stats, gpx, backfill', async (t) => {
  const { request } = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const r = await json(await request(`/api/positions?tracker=${TID}&from=${now - 86400}&to=${now}`));
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.length > 10);
  assert.ok(r.body.rows[0].t >= r.body.rows.at(-1).t);
  assert.equal(r.body.truncated, false);
  assert.deepEqual(Object.keys(r.body.stats).sort(), ['distanceM', 'fixes', 'outsideS']);
  const stepped = await json(await request(`/api/positions?tracker=${TID}&from=${now - 86400}&to=${now}&step=3600`));
  assert.ok(stepped.body.rows.length <= 25);
  for (const q of [`tracker=${TID}&from=${now}&to=${now - 1}`, `tracker=${TID}&from=0&to=${32 * 86400}`, 'tracker=x&from=0&to=1', `tracker=${TID}&from=a&to=1`, `tracker=${TID}&from=${now - 10}&to=${now}&step=0`]) {
    assert.equal((await request(`/api/positions?${q}`)).status, 400, q);
  }
  const gpx = await request(`/api/positions.gpx?tracker=${TID}&from=${now - 86400}&to=${now}`);
  assert.equal(gpx.status, 200);
  assert.match(gpx.headers.get('content-type'), /^application\/gpx\+xml/);
  assert.match(gpx.headers.get('content-disposition'), /^attachment; filename="opentractive-TRK00001-\d+-\d+\.gpx"$/);
  assert.match(await gpx.text(), /<trkpt lat="4\d\.\d{6}" lon="[12]\.\d{6}">/);
  const bf = await json(await request('/api/positions/backfill', { method: 'POST', body: JSON.stringify({ tracker: TID, from: now - 3 * 86400, to: now }) }));
  assert.equal(bf.status, 202);
  assert.equal(bf.body.days, 3);
  assert.equal((await request('/api/positions/backfill', { method: 'POST', body: JSON.stringify({ tracker: TID, from: now - 40 * 86400, to: now }) })).status, 400);
});

test('escapes: payload, recompute, patch', async (t) => {
  const { request, store } = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const r = await json(await request(`/api/escapes?tracker=${TID}&from=${now - 7 * 86400}&to=${now}`));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['blind', 'episodes', 'peaks', 'strip', 'yard']);
  assert.equal(r.body.yard.id, IDS.yard);
  assert.equal(r.body.yard.polygon.length, 4);
  assert.deepEqual(r.body.blind.map((z) => z.name), ['Kitchen']);
  const rc = await json(await request('/api/escapes/recompute', { method: 'POST', body: JSON.stringify({ tracker: TID, from: now - 7 * 86400, to: now }) }));
  assert.deepEqual(rc.body, { inserted: 0, deleted: 0 });
  const id = store.insertEscape({ tracker_id: TID, t_inside: now - 100, t_outside: now - 90 });
  const p = await json(await request(`/api/escapes/${id}`, { method: 'PATCH', body: JSON.stringify({ note: 'gate', dismissed: true }) }));
  assert.equal(p.status, 200);
  assert.equal(p.body.note, 'gate');
  assert.equal(p.body.dismissed, 1);
  assert.equal((await request(`/api/escapes/${id}`, { method: 'PATCH', body: JSON.stringify({ note: 'x'.repeat(201) }) })).status, 400);
  assert.equal((await request('/api/escapes/999', { method: 'PATCH', body: '{"dismissed":true}' })).status, 404);
  assert.equal((await request('/api/escapes/abc', { method: 'PATCH', body: '{"dismissed":true}' })).status, 400);
});

test('settings: GET defaults and flags, PUT validates and replaces', async (t) => {
  const { request } = await setup(t);
  const g = await json(await request('/api/settings'));
  assert.equal(g.body.settings.v, 1);
  assert.equal(g.body.pszFlags.length, 2);
  assert.equal(g.body.ruleKinds.length, 16);
  const s = structuredClone(g.body.settings);
  s.thresholds.batteryLow = 30;
  assert.equal((await request('/api/settings', { method: 'PUT', body: JSON.stringify(s) })).status, 200);
  assert.equal((await json(await request('/api/settings'))).body.settings.thresholds.batteryLow, 30);
  const bad = await json(await request('/api/settings', { method: 'PUT', body: JSON.stringify({ ...s, nope: 1 }) }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid settings');
  assert.ok(bad.body.fields.nope);
});

test('alerts list, ack, false alarm; chase and walk toggles', async (t) => {
  const { request, store, app } = await setup(t);
  const id = store.insertAlert({ t: 1, tracker_id: TID, kind: 'out_confirmed', severity: 'critical', title: 'OUT', incident: 1 });
  assert.equal((await json(await request('/api/alerts?limit=10'))).body[0].id, id);
  assert.equal((await request('/api/alerts?limit=0')).status, 400);
  assert.equal((await request(`/api/alerts/${id}/ack`, { method: 'POST' })).status, 200);
  assert.equal(store.alert(id).acked_by, 'web');
  assert.equal((await request(`/api/alerts/${id}/false-alarm`, { method: 'POST' })).status, 200);
  assert.equal(store.alert(id).closed_by, 'web');
  assert.equal((await request(`/api/alerts/${id}/false-alarm`, { method: 'POST' })).status, 409);
  assert.equal((await request('/api/alerts/999/ack', { method: 'POST' })).status, 404);
  assert.equal((await request('/api/chase', { method: 'POST', body: '{"on":true}' })).status, 200);
  assert.ok(app.monitor.status().chase);
  assert.equal((await request('/api/chase', { method: 'POST', body: '{"on":false}' })).status, 200);
  assert.equal(app.monitor.status().chase, null);
  assert.equal((await request('/api/walk', { method: 'POST', body: '{"minutes":60}' })).status, 200);
  assert.ok(app.monitor.status().walk);
  assert.equal((await request('/api/walk', { method: 'POST', body: '{"minutes":null}' })).status, 200);
  assert.equal(app.monitor.status().walk, null);
  for (const m of ['0', '721', '"x"']) assert.equal((await request('/api/walk', { method: 'POST', body: `{"minutes":${m}}` })).status, 400, m);
});

test('lab: labCheck rules', () => {
  const bases = { graph: 'https://graph.example/4', aps: 'https://aps.example/api/1', timeline: 'https://tl.example/api/1' };
  const run = (o) => labCheck({ host: 'graph', method: 'GET', confirm: false, ...o }, bases);
  const ok = (o) => { const r = run(o); assert.ok(r.url, `${JSON.stringify(o)} -> ${JSON.stringify(r)}`); return r; };
  const no = (o, status) => assert.equal(run(o).status, status, JSON.stringify(o));
  assert.equal(ok({ path: `/tracker/${TID}` }).url.href, `https://graph.example/4/tracker/${TID}`);
  ok({ path: `/tracker/${TID}/positions?time_from=1&time_to=2&format=json_segments` });
  ok({ host: 'aps', path: `/pet/${IDS.pet}/health/overview` });
  for (const p of ['/%2e%2e/auth/token', '/a/../b', '//evil.example/x', 'tracker', '/x y', '/a@b', `/${'a'.repeat(301)}`, '/a\\b']) no({ path: p }, 400);
  no({ host: 'evil', path: '/x' }, 400);
  no({ method: 'TRACE', path: '/x' }, 400);
  for (const p of ['/auth/token', '/Auth/token', '/payment/x', '/invoices', '/analytics/e', `/subscription/${IDS.subscription}`, '/user/x/email_change', '/user/x/push_token', '/trackable_object/x/picture', '/user/reset_password', '/logout']) {
    no({ path: p, method: 'POST', confirm: true }, 403);
  }
  no({ path: `/subscription/${IDS.subscription}` }, 403);
  for (const p of ['/user/x', '/trackable_object/x', `/tracker/${TID}`]) no({ path: p, method: 'DELETE', confirm: true }, 403);
  for (const p of ['/user/x', '/user/x?_version=1']) no({ path: p, method: 'PUT', confirm: true }, 403);
  no({ path: '/user/me/activate', method: 'POST', confirm: true }, 403);
  // single-dot segments are normalised away by URL; they must not slip past the deny-list
  for (const p of ['/./user/x', '/./auth/token', '/./tracker/x', '/a/./b', '/.', '/x/.']) no({ path: p, method: 'POST', confirm: true }, 400);
  no({ path: '/./tracker/x', method: 'DELETE', confirm: true }, 400);
  ok({ path: '/user/x' });
  no({ path: '/bulk?partial=1', method: 'POST' }, 400);
  ok({ path: '/bulk?partial=1', method: 'POST', confirm: true });
  no({ path: `/tracker/${TID}/command/led_control/on` }, 400);
  ok({ path: `/tracker/${TID}/command/led_control/on`, confirm: true });
  ok({ path: `/geofence/${IDS.yard}`, method: 'DELETE', confirm: true });
  assert.deepEqual(redactSecrets({ a: { access_token: 'x', token: 'y', share_link: 'z', ok: 1 }, l: [{ token: 'q' }] }),
    { a: { access_token: '<redacted>', token: '<redacted>', share_link: '<redacted>', ok: 1 }, l: [{ token: '<redacted>' }] });
});

test('lab: console through the queue, redacted, audited without bodies; raw, channel and fields', async (t) => {
  const { request } = await setup(t);
  const lab = (b) => request('/api/lab/request', { method: 'POST', body: JSON.stringify(b) });
  const r = await json(await lab({ host: 'graph', method: 'GET', path: `/tracker/${TID}?x=1` }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 200);
  assert.equal(r.body.body.hw_id, TID);
  assert.equal(typeof r.body.ms, 'number');
  const sh = await json(await lab({ host: 'graph', method: 'GET', path: `/public_share/${IDS.share}` }));
  assert.equal(sh.body.body.share_link, '<redacted>');
  assert.equal((await lab({ host: 'graph', method: 'POST', path: '/auth/token', confirm: true, body: {} })).status, 403);
  assert.equal((await json(await lab({ host: 'graph', method: 'GET', path: '/nope/404' }))).body.status, 404);
  const audit = (await json(await request('/api/commands?limit=50'))).body.filter((c) => c.action === 'lab');
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.at(-1).params, { method: 'GET', host: 'graph', path: `/tracker/${TID}` });
  assert.equal(JSON.parse(audit.at(-1).result).status, 200);
  assert.ok(!JSON.stringify(audit).includes('hw_id'));
  assert.ok((await json(await request('/api/lab/raw'))).body.some((x) => x.kind === `tracker:${TID}`));
  assert.ok((await json(await request('/api/lab/channel?limit=5'))).body.some((x) => x.message === 'tracker_status'));
  assert.ok((await json(await request('/api/lab/fields'))).body.some((f) => f.kind === 'tracker' && f.path === 'capabilities'));
});

test('SSE: headers, first state event, live events, at most 8 streams', async (t) => {
  const { base, cookie, mock } = await setup(t);
  const open = async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: ctrl.signal });
    const s = { res, text: '', closed: false, ctrl };
    (async () => {
      const dec = new TextDecoder();
      try { for await (const c of res.body) s.text += dec.decode(c, { stream: true }); } catch { /* aborted */ }
      s.closed = true;
    })();
    return s;
  };
  const a = await open();
  assert.equal(a.res.headers.get('content-type'), 'text/event-stream');
  assert.equal(a.res.headers.get('cache-control'), 'no-store');
  assert.equal(a.res.headers.get('x-accel-buffering'), 'no');
  await until(() => a.text.startsWith('event: state\ndata: '));
  await mock.post('/__mock/fix', { lat: 41.0001, lng: 2.0001, acc: 4, sensor: 'GPS' });
  await until(() => a.text.includes('event: position\ndata: '));
  await until(() => a.text.includes('event: channel\ndata: '));
  const more = [];
  for (let i = 0; i < 8; i++) more.push(await open());
  await until(() => a.closed);
  assert.ok(more.every((s) => !s.closed));
  for (const s of more) s.ctrl.abort();
});

test('pet photo is proxied with a type check and cached on disk', async (t) => {
  const { request, dir, mock } = await setup(t);
  const r = await request(`/api/pet/${IDS.pet}/photo`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(fs.readdirSync(path.join(dir, 'cache')).includes(`${IDS.picture}.png`));
  const count = async () => (await mock.get('/__mock/requests?host=graph')).filter((x) => x.path.includes('/media/resource/')).length;
  const n = await count();
  assert.equal((await request(`/api/pet/${IDS.pet}/photo`)).status, 200);
  assert.equal(await count(), n);
  fs.rmSync(path.join(dir, 'cache'), { recursive: true });
  await mock.post('/__mock/fail', { match: 'GET /graph/4/media/resource', status: 200, times: 1, body: { not: 'an image' } });
  assert.equal((await request(`/api/pet/${IDS.pet}/photo`)).status, 502);
  assert.equal((await request('/api/pet/zzz/photo')).status, 400);
});

test('tracker, share, zone, pet, notification and telegram routes', async (t) => {
  const { request, mock } = await setup(t, { env: { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_IDS: '1001' } });
  const tr = await json(await request(`/api/tracker/${TID}`));
  assert.equal(tr.body.tracker.hw_id, TID);
  assert.deepEqual(tr.body.psz.map((z) => [z.name, z.coversYard]), [['Kitchen', true], ['Neighbour', false]]);
  assert.equal(tr.body.reachable.user_gets_notified, false);
  assert.equal(tr.body.subscription.status, 'ACTIVE');
  assert.equal(typeof tr.body.range.first, 'number');
  assert.equal((await json(await request(`/api/tracker/${TID}/reachable-notification`, { method: 'POST' }))).body.user_gets_notified, true);
  const share = await json(await request(`/api/tracker/${TID}/share`, { method: 'POST', body: '{"message":"Lost dog"}' }));
  assert.equal(share.status, 201);
  assert.equal((await request(`/api/share/${share.body._id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`/api/psz/${IDS.pszOut}`, { method: 'DELETE', body: '{"confirm":"wrong"}' })).status, 400);
  assert.equal((await request(`/api/psz/${IDS.pszOut}`, { method: 'DELETE', body: '{"confirm":"Neighbour"}' })).status, 204);
  const pet = await json(await request(`/api/pet/${IDS.pet}`));
  assert.equal(pet.body.pet.details.name, 'Rex');
  assert.equal(pet.body.health.activity.hourlyDistribution.length, 24);
  assert.ok(Array.isArray(pet.body.timeline.events));
  assert.ok(Array.isArray((await json(await request(`/api/pet/${IDS.pet}?resumeFrom=2026-11-01`))).body.timeline.events));
  assert.equal((await request(`/api/pet/${IDS.pet}?resumeFrom=nope`)).status, 400);
  const put = await json(await request(`/api/pet/${IDS.pet}`, { method: 'PUT', body: JSON.stringify({ details: { name: 'Rexy', weight: 21500 } }) }));
  assert.equal(put.status, 200);
  assert.equal(put.body.details.name, 'Rexy');
  assert.equal((await request(`/api/pet/${IDS.pet}`, { method: 'PUT', body: JSON.stringify({ details: { name: 'R', chip_id: '1' } }) })).status, 400);
  const n = await json(await request('/api/tractive/notifications'));
  assert.deepEqual(Object.keys(n.body).sort(), ['mail', 'push', 'webPush']);
  assert.equal(n.body.push.proactive_charge_reminder, false);
  assert.equal((await request('/api/tractive/notifications', { method: 'PUT', body: JSON.stringify({ push: { geofence_out: false }, mail: { battery_low: true } }) })).status, 200);
  const putUser = (await mock.get('/__mock/requests?host=graph')).find((r) => r.method === 'PUT' && r.path.startsWith(`/graph/4/user/${IDS.user}?_version=`));
  assert.equal(putUser.body.settings.push_settings.geofence_out, false);
  assert.equal(putUser.body.settings.mail_settings.battery_low, true);
  assert.equal((await request('/api/tractive/notifications', { method: 'PUT', body: JSON.stringify({ push: { email: false } }) })).status, 400);
  const tg = await json(await request('/api/telegram'));
  assert.equal(tg.body.enabled, true);
  assert.equal(tg.body.chats[0].chat_id, '1001');
  const code = await json(await request('/api/telegram/pairing', { method: 'POST' }));
  assert.match(code.body.code, /^\d{6}$/);
  assert.equal((await request('/api/telegram/chats/1001', { method: 'PUT', body: '{"min_severity":"critical","muted_until":null}' })).status, 200);
  assert.equal((await request('/api/telegram/chats/1001', { method: 'PUT', body: '{"min_severity":"loud","muted_until":null}' })).status, 400);
  assert.equal((await json(await request('/api/telegram/test', { method: 'POST' }))).body.sent, 1);
  assert.equal((await request('/api/telegram/chats/1001', { method: 'DELETE' })).status, 204);
  assert.equal((await request('/api/telegram/chats/1001', { method: 'DELETE' })).status, 404);
  assert.equal((await request('/api/telegram/chats/abc', { method: 'DELETE' })).status, 400);
  assert.equal((await request('/api/tractive/retry-login', { method: 'POST' })).status, 202);
});

test('static: vendor whitelist, sprite, unknown api 404, wrong method 405', async (t) => {
  const { request } = await setup(t);
  assert.equal((await request('/vendor/leaflet/leaflet.js')).status, 200);
  assert.equal((await request('/vendor/geoman/leaflet-geoman.js')).status, 200);
  assert.equal((await request('/vendor/nope.js')).status, 404);
  assert.equal((await request('/icons.svg')).status, 200);
  assert.equal((await request('/api/nope')).status, 404);
  assert.equal((await request('/api/state', { method: 'DELETE' })).status, 405);
});

test('main exits without APP_PASSWORD or Tractive credentials, before creating anything', () => {
  const main = fileURLToPath(new URL('../src/main.js', import.meta.url));
  for (const [env, re] of [[{ APP_PASSWORD: '' }, /APP_PASSWORD is required/], [{ APP_PASSWORD: 'longenough', TRACTIVE_EMAIL: '' }, /TRACTIVE_EMAIL and TRACTIVE_PASSWORD are required/]]) {
    const cwd = tmpDir('main');
    try {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', main], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8', timeout: 10e3 });
      assert.equal(r.status, 1);
      assert.match(r.stderr, re);
      assert.deepEqual(fs.readdirSync(cwd), []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('a truncated recompute is reported as nothing changed, with a request for a shorter period', async () => {
  const { recomputeText } = await import('../public/js/views/escapes.js');
  assert.equal(recomputeText({ inserted: 2, deleted: 1 }), 'Recomputed: 2 added, 1 removed');
  const msg = recomputeText({ inserted: 0, deleted: 0, truncated: true });
  assert.doesNotMatch(msg, /^Recomputed/);
  assert.match(msg, /shorter period/);
});

test('wi-fi zone switch: validated, foreign zones refused, off and on through the API, blind notice follows', async (t) => {
  const { request, mock, app } = await setup(t);
  const sw = (zid, body) => request(`/api/psz/${zid}/switch`, { method: 'POST', body });
  assert.equal((await sw(IDS.pszIn, '{"on":"no"}')).status, 400);
  assert.equal((await sw('5f1a000000000000000000ff', '{"on":false}')).status, 404);
  const off = await json(await sw(IDS.pszIn, '{"on":false}'));
  assert.equal(off.status, 200);
  assert.equal(off.body.off, true);
  const zone = async () => JSON.parse((await mock.get('/__mock/requests?host=graph')) && JSON.stringify((await app.tractive.powerSavingZone(IDS.pszIn))));
  assert.match((await zone()).zone_id, /~ot-off$/);
  const state = await json(await request('/api/state'));
  assert.equal(state.body.zones.find((z) => z.id === IDS.pszIn).off, true);
  assert.equal(state.body.psz.find((z) => z.id === IDS.pszIn).blinds, false);
  const tr = await json(await request(`/api/tracker/${TID}`));
  assert.equal(tr.body.psz.find((z) => z._id === IDS.pszIn).zone_id, 'a0:00:00:00:00:01'); // the real name, without the marker
  const on = await json(await sw(IDS.pszIn, '{"on":true}'));
  assert.equal(on.body.off, false);
  assert.equal((await zone()).zone_id, 'a0:00:00:00:00:01');
});

test('locate now: Tractive position request when allowed; otherwise the yard zone is off until the first GPS fix', async (t) => {
  const { request, mock, store, app } = await setup(t);
  const loc = (body = {}) => request('/api/locate', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await json(await loc())).body.mode, 'pos_request');
  const user = store.getRaw('user');
  store.setRaw('user', { ...user, settings: { ...user.settings, pos_request_allowed: false } });
  const r = await json(await loc());
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'zone');
  assert.deepEqual(r.body.active.zones, [IDS.pszIn]);
  assert.match((await app.tractive.powerSavingZone(IDS.pszIn)).zone_id, /~ot-off$/);
  await mock.post('/__mock/fix', { lat: 41.0, lng: 2.0, acc: 6, sensor: 'GPS', dtS: 2 }); // the tracker wakes and reports GPS
  await until(async () => (await json(await request('/api/state'))).body.locate.active === null, { timeout: 8000 });
  const st = (await json(await request('/api/state'))).body;
  assert.equal(st.locate.last.reason, 'fix');
  assert.equal((await app.tractive.powerSavingZone(IDS.pszIn)).zone_id, 'a0:00:00:00:00:01');
  // the Live page switch: every zone covering the yard off, then on
  const yard = (on) => request('/api/zones/yard', { method: 'POST', body: JSON.stringify({ on }) });
  assert.equal((await yard('x')).status, 400);
  assert.equal((await json(await yard(false))).body.zones.find((z) => z.id === IDS.pszIn).off, true);
  assert.equal((await json(await yard(true))).body.zones.find((z) => z.id === IDS.pszIn).off, false);
});
