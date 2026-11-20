import { test, expect } from '@playwright/test';
import { login, TID } from './helpers.js';

test('lab: a console GET, the channel log, raw objects and fields', async ({ page }) => {
  await login(page);
  await page.goto('/#/lab');
  await expect(page.locator('main h1')).toHaveText('Lab');
  await page.getByTestId('lab-tab-console').click();
  await page.getByTestId('lab-console-path').fill(`/tracker/${TID}`);
  await page.getByTestId('lab-console-send').click();
  await expect(page.getByTestId('lab-console-response')).toContainText(`"hw_id": "${TID}"`);
  await page.getByTestId('lab-tab-channel').click();
  await expect(page.getByTestId('lab-channel-list')).toContainText('tracker_status');
  await page.getByTestId('lab-tab-raw').click();
  await expect(page.getByTestId('lab-raw-list')).toContainText(`tracker:${TID}`);
  await page.getByTestId('lab-tab-fields').click();
  await expect(page.getByTestId('lab-fields-table')).toContainText('capabilities');
});
