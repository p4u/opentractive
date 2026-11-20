import { test, expect } from '@playwright/test';
import { login } from './helpers.js';

const VIEWS = ['', 'history', 'escapes', 'fences', 'alerts', 'tracker', 'pet', 'telegram', 'lab'];
for (const [w, h] of [[1440, 900], [390, 844]]) {
  for (const scheme of ['light', 'dark']) {
    test(`screens ${w} ${scheme}: every view renders without console errors`, async ({ page }) => {
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await login(page);
      for (const v of VIEWS) {
        await page.goto(`/#/${v}`);
        await expect(page.locator('main h1')).toBeVisible();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `test-results/screens/${v || 'live'}-${w}-${scheme}.png`, fullPage: true });
      }
      expect(errors).toEqual([]);
    });
  }
}
