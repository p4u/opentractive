import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTractive, TractiveError, RateLimited, AuthError } from '../src/tractive.js';
import { startMock } from './mock/server.js';
import { tmpDir, until, TID, IDS } from './helpers.js';

const EMAIL = 'owner@example.com';
const CLIENT_ID = '625e533dc3c3b41c28a669f0';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function setup(t, opts = {}, mock) {
  mock ??= await startMock({ keepAliveMs: 100 });
  const dir = opts.dir ?? tmpDir('tractive');
  const make = (extra = {}) => createTractive({
    graphUrl: `${mock.url}/graph/4`, channelUrl: `${mock.url}/channel/3/channel`, apsUrl: `${mock.url}/aps/api/1`,
    timelineUrl: `${mock.url}/timeline/api/1`, clientId: CLIENT_ID, email: EMAIL, password: 'secret-pw',
    tokenFile: path.join(dir, '.tractive-token.json'), tz: 'Europe/Madrid', minGapMs: 0, penaltyBaseMs: 50,
    penaltyMaxMs: 400, loginBackoffBaseMs: 50, silenceMs: 400, reconnectMinMs: 50, reconnectMaxMs: 400,
    syncDebounceMs: 50, syncMinIntervalMs: 300, random: () => 0.5, log: () => {}, ...opts, ...extra,
  });
  const client = make();
  const clients = [client];
  t.after(async () => {
    for (const c of clients) c.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mock, client, dir, another: (extra) => { const c = make(extra); clients.push(c); return c; } };
}
const calls = async (mock, host = 'graph') => mock.get(`/__mock/requests?host=${host}`);
const authCalls = async (mock) => (await calls(mock)).filter((r) => r.path === '/graph/4/auth/token').length;

test('login caches the token (mode 600) and a second client reuses it', async (t) => {
  const { client, mock, dir, another } = await setup(t);
  assert.deepEqual((await client.trackers()).map((x) => x._id), [TID]);
  const file = path.join(dir, '.tractive-token.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(cache).sort(), ['access_token', 'client_id', 'email_sha256', 'expires_at', 'user_id']);
  assert.equal(cache.email_sha256, sha(EMAIL));
  assert.equal(cache.client_id, CLIENT_ID);
  assert.equal(client.status().login, 'ok');
  await another().tracker(TID);
  assert.equal(await authCalls(mock), 1);
});

test('a cached token is discarded when the email differs or it expires within 1 h', async (t) => {
  const { client, mock, dir, another } = await setup(t);
  await client.trackers();
  const file = path.join(dir, '.tractive-token.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  await another({ email: 'other@example.com' }).trackers();
  assert.equal(await authCalls(mock), 2);
  fs.writeFileSync(file, JSON.stringify({ ...cache, email_sha256: sha(EMAIL), expires_at: Math.floor(Date.now() / 1000) + 1800 }), { mode: 0o600 });
  await another().trackers();
  assert.equal(await authCalls(mock), 3);
  assert.ok((await calls(mock)).every((r) => r.status !== 401));
});

test('a 401 re-authenticates once and retries; a second 401 fails', async (t) => {
  const { client, mock } = await setup(t);
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}`, status: 401, times: 1 });
  assert.equal((await client.tracker(TID))._id, TID);
  assert.equal(await authCalls(mock), 2);
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}`, status: 401, times: 2 });
  const err = await client.tracker(TID).catch((e) => e);
  assert.ok(err instanceof TractiveError);
  assert.equal(err.status, 401);
});

