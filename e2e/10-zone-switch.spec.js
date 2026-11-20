import { test, expect } from '@playwright/test';
import { login, fix, graphCalls, IDS } from './helpers.js';

// the zone_id of the last PUT the app sent for the zone (the mock's Tractive API itself needs a login token)
const zoneId = async (request) => (await graphCalls(request)).filter((r) => r.method === 'PUT' && r.path.includes(`/power_saving_zone/${IDS.pszIn}`)).at(-1)?.body?.zone_id;

test('Wi-Fi zone switch: off from the Tracker page, GPS confirms it, back on restores the Wi-Fi name', async ({ page, request }) => {
  const t0 = Date.now();
  await login(page);
  await page.goto('/#/tracker');
  const row = page.locator(`[data-testid="psz-row"][data-id="${IDS.pszIn}"]`);
  await expect(row.getByTestId('psz-status')).toContainText('On:');

  await row.getByTestId('psz-switch').click();
  await page.locator('dialog [data-yes]').click();
  await expect.poll(async () => (await graphCalls(request, t0)).some((r) => r.method === 'PUT' && r.path.includes(`/power_saving_zone/${IDS.pszIn}`)), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => zoneId(request)).toBe('a0:00:00:00:00:01~ot-off');
  await expect(row.getByTestId('psz-status')).toContainText('waiting for the tracker to move');

  await fix(request, 0, 0, { acc: 6, sensor: 'GPS', dtS: 5 }); // the tracker wakes up and reports GPS inside the zone
  await expect(row.getByTestId('psz-status')).toContainText('GPS confirmed', { timeout: 15_000 }); // live, no reload
  await page.goto('/#/');
  await expect(page.getByTestId('zone-off-status')).toContainText('GPS confirmed', { timeout: 15_000 });

  await page.goto('/#/tracker');
  await row.getByTestId('psz-switch').click();
  await expect.poll(() => zoneId(request), { timeout: 15_000 }).toBe('a0:00:00:00:00:01');
  await expect(row.getByTestId('psz-status')).toContainText('On:');
});
