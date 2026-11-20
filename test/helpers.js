// Shared test helpers: synthetic coordinates, fixed ids, a fake clock, temp dirs and a logged-in HTTP client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export const K = 111195.08; // metres per degree of latitude; src/geo.js uses the same R = 6371008.8 m
export const ORIGIN = Object.freeze({ lat: 41, lng: 2 });
export const ll = (x, y, o = ORIGIN) => ({ lat: o.lat + y / K, lng: o.lng + x / (K * Math.cos((o.lat * Math.PI) / 180)) });
// Square yard of side 2*half metres; vertex 0 is the south-west corner, then east, north, west.
export const square = (half = 20, o = ORIGIN) => [ll(-half, -half, o), ll(half, -half, o), ll(half, half, o), ll(-half, half, o)];
export const asPair = (p) => [p.lat, p.lng];

export const TID = 'TRK00001';
export const IDS = Object.freeze({
  user: '5f1a00000000000000000001', pet: '5f1a00000000000000000002', subscription: '5f1a00000000000000000003',
  yard: '5f1a00000000000000000010', pszIn: '5f1a00000000000000000020', pszOut: '5f1a00000000000000000021',
  share: '5f1a00000000000000000030', picture: '5f1a00000000000000000040',
});

export function tmpDir(name) {
  const base = process.env.OT_TEST_TMP ?? path.join(os.homedir(), '.cache', 'opentractive', 'tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${name}-`));
}

export function fakeClock(start = Date.UTC(2026, 10, 20, 10, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (ms) => { t = ms; }, s: () => Math.floor(t / 1000) };
}

export async function until(fn, { timeout = 3000, step = 20, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

// Environment for createApp() against an in-process mock (test/mock/server.js).
export const envFor = (mock, extra = {}) => ({
  TRACTIVE_EMAIL: 'owner@example.com', TRACTIVE_PASSWORD: 'secret-pw-123',
  TRACTIVE_GRAPH_URL: `${mock.url}/graph/4`, TRACTIVE_CHANNEL_URL: `${mock.url}/channel/3/channel`,
  TRACTIVE_APS_URL: `${mock.url}/aps/api/1`, TRACTIVE_TIMELINE_URL: `${mock.url}/timeline/api/1`,
  TRACTIVE_MIN_GAP_MS: '0', TELEGRAM_BOT_TOKEN: '', TELEGRAM_API_URL: `${mock.url}/telegram`, TZ: 'Europe/Madrid',
  ...extra,
});

// logs in; request() sends the cookie, an Origin and, for every method
// other than GET/HEAD, a JSON content type. server.js is imported lazily.
export async function startTestServer({ store, app, password = 'pw-test', failDelayMs = 0, config = {} }) {
  const { startServer } = await import('../src/server.js');
  const server = startServer({ store, app, config: { ...config, password }, port: 0, host: '127.0.0.1', log: () => {}, failDelayMs });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password }),
  });
  if (login.status !== 204) throw new Error(`test login failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (p, init = {}) => {
    const mutating = !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
    const headers = { cookie, origin: base, ...(mutating && { 'content-type': 'application/json' }), ...init.headers };
    return fetch(base + p, { redirect: 'manual', ...init, headers });
  };
  const close = () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); };
  return { base, cookie, request, close };
}