test('the 401 retry goes back through the queue and keeps the gap', async (t) => {
  const { client, mock } = await setup(t, { minGapMs: 300 });
  await client.trackers();
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}`, status: 401, times: 1 });
  assert.equal((await client.tracker(TID))._id, TID);
  const gets = (await calls(mock)).filter((r) => r.path === `/graph/4/tracker/${TID}`);
  assert.equal(gets.length, 2);
  assert.ok(gets[1].at - gets[0].at >= 290, String(gets[1].at - gets[0].at));
});

test('the pet photo is refused on its headers or cancelled past 2 MB, never buffered whole', async (t) => {
  const { client, mock } = await setup(t, { requestTimeoutMs: 20000 });
  const match = 'GET /graph/4/media/resource';
  await mock.post('/__mock/fail', { match, status: 200, times: 1, image: { bytes: 3 * 1024 * 1024 } });
  assert.deepEqual(await client.petPhoto(IDS.picture), { type: null, buf: Buffer.alloc(0) });
  await mock.post('/__mock/fail', { match, status: 200, times: 1, image: { bytes: 10, type: 'text/html' } });
  assert.equal((await client.petPhoto(IDS.picture)).type, null);
  const t0 = Date.now();
  await mock.post('/__mock/fail', { match, status: 200, times: 1, image: { chunked: true } }); // endless body
  assert.deepEqual(await client.petPhoto(IDS.picture), { type: null, buf: Buffer.alloc(0) });
  assert.ok(Date.now() - t0 < 5000);
  await mock.post('/__mock/fail', { match, status: 200, times: 1, image: { chunked: true, bytes: 100_000, type: 'image/jpeg' } });
  const ok = await client.petPhoto(IDS.picture);
  assert.equal(ok.type, 'image/jpeg');
  assert.equal(ok.buf.length, 100_000);
  assert.equal((await calls(mock)).filter((r) => r.path.includes('/media/resource/')).length, 4); // refused bodies are not retried
});

test('a media error response with an oversized endless body is cancelled, not read', async (t) => {
  const { client, mock } = await setup(t, { requestTimeoutMs: 20000 });
  await mock.post('/__mock/fail', { match: 'GET /graph/4/media/resource', status: 404, times: 1, image: { chunked: true, type: 'application/json' } });
  const t0 = Date.now();
  const err = await client.petPhoto(IDS.picture).catch((e) => e);
  assert.ok(Date.now() - t0 < 5000, String(Date.now() - t0));
  assert.ok(err instanceof TractiveError);
  assert.equal(err.status, 404);
});

test('login is single-flight', async (t) => {
  const { client, mock } = await setup(t);
  await Promise.all([client.login(), client.login(), client.user(), client.config()]);
  assert.equal(await authCalls(mock), 1);
});

test('bad credentials: no automatic retry, requests fail fast, retryLogin recovers', async (t) => {
  const { client, mock } = await setup(t);
  await mock.post('/__mock/fail', { match: 'POST /graph/4/auth/token', status: 401, times: 1 });
  const err = await client.tracker(TID).catch((e) => e);
  assert.ok(err instanceof AuthError);
  assert.equal(err.state, 'bad-credentials');
  assert.equal(client.status().login, 'bad-credentials');
  assert.ok((await client.config().catch((e) => e)) instanceof AuthError);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await authCalls(mock), 1);
  client.retryLogin();
  await until(() => client.status().login === 'ok');
  assert.equal((await client.tracker(TID))._id, TID);
});

test('login 429 / 5xx: state login-retrying, retried in the background with backoff', async (t) => {
  const { client, mock } = await setup(t);
  await mock.post('/__mock/fail', { match: 'POST /graph/4/auth/token', status: 429, times: 1 });
  const err = await client.tracker(TID).catch((e) => e);
  assert.ok(err instanceof AuthError);
  assert.equal(err.state, 'login-retrying');
  await until(() => client.status().login === 'ok', { timeout: 2000 });
  assert.equal(await authCalls(mock), 2);
});

test('queue: at least minGapMs between request starts', async (t) => {
  const { client, mock } = await setup(t, { minGapMs: 120 });
  await client.login();
  await Promise.all([client.user(), client.config(), client.pets()]);
  const at = (await calls(mock)).filter((r) => r.path !== '/graph/4/auth/token').map((r) => r.at);
  assert.equal(at.length, 3);
  assert.ok(at[1] - at[0] >= 100 && at[2] - at[1] >= 100, String(at));
});

test('queue: commands jump ahead of queued normal requests', async (t) => {
  const { client, mock } = await setup(t, { minGapMs: 50 });
  await client.login();
  const p = [client.user(), client.config(), client.pets(), client.command(TID, 'led_control', true)];
  await Promise.all(p);
  const order = (await calls(mock)).filter((r) => r.path !== '/graph/4/auth/token').map((r) => r.path.split('?')[0]);
  assert.deepEqual(order, [`/graph/4/tracker/${TID}/command/led_control/on`, `/graph/4/user/${IDS.user}`, '/graph/4/config/all', `/graph/4/user/${IDS.user}/trackable_objects`]);
});

test('429: re-queued after the penalty, the gap doubles', async (t) => {
  const { client, mock } = await setup(t, { minGapMs: 20 });
  await client.login();
  await mock.post('/__mock/fail', { match: 'GET /graph/4/config/all', status: 429, times: 1 });
  await client.config();
  const at = (await calls(mock)).filter((r) => r.path === '/graph/4/config/all').map((r) => r.at);
  assert.equal(at.length, 2);
  assert.ok(at[1] - at[0] >= 50, String(at[1] - at[0]));
  assert.equal(client.status().queue.gapMs, 40);
});

test('RateLimited after 4 attempts for normal requests and 2 for commands', async (t) => {
  const { client, mock } = await setup(t);
  await client.login();
  await mock.post('/__mock/fail', { match: 'GET /graph/4/config/all', status: 429, times: 10, retryAfter: 0 });
  const e1 = await client.config().catch((e) => e);
  assert.ok(e1 instanceof RateLimited);
  assert.equal(typeof e1.retryAfterS, 'number');
  assert.equal((await calls(mock)).filter((r) => r.path === '/graph/4/config/all').length, 4);
  await mock.post('/__mock/fail', { match: `GET /graph/4/tracker/${TID}/command/led_control`, status: 429, times: 10 });
  assert.ok((await client.command(TID, 'led_control', true).catch((e) => e)) instanceof RateLimited);
  assert.equal((await calls(mock)).filter((r) => r.path.includes('/command/led_control/')).length, 2);
});

test('4xx fails at once with Tractive code and message; 5xx retried twice', async (t) => {
  const { client, mock } = await setup(t);
  await client.login();
  await mock.post('/__mock/fail', { match: `PUT /graph/4/tracker/${TID}/power_mode`, status: 400, times: 1, body: { code: 4002, message: 'invalid mode' } });
  const err = await client.setPowerMode(TID, 'LOW').catch((e) => e);
  assert.ok(err instanceof TractiveError && !(err instanceof RateLimited));
  assert.equal(err.status, 400);
  assert.equal(err.code, 4002);
  assert.match(err.message, /invalid mode/);
  assert.equal((await calls(mock)).filter((r) => r.path.endsWith('/power_mode')).length, 1);
  await mock.post('/__mock/fail', { match: 'GET /graph/4/config/all', status: 503, times: 2 });
  assert.equal(typeof (await client.config()), 'object');
  await mock.post('/__mock/fail', { match: `GET /graph/4/user/${IDS.user}`, status: 502, times: 3 });
  assert.equal((await client.user().catch((e) => e)).status, 502);
});

test('argument checks happen before any request', async (t) => {
  const { client, mock } = await setup(t);
  await assert.rejects(client.setLiveTimeout(TID, 120), RangeError);
  await assert.rejects(client.setPowerMode(TID, 'TURBO'), RangeError);
  await assert.rejects(client.command(TID, 'pos_request', false), RangeError);
  await assert.rejects(client.command(TID, 'self_destruct', true), RangeError);
  await assert.rejects(client.raw('evil', 'GET', '/x'), RangeError);
  assert.deepEqual(await mock.get('/__mock/requests'), []);
});

test('every method calls the documented path', async (t) => {
  const { client, mock } = await setup(t);
  await client.login();
  const now = Math.floor(Date.now() / 1000);
  const plan = [
    [() => client.user(), `GET /graph/4/user/${IDS.user}`],
    [() => client.trackers(), `GET /graph/4/user/${IDS.user}/trackers`],
    [() => client.tracker(TID), `GET /graph/4/tracker/${TID}`],
    [() => client.hwReport(TID), `GET /graph/4/device_hw_report/${TID}/`],
    [() => client.posReport(TID), `GET /graph/4/device_pos_report/${TID}`],
    [() => client.pets(), `GET /graph/4/user/${IDS.user}/trackable_objects`],
    [() => client.pet(IDS.pet), `GET /graph/4/trackable_object/${IDS.pet}`],
    [() => client.subscriptions(), `GET /graph/4/user/${IDS.user}/subscriptions`],
    [() => client.subscription(IDS.subscription), `GET /graph/4/subscription/${IDS.subscription}`],
    [() => client.geofences(TID), `GET /graph/4/tracker/${TID}/geofences`, 'POST /graph/4/bulk?partial=1'],
    [() => client.powerSavingZones(TID), `GET /graph/4/tracker/${TID}/power_saving_zones`, `GET /graph/4/power_saving_zone/${IDS.pszIn}`, `GET /graph/4/power_saving_zone/${IDS.pszOut}`],
    [() => client.commandStates(TID), 'POST /graph/4/bulk?partial=1'],
    [() => client.positionsRange(TID), `GET /graph/4/tracker/${TID}/positions/range`],
    [() => client.positions(TID, now - 3600, now), `GET /graph/4/tracker/${TID}/positions?time_from=${now - 3600}&time_to=${now}&format=json_segments`],
    [() => client.publicShares(TID), `GET /graph/4/tracker/${TID}/public_shares`, 'POST /graph/4/bulk?partial=1'],
    [() => client.reachableNotification(TID), `GET /graph/4/tracker/${TID}/event_notification/tracker_reachable_again`],
    [() => client.setReachableNotification(TID), `POST /graph/4/tracker/${TID}/event_notification/tracker_reachable_again`],
    [() => client.weightHistory(IDS.pet), `GET /graph/4/weight_activity_history/${IDS.pet}`],
    [() => client.health(IDS.pet), `GET /aps/api/1/pet/${IDS.pet}/health/overview`],
    [() => client.timeline(IDS.pet), `GET /timeline/api/1/events?petId=${IDS.pet}&timezone=Europe%2FMadrid&types=walk`],
    [() => client.config(), 'GET /graph/4/config/all'],
    [() => client.command(TID, 'live_tracking', true), `GET /graph/4/tracker/${TID}/command/live_tracking/on`],
    [() => client.command(TID, 'buzzer_control', false), `GET /graph/4/tracker/${TID}/command/buzzer_control/off`],
    [() => client.command(TID, 'pos_request', true), `GET /graph/4/tracker/${TID}/command/pos_request/on`],
    [() => client.setPowerMode(TID, 'LOW'), `PUT /graph/4/tracker/${TID}/power_mode`],
    [() => client.setLiveTimeout(TID, 900), `PUT /graph/4/tracker/${TID}/lt_timeout`],
    [() => client.createPublicShare(TID, 'hi'), 'POST /graph/4/public_share'],
    [() => client.deactivatePublicShare(IDS.share), `PUT /graph/4/public_share/${IDS.share}/deactivate`],
    [() => client.petPhoto(IDS.picture), `GET /graph/4/media/resource/${IDS.picture}.jpg`],
    [() => client.deletePowerSavingZone(IDS.pszOut), `DELETE /graph/4/power_saving_zone/${IDS.pszOut}`],
  ];
  for (const [fn, ...want] of plan) {
    const before = (await mock.get('/__mock/requests')).length;
    await fn();
    const got = (await mock.get('/__mock/requests')).slice(before).map((r) => `${r.method} ${r.path}`);
    assert.equal(got.length, want.length, `${want[0]}: ${got}`);
    want.forEach((w, i) => assert.ok(got[i].startsWith(w), `${got[i]} should start with ${w}`));
  }
  const bodies = (await calls(mock)).filter((r) => r.method !== 'GET');
  assert.deepEqual(bodies.find((r) => r.path.endsWith('/lt_timeout')).body, { timeout: 900 });
  assert.deepEqual(bodies.find((r) => r.path.endsWith('/power_mode')).body, { power_mode: 'LOW' });
  assert.deepEqual(bodies.find((r) => r.path === '/graph/4/public_share').body, { tracker_id: TID, message: 'hi' });
  const cs = bodies.filter((r) => r.path.startsWith('/graph/4/bulk')).find((r) => r.body[0]._type === 'tracker_command_state');
  assert.deepEqual(cs.body.map((x) => x._id), ['trk00001_live_tracking', 'trk00001_led_control', 'trk00001_buzzer_control', 'trk00001_pos_request']);
});

test('geofence writes: create, versioned update, delete', async (t) => {
  const { client, mock } = await setup(t);
  const g = await client.createGeofence(TID, { name: 'Back', shape: 'CIRCLE', coords: [[41, 2]], radius: 20, fence_type: 'SAFE', active: true, icon: 'TRACTIVE' });
  const u = await client.updateGeofence({ ...g, name: 'Back 2' });
  assert.equal(u.name, 'Back 2');
  const stale = await client.updateGeofence({ ...g, _version: 'old' }).catch((e) => e);
  assert.equal(stale.status, 409);
  await client.deleteGeofence(g._id);
  const log = await calls(mock);
  assert.ok(log.some((r) => r.method === 'POST' && r.path === `/graph/4/geofence/tracker/${TID}/geofences`));
  const put = log.find((r) => r.method === 'PUT' && r.path.startsWith(`/graph/4/geofence/${g._id}?_version=`));
  assert.equal(put.path, `/graph/4/geofence/${g._id}?_version=${g._version}`);
  assert.equal(put.body._id, undefined);
  assert.ok(log.some((r) => r.method === 'DELETE' && r.path === `/graph/4/geofence/${g._id}`));
});

test('positions are flattened; bulk is chunked by 100; health is null on 400/403; photo and raw', async (t) => {
  const { client, mock } = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  const pts = await client.positions(TID, now - 48 * 3600, now);
  assert.ok(pts.length > 100);
  assert.ok(pts.every((p) => Array.isArray(p.latlong)));
  const before = (await calls(mock)).length;
  await client.bulk(Array.from({ length: 250 }, (_, i) => ({ _type: 'tracker_command_state', _id: `trk00001_x${i}` })));
  assert.equal((await calls(mock)).slice(before).filter((r) => r.path.startsWith('/graph/4/bulk')).length, 3);
  for (const status of [400, 403]) {
    await mock.post('/__mock/fail', { match: 'GET /aps/api/1/pet', status, times: 1 });
    assert.equal(await client.health(IDS.pet), null);
  }
  const photo = await client.petPhoto(IDS.picture);
  assert.equal(photo.type, 'image/png');
  assert.ok(Buffer.isBuffer(photo.buf) && photo.buf.length > 0);
  assert.equal((await client.raw('graph', 'GET', '/nope/thing')).status, 404);
  const raw = await client.raw('graph', 'GET', `/tracker/${TID}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.body.hw_id, TID);
  assert.equal(typeof raw.ms, 'number');
});

