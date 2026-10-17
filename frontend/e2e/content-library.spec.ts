import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';
import type { Message } from '../src/contract.generated';

type ContentTestWindow = Window & {
  reviewState: { messages: Message[]; settings: { appearance: string } };
  reviewSocket?: { onmessage?: unknown };
  copiedMessages: string[];
  review: {requests: Array<{path: string;body?: unknown}>};
  emitReview(): void;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(() => {
    const app = window as ContentTestWindow;
    app.copiedMessages = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { app.copiedMessages.push(text); } } });
    app.reviewState.messages = [
      { id: 'user', role: 'user', text: 'Question' },
      { id: 'progress', role: 'assistant', text: 'Progress message remains individually copyable.', status: 'done' },
      { id: 'tool-error', role: 'tool', toolName: 'read_file', status: 'error', text: 'Fixture missing' },
      { id: 'final', role: 'assistant', text: 'Final answer', status: 'done', branchNodeId: 'final-node' },
      { id: 'stream', role: 'assistant', text: 'Still streaming', status: 'streaming' },
      { id: 'empty', role: 'assistant', text: '', status: 'done' },
    ];
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as ContentTestWindow).reviewSocket?.onmessage && !(document.querySelector('textarea[aria-label="Message Pith"]') as HTMLTextAreaElement).readOnly);
});

test('library integration preserves per-message copy eligibility, host branch actions and stream transition', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toHaveCount(2);
  await expect(page.locator('[data-reading-id="progress"]').getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
  await expect(page.locator('[data-reading-id="stream"] button')).toHaveCount(0);
  await expect(page.locator('[data-reading-id="empty"] button')).toHaveCount(0);
  await expect(page.locator('[data-reading-id="user"]').getByRole('button', { name: 'Edit message', exact: true })).toBeVisible();
  const branch = page.locator('[data-reading-id="final"]').getByRole('button', { name: 'Branch from this message', exact: true });
  await expect(branch).toBeVisible();
  await page.locator('[data-reading-id="progress"]').getByRole('button', { name: 'Copy response', exact: true }).click();
  expect(await page.evaluate(() => (window as ContentTestWindow).copiedMessages)).toEqual(['Progress message remains individually copyable.']);
  await branch.click();
  expect(await page.evaluate(() => (window as ContentTestWindow).review.requests.filter(request => request.path === '/api/branch').map(request => request.body))).toEqual([{id: 'a',nodeId: 'final-node'}]);
  await page.evaluate(() => { const app = window as ContentTestWindow; app.reviewState.messages.find((message) => message.id === 'stream')!.status = 'done'; app.emitReview(); });
  await expect(page.locator('[data-reading-id="stream"]').getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
});

for (const appearance of ['light', 'dark']) {
  test(`tool error status and failed group retain semantic error color in ${appearance}`, async ({ page }) => {
    await page.evaluate((appearance) => { const app = window as ContentTestWindow; app.reviewState.settings.appearance = appearance; app.emitReview(); }, appearance);
    const failed = page.locator('.pui-tool-group-failed');
    await expect(failed).toHaveText('1 failed');
    const group = page.locator('.pui-tool-group').filter({ has: page.locator('[data-reading-id="tool-error"]') });
    await expect(group).toHaveCount(1);
    await group.locator(':scope > summary').click();
    await expect(group).toHaveJSProperty('open', true);
    const status = page.locator('[data-reading-id="tool-error"] .pui-tool-status-error');
    await expect(status).toBeVisible();
    await expect(status).toHaveText('error');
    const colors = await page.evaluate(() => {
      const probe = document.createElement('span'); probe.style.color = 'var(--pui-error-text)'; document.querySelector('.pui')!.append(probe);
      const error = getComputedStyle(probe).color; probe.remove();
      return { error, status: getComputedStyle(document.querySelector('.pui-tool-status-error')!).color, group: getComputedStyle(document.querySelector('.pui-tool-group-failed')!).color };
    });
    expect(colors.status).toBe(colors.error); expect(colors.group).toBe(colors.error);
  });
}
