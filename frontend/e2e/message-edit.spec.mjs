import { test, expect } from './test.ts';
import { installFixture } from './fixture.mjs';

const userText = '第一段完整内容。\n\n第二段 `code` 和 emoji 🐟。';
const timestamp = Date.parse('2026-10-13T13:53:00Z');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(({ text, timestamp }) => {
    window.copiedMessages = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMessages.push(text); } } });
    window.reviewState.messages = [
      { id: 'user', role: 'user', branchNodeId: 'user', text, timestamp },
      { id: 'reply', role: 'assistant', branchNodeId: 'reply', text: 'Original answer', timestamp: timestamp + 60000 },
    ];
  }, { text: userText, timestamp });
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !window.uiQuery('[id$=composer-input]').readOnly);
});

test('user copy preserves all paragraphs and both roles show their saved local time', async ({ page }, testInfo) => {
  const user = page.locator('ui=[data-reading-id="user"]');
  await user.getByRole('button', { name: 'Copy message', exact: true }).press('Enter');
  expect(await page.evaluate(() => window.copiedMessages)).toEqual([userText]);
  for (const [id, value] of [['user', timestamp], ['reply', timestamp + 60000]]) {
    const time = page.locator(`ui=[data-reading-id="${id}"] .pui-message-frame-meta`);
    const label = await page.evaluate(value => new Date(value).toLocaleString(), value);
    await expect(time).toHaveText(label);
    await expect(time).toContainText('2026');
  }
  await expect(user.getByRole('button', { name: 'Edit message', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 900, height: 600 });
  await page.locator('ui=[id$=chat-scroll]').screenshot({ path: `output/playwright/message-actions-${testInfo.project.name}.png` });
});

test('editing cancels without a mutation, and a rejected resend keeps the edited text and old reply', async ({ page }) => {
  await page.locator('ui=[data-edit-message="user"]').click();
  const text = page.locator('ui=.pui-text-edit textarea');
  await expect(text).toHaveValue(userText);
  await expect(text).toBeFocused();
  await text.fill('Canceled change');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.review.requests.filter(entry => entry.path === '/api/edit-message'))).toEqual([]);
  await page.evaluate(() => { window.review.failMutation = '/api/edit-message'; });
  await page.locator('ui=[data-edit-message="user"]').click();
  await text.fill('Revised question 中文');
  await page.getByRole('button', { name: 'Send again', exact: true }).click();
  await expect(page.locator('ui=.pui-text-edit .pui-notice')).toHaveText('Fixture action rejected');
  await expect(text).toHaveValue('Revised question 中文');
  await expect(page.locator('ui=[data-reading-id="reply"]')).toHaveText(/Original answer/);
  expect(await page.evaluate(() => window.review.requests.filter(entry => entry.path === '/api/edit-message').map(entry => entry.body))).toEqual([
    { id: 'a', messageId: 'user', expectedLastMessageId: 'reply', text: 'Revised question 中文' },
  ]);
});

test('editing cannot resend into a changed conversation or overwrite a newer reply', async ({ page }) => {
  await page.locator('ui=[data-edit-message="user"]').click();
  await page.locator('ui=.pui-text-edit textarea').fill('Keep this edit');
  await page.evaluate(() => { window.reviewState.activeId = 'b'; window.emitReview(); });
  await expect(page.getByRole('button', { name: 'Send again', exact: true })).toBeDisabled();
  await expect(page.locator('ui=.pui-text-edit textarea')).toHaveValue('Keep this edit');
  await page.evaluate(() => {
    window.reviewState.activeId = 'a';
    window.reviewState.messages.push({ id: 'new-reply', role: 'assistant', branchNodeId: 'new-reply', text: 'New answer' });
    window.emitReview();
  });
  await expect(page.getByRole('button', { name: 'Send again', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.review.requests.some(entry => entry.path === '/api/edit-message'))).toBe(false);
});

test('running tasks disable editing while user copy stays available', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.running = true; window.emitReview(); });
  await expect(page.locator('ui=[data-edit-message="user"]')).toBeDisabled();
  await expect(page.locator('ui=[data-copy-message="user"]')).toBeEnabled();
});