test('channel: connects, emits messages, reconnects after silence and after a drop', async (t) => {
  const { client, mock } = await setup(t);
  const msgs = [];
  const statuses = [];
  client.on('channel-message', (m) => msgs.push(m));
  client.on('channel-status', (s) => statuses.push({ ...s }));
  client.startChannel();
  await until(() => msgs.some((m) => m.message === 'tracker_status'));
  assert.equal(client.status().channel.connected, true);
  assert.equal(typeof client.status().channel.lastMessageAt, 'number');
  await mock.post('/__mock/channel/silence', { seconds: 2 });
  await until(() => client.status().channel.reconnects >= 1 && client.status().channel.connected, { timeout: 3000 });
  assert.ok(statuses.some((s) => s.connected === false));
  await mock.post('/__mock/channel/drop', {});
  await until(() => client.status().channel.reconnects >= 2 && client.status().channel.connected, { timeout: 3000 });
  client.stopChannel();
});

test('channel: a 401 re-authenticates once and connects', async (t) => {
  const { client, mock } = await setup(t);
  await client.login();
  await mock.post('/__mock/fail', { match: 'POST /channel/3/channel', status: 401, times: 1 });
  client.startChannel();
  await until(() => client.status().channel.connected, { timeout: 3000 });
  assert.equal(await authCalls(mock), 2);
});

