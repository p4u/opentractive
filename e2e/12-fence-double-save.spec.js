import { test, expect } from '@playwright/test';
import { login, graphCalls, IDS } from './helpers.js';

test('fences: a double click on Save shape sends one save, never a second one with a stale version', async ({ page, request }) => {
  await login(page);
  await page.goto('/#/fences');
  const row = page.locator(`[data-testid="fence-row"][data-id="${IDS.yard}"]`);
  await row.getByTestId('fence-edit').click();
  const since = Date.now();
  await row.getByTestId('fence-edit-save').dblclick();
  await expect(page.locator(`[data-testid="fence-row"][data-id="${IDS.yard}"]`).getByTestId('fence-edit')).toBeVisible(); // reloaded
  const puts = (await graphCalls(request, since)).filter((r) => r.method === 'PUT' && r.path.startsWith(`/graph/4/geofence/${IDS.yard}`));
  expect(puts).toHaveLength(1);
  await expect(page.locator('[data-err] .field-error')).toHaveCount(0);
});
