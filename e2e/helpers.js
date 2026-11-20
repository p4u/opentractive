import { expect } from '@playwright/test';
export const MOCK = process.env.E2E_MOCK_URL ?? 'http://mock:9000';
export const PASSWORD = process.env.E2E_PASSWORD ?? 'e2e-password-123';
export const TID = 'TRK00001';
export const IDS = { yard: '5f1a00000000000000000010', pszIn: '5f1a00000000000000000020', pszOut: '5f1a00000000000000000021', pet: '5f1a00000000000000000002' };
export const KITCHEN_PIN = { lat: 41.000045, lng: 1.99994 };
const K = 111195.08;
const COS = Math.cos((41 * Math.PI) / 180);
export const ll = (x, y) => ({ lat: 41 + y / K, lng: 2 + x / (K * COS) });
export const distM = (a, b) => Math.hypot((a.lat - b.lat) * K, (a.lng - b.lng) * K * COS);
export const nowS = () => Math.floor(Date.now() / 1000);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export async function stubTiles(page) {
  await page.route(/tile\.openstreetmap\.org|server\.arcgisonline\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
}
export async function login(page) {
  await stubTiles(page);
  await page.goto('/login');
  await page.fill('#password', PASSWORD);
  await page.click('#submit');
  await page.waitForURL((u) => !u.pathname.startsWith('/login')); // /login has its own main h1: wait for the redirect
  await expect(page.locator('main h1')).toBeVisible();
}
export async function mockPost(request, path, body = {}) {
  const r = await request.post(MOCK + path, { data: body });
  expect(r.ok()).toBeTruthy();
  return r.json();
}
export const mockGet = async (request, path) => (await request.get(MOCK + path)).json();
export const fix = (request, x, y, { acc = 5, sensor = 'GPS', pszId, dtS = 0, at } = {}) =>
  mockPost(request, '/__mock/fix', { ...(at ?? ll(x, y)), acc, sensor, ...(pszId && { pszId }), dtS });
export const graphCalls = async (request, since = 0) => (await mockGet(request, '/__mock/requests?host=graph')).filter((r) => r.at >= since);
export const tgSent = async (request, since = 0) => (await mockGet(request, '/__mock/telegram/sent')).filter((s) => s.at >= since);
export const sawGraph = (request, since, method, part, body) => expect.poll(async () => (await graphCalls(request, since))
  .some((r) => r.method === method && r.path.includes(part) && (!body || JSON.stringify(r.body) === JSON.stringify(body))), { timeout: 15_000 }).toBe(true);
