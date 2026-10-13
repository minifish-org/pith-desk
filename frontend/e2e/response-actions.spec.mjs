import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

const finalText = 'Installed the skill.\n\nCreated **SKILL.md**, metadata, and LICENSE.\n\n- All 10 rules verified.\n- Always-on mode is off.\n\n```text\nUse the i-have-adhd skill.\n```';
const finishedMessages = [
  { id: 'request', role: 'user', text: 'Install the skill' },
  { id: 'progress-1', role: 'assistant', text: "I'll check the instructions." },
  { id: 'tool-1', role: 'tool', toolName: 'read_file', text: 'Instructions', status: 'done' },
  { id: 'progress-2', role: 'assistant', text: "I'll use the workspace skill folder." },
  { id: 'tool-2', role: 'tool', toolName: 'write_file', text: 'Created the skill', status: 'done' },
  { id: 'final', role: 'assistant', branchNodeId: 'final-node', text: finalText },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(() => {
    window.copiedResponses = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => { window.copiedResponses.push(text); },
    } });
  });
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('#composer-input').readOnly);
});

test('a finished tool round has one action pair and copies the entire final response', async ({ page }, testInfo) => {
  await page.evaluate(messages => { window.reviewState.messages = messages; window.emitReview(); }, finishedMessages);
  await expect(page.locator('#messages [data-copy-message]')).toHaveCount(1);
  await expect(page.locator('#messages [data-sdk="branch"]')).toHaveCount(1);
  const final = page.locator('[data-reading-id="final"]');
  await expect(final.locator('.message-actions button')).toHaveCount(2);
  await expect(final.locator('[data-sdk="branch"]')).toHaveAttribute('data-node', 'final-node');
  await final.locator('[data-copy-message]').press('Enter');
  await expect(page.locator('#copy-status')).toHaveText('Response copied.');
  expect(await page.evaluate(() => window.copiedResponses)).toEqual([finalText]);
  await page.setViewportSize({ width: 900, height: 600 });
  await final.scrollIntoViewIfNeeded();
  await page.locator('#chat-scroll').screenshot({ path: `output/playwright/response-actions-${testInfo.project.name}.png` });
});

test('current actions stay hidden while streaming, awaiting approval, and settling, then appear on completion', async ({ page }) => {
  await page.evaluate(messages => {
    window.reviewState.messages = messages.slice(0, -1);
    window.reviewState.messages.push({ id: 'final', role: 'assistant', status: 'streaming', text: 'Installing…' });
    window.reviewState.running = true;
    window.emitReview();
  }, finishedMessages);
  await expect(page.locator('#messages .message-actions')).toHaveCount(0);
  await page.evaluate(() => {
    window.reviewState.messages.pop();
    window.reviewState.pendingApproval = { id: 'approval', toolName: 'write_file', args: { path: 'SKILL.md', content: 'skill' } };
    window.emitReview();
  });
  await expect(page.locator('#approval')).toContainText('Pith needs your permission');
  await expect(page.locator('#messages .message-actions')).toHaveCount(0);
  await page.evaluate(message => {
    window.reviewState.pendingApproval = null;
    window.reviewState.messages.push(message);
    window.emitReview();
  }, finishedMessages.at(-1));
  await expect(page.locator('[data-reading-id="final"]')).toContainText('Installed the skill.');
  await expect(page.locator('#messages .message-actions')).toHaveCount(0);
  // Only running changes: rendering must refresh actions even when the saved message is unchanged.
  await page.evaluate(() => { window.reviewState.running = false; window.emitReview(); });
  await expect(page.locator('#messages .message-actions')).toHaveCount(1);
  await expect(page.locator('[data-reading-id="final"] .message-actions button')).toHaveCount(2);
});

test('completed historical rounds retain their action pairs during the next round', async ({ page }) => {
  await page.evaluate(messages => {
    window.reviewState.messages = [...messages,
      { id: 'next-request', role: 'user', text: 'Explain how to activate it' },
      { id: 'next-progress', role: 'assistant', text: 'Checking activation instructions.' },
      { id: 'next-tool', role: 'tool', toolName: 'read_file', text: 'Instructions', status: 'running' },
    ];
    window.reviewState.running = true;
    window.emitReview();
  }, finishedMessages);
  await expect(page.locator('#messages .message-actions')).toHaveCount(1);
  await expect(page.locator('[data-reading-id="final"] .message-actions button')).toHaveCount(2);
  await page.evaluate(() => {
    window.reviewState.messages.at(-1).status = 'done';
    window.reviewState.messages.push({ id: 'next-final', role: 'assistant', branchNodeId: 'next-final-node', text: 'Say: Use the i-have-adhd skill.' });
    window.reviewState.running = false;
    window.emitReview();
  });
  await expect(page.locator('#messages .message-actions')).toHaveCount(2);
  await expect(page.locator('[data-reading-id="next-final"] .message-actions button')).toHaveCount(2);
  await page.locator('[data-copy-message="next-final"]').click();
  expect(await page.evaluate(() => window.copiedResponses)).toEqual(['Say: Use the i-have-adhd skill.']);
});

test('an interrupted response does not expose completed-response actions', async ({ page }) => {
  await page.evaluate(() => {
    window.reviewState.messages = [
      { id: 'request', role: 'user', text: 'Install the skill' },
      { id: 'partial', role: 'assistant', branchNodeId: 'partial-node', text: 'Installing', status: 'error' },
    ];
    window.emitReview();
  });
  await expect(page.locator('.message-error-label')).toHaveText('Response interrupted');
  await expect(page.locator('#messages .message-actions')).toHaveCount(0);
});
