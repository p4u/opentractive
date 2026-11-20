import { test, expect } from '@playwright/test';
import { login, fix, mockPost, tgSent, graphCalls, ll, distM, nowS, TID, IDS, KITCHEN_PIN } from './helpers.js';

test('an escape from a home Wi-Fi zone: critical within 5 s of left_psz, chase on, episode quality none with the note', async ({ page, request }) => {
  await login(page);
  await page.goto('/#/');
  // offsets start at +20 s so these fixes are newer than the last fix of 04 (pushed at +15 s)
  await fix(request, 0, 0, { at: KITCHEN_PIN, acc: 30, sensor: 'KNOWN_WIFI', pszId: IDS.pszIn, dtS: 20 });
  await fix(request, 0, 0, { at: KITCHEN_PIN, acc: 30, sensor: 'KNOWN_WIFI', pszId: IDS.pszIn, dtS: 22 });
  await expect(page.getByTestId('status-line')).toContainText('In Wi-Fi zone Kitchen');
  const t0 = Date.now();
  await mockPost(request, '/__mock/channel', { message: { message: 'tracker_status', tracker_id: TID, power_saving_zone_id: null, tracker_state_reason: null,
    hardware: { time: nowS() + 23, battery_level: 80, power_saving_zone_id: null } } });
  await expect(page.getByTestId('alert-banner')).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('alert-banner')).toContainText('Left Wi-Fi zone Kitchen');
  expect(Date.now() - t0).toBeLessThan(5000);
  await expect.poll(async () => (await tgSent(request, t0)).some((m) => m.method === 'sendMessage' && String(m.body.chat_id) === '1001' && m.body.text.includes('Left Wi-Fi zone Kitchen')),
    { timeout: 5000, intervals: [100] }).toBe(true);
  expect(Date.now() - t0).toBeLessThan(5000);
  await fix(request, 0, 60, { dtS: 25 });   // 40 m north of the fence: confirmed at once
  await fix(request, 0, 80, { dtS: 28 });
  await expect.poll(async () => {
    const st = await (await page.request.get('/api/state')).json();
    return Boolean(st.monitor.chase) && st.monitor.live.wanted === true;
  }, { timeout: 5000 }).toBe(true);
  await expect.poll(async () => {
    const st = await (await page.request.get('/api/state')).json();
    const sentOn = (await graphCalls(request, t0)).some((r) => r.path === `/graph/4/tracker/${TID}/command/live_tracking/on`);
    return sentOn || st.trackers[0].controls.live.active === true;
  }, { timeout: 45_000 }).toBe(true);
  const body = await (await page.request.get(`/api/escapes?tracker=${TID}&from=${nowS() - 3600}&to=${nowS() + 60}`)).json();
  const ep = body.episodes.at(-1);
  expect(ep.quality).toBe('none');
  expect(ep.crossing).toBeNull();
  expect(ep.note).toBe('dog left Wi-Fi zone Kitchen: no GPS before the exit');
  expect(distM(ep.firstOutside, ll(0, 60))).toBeLessThan(2);
  await page.getByTestId('alert-banner').getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByTestId('alert-banner')).toBeHidden();
  await fix(request, 0, 0, { dtS: 30 });
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).monitor.incident).toBeNull();
});
