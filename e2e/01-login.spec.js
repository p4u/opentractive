import { test, expect } from '@playwright/test';
import { PASSWORD, stubTiles } from './helpers.js';

test('login: a wrong password shows an error, the right one opens Live; every view is reachable', async ({ page }) => {
  await stubTiles(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.fill('#password', 'wrong');
  await page.click('#submit');
  await expect(page.locator('#login-error-text')).toHaveText('Wrong password');
  await page.fill('#password', PASSWORD);
  await page.click('#submit');
  await expect(page.locator('main h1')).toHaveText('Live');
  for (const [hash, title] of [['#/history', 'History'], ['#/escapes', 'Escapes'], ['#/fences', 'Fences'], ['#/alerts', 'Alerts'], ['#/tracker', 'Tracker'], ['#/pet', 'Pet'], ['#/telegram', 'Telegram'], ['#/lab', 'Lab']]) {
    await page.goto(`/${hash}`);
    await expect(page.locator('main h1')).toHaveText(title);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/');
  await expect(page.locator('.tabbar')).toBeVisible();
  await page.locator('.tabbar [data-action="sheet"]').click();
  await expect(page.locator('#more-sheet a[data-route="lab"]')).toBeVisible();
});
