import { test, expect } from '@playwright/test';
import { login, mockPost, tgSent } from './helpers.js';

test('telegram: pair a chat through the mock', async ({ page, request }) => {
  await login(page);
  await page.goto('/#/telegram');
  await expect(page.locator('main h1')).toHaveText('Telegram');
  await expect(page.getByTestId('tg-status')).toContainText('@opentractive_test_bot');
  await expect(page.locator('[data-testid="tg-chat-row"][data-id="1001"]')).toBeVisible();
  await page.getByTestId('tg-pair').click();
  const code = (await page.getByTestId('tg-code').textContent()).trim();
  expect(code).toMatch(/^\d{6}$/);
  const since = Date.now();
  await mockPost(request, '/__mock/telegram/update', { update: { message: { message_id: 1, chat: { id: 1002, type: 'private', first_name: 'E2E' }, from: { id: 1002, is_bot: false, first_name: 'E2E' }, text: `/start ${code}` } } });
  await expect(page.locator('[data-testid="tg-chat-row"][data-id="1002"]')).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await tgSent(request, since)).some((s) => s.method === 'sendMessage' && String(s.body.chat_id) === '1002')).toBe(true);
  await page.getByTestId('tg-test').click();
  await expect(page.locator('.toast')).toContainText('Sent to');
});