test('channel: a hung connect is aborted after silenceMs and retried', async (t) => {
  const attempts = [];
  const fetch = (url, init) => {
    if (!String(url).includes('/channel/3/channel')) return globalThis.fetch(url, init);
    attempts.push(Date.now());
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const { client } = await setup(t, { fetch });
  client.startChannel();
  await until(() => attempts.length >= 2, { timeout: 2000 });
  assert.ok(attempts[1] - attempts[0] >= 350, `retried after ${attempts[1] - attempts[0]} ms`);
  assert.equal(client.status().channel.reconnects >= 1, true);
  client.stopChannel();
});

test('graph_sync: one debounced refresh per kind, at most one per window; other types ignored', async (t) => {
  const { client, mock } = await setup(t);
  const syncs = [];
  client.on('sync', (kind) => syncs.push({ kind, at: Date.now() }));
  client.startChannel();
  await until(() => client.status().channel.connected);
  const push = (type) => mock.post('/__mock/channel', { message: { message: 'graph_sync', targets: [{ type, _id: 'x' }] } });
  await push('geofence');
  await push('geofence');
  await push('pet');
  await until(() => syncs.length === 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(syncs.map((s) => s.kind), ['geofence']);
  await push('geofence');
  await until(() => syncs.length === 2, { timeout: 2000 });
  assert.ok(syncs[1].at - syncs[0].at >= 280, String(syncs[1].at - syncs[0].at));
});

test('errors never carry the token or the password', async (t) => {
  const { client, mock, dir } = await setup(t);
  await client.login();
  await mock.post('/__mock/fail', { match: `PUT /graph/4/tracker/${TID}/power_mode`, status: 400, times: 1, body: { code: 1, message: 'bad' } });
  const err = await client.setPowerMode(TID, 'LOW').catch((e) => e);
  const token = JSON.parse(fs.readFileSync(path.join(dir, '.tractive-token.json'), 'utf8')).access_token;
  for (const s of [err.message, String(err.stack), JSON.stringify(err), JSON.stringify(client.status())]) {
    assert.ok(!s.includes(token), 'token leaked');
    assert.ok(!s.includes('secret-pw'), 'password leaked');
  }
});
