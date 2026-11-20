import { test, expect } from '@playwright/test';
import { login, TID } from './helpers.js';

test('History shows the track, stats, playback and the GPX link', async ({ page }) => {
  await login(page);
  await page.goto('/#/history?r=6h');
  await expect(page.locator('main h1')).toHaveText('History');
  await expect(page.locator('[data-testid="history-map"] .leaflet-overlay-pane path').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('history-stats')).toContainText('Fixes');
  await expect(page.getByTestId('history-gpx')).toHaveAttribute('href', new RegExp(`/api/positions\\.gpx\\?tracker=${TID}&from=\\d+&to=\\d+`));
  await page.getByTestId('history-play').click();
  await expect.poll(async () => Number(await page.getByTestId('history-slider').inputValue()), { timeout: 5000 }).toBeGreaterThan(0);
  await page.getByTestId('history-play').click();
  await page.getByTestId('history-backfill').click();
  await page.locator('dialog [data-yes]').click();
  await expect(page.locator('.toast')).toContainText('in the background');
});
