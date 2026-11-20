import { test, expect } from '@playwright/test';
import { login, fix, tgSent, graphCalls, ll, distM, nowS, TID, IDS } from './helpers.js';

test('a scripted escape: banner and Telegram within 5 s, chase starts live tracking, episode good with the crossing and peak within 3 m', async ({ page, request }) => {
  await login(page);
  await expect(page.locator('#main h1')).toBeVisible(); // login() can return on the login page itself; wait for the shell
  const s = await (await page.request.get('/api/settings')).json();
  expect(s.settings.yardGeofenceId ?? IDS.yard).toBe(IDS.yard);
  await page.goto('/#/escapes');
  await expect(page.locator('main h1')).toHaveText('Escapes');
  const start = Date.now();
  // positive offsets keep every fix newer than anything an earlier spec pushed (older fixes are ignored by the live state)
  await fix(request, 10, 5, { dtS: 0 });     // inside
  await fix(request, 16, 5, { dtS: 3 });     // inside, last fix before the fence
  await fix(request, 26, 5, { dtS: 6 });     // 6 m out: uncertain, first fix past the fence
  await fix(request, 34, 5, { dtS: 9 });     // 14 m out: out_possible
  const t0 = Date.now();
  await fix(request, 45, 5, { dtS: 12 });    // second outside fix: out_confirmed (critical)
  await expect(page.getByTestId('alert-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('alert-banner')).toContainText('OUT of the yard');
  expect(Date.now() - t0).toBeLessThan(5000);
  await expect.poll(async () => (await tgSent(request, t0)).some((m) => m.method === 'sendMessage' && String(m.body.chat_id) === '1001' && m.body.text.includes('OUT of the yard')),
    { timeout: 5000, intervals: [100] }).toBe(true);
  expect(Date.now() - t0).toBeLessThan(5000);
  await expect.poll(async () => (await tgSent(request, start)).some((m) => m.method === 'sendLocation' && String(m.body.chat_id) === '1001'), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await graphCalls(request, start)).some((r) => r.path === `/graph/4/tracker/${TID}/command/live_tracking/on`), { timeout: 45_000 }).toBe(true);
  const body = await (await page.request.get(`/api/escapes?tracker=${TID}&from=${nowS() - 3600}&to=${nowS() + 60}`)).json();
  const ep = body.episodes.at(-1);
  expect(ep.quality).toBe('good');
  expect(distM(ep.crossing, ll(20, 5))).toBeLessThan(3);
  expect(distM(body.peaks[0], ll(20, 5))).toBeLessThan(3);
  await page.reload();
  await expect(page.getByTestId('escape-row').first()).toContainText('Good');
  await expect(page.getByTestId('escapes-peaks')).toContainText('seen 1 time');
  await fix(request, 0, 0, { dtS: 15 });
  await expect(page.getByTestId('alert-banner')).toBeHidden({ timeout: 5000 });
  await expect.poll(async () => (await tgSent(request, t0)).some((m) => m.method === 'sendMessage' && m.body.text.includes('Back in the yard'))).toBe(true);
});
