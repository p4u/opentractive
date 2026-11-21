import { test, expect } from '@playwright/test';
import { login, graphCalls, IDS } from './helpers.js';

const zoneId = async (request) => (await graphCalls(request)).filter((r) => r.method === 'PUT' && r.path.includes(`/power_saving_zone/${IDS.pszIn}`)).at(-1)?.body?.zone_id;

test('Live: the Wi-Fi zone switch turns the zones covering the yard off and back on', async ({ page, request }) => {
  await login(page);
  const toggle = page.getByTestId('zone-toggle');
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('zone-status')).toContainText('Wi-Fi zone active');
  await toggle.check();
  await expect.poll(() => zoneId(request), { timeout: 15_000 }).toBe('a0:00:00:00:00:01~ot-off');
  await expect(page.getByTestId('zone-status')).toContainText('Off: GPS in the yard');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => zoneId(request), { timeout: 15_000 }).toBe('a0:00:00:00:00:01');
  await expect(page.getByTestId('zone-status')).toContainText('Wi-Fi zone active');
});
