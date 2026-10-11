import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('#composer-input').readOnly);
});

test('stream updates preserve historical selection, code scroll and focus', async ({ page }) => {
  const result = await page.evaluate(() => {
    const range = document.createRange(), selection = getSelection();
    range.selectNodeContents(document.querySelector('.user-text'));
    selection.removeAllRanges(); selection.addRange(range);
    const pre = document.querySelector('.code-block pre'); pre.scrollLeft = 100;
    const historical = document.querySelector('[data-reading-id="old-answer"]');
    window.reviewState.messages.at(-1).text += ' updated'; window.emitReview();
    return { selected: selection.toString(), scroll: pre.scrollLeft, sameNode: historical === document.querySelector('[data-reading-id="old-answer"]') };
  });
  expect(result).toEqual({ selected: 'Stable historical text to select', scroll: 100, sameNode: true });
  await page.locator('[data-copy-message="old-answer"]').focus();
  await page.evaluate(() => { window.reviewState.messages.at(-1).text += ' again'; window.emitReview(); });
  await expect(page.locator('[data-copy-message="old-answer"]')).toBeFocused();
});

test('text and image drafts restore together after switching and reload', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([png], 'draft-image.png', { type: 'image/png' }));
    const picker = document.querySelector('#image-picker'); picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.draft-image')).toHaveCount(1);
  await page.locator('#composer-input').fill('Keep this draft');
  await page.evaluate(() => { window.reviewState.activeId = 'b'; window.emitReview(); });
  await expect(page.locator('.draft-image')).toHaveCount(0);
  await expect(page.locator('#composer-input')).toHaveValue('');
  await page.evaluate(() => { window.reviewState.activeId = 'a'; window.emitReview(); });
  await expect(page.locator('.draft-image')).toHaveCount(1);
  await expect(page.locator('#composer-input')).toHaveValue('Keep this draft');
  // Host storage lives outside a browser origin; seed it into a fresh frontend.
  await page.locator('#composer-input').blur();
  await expect.poll(() => page.evaluate(() => window.review.drafts.a?.images?.length)).toBe(1);
  const saved = await page.evaluate(() => window.review.drafts.a);
  await page.addInitScript((draft) => { window.review.drafts.a = draft; }, saved);
  await page.reload();
  await expect(page.locator('.draft-image')).toHaveCount(1);
  await expect(page.locator('#composer-input')).toHaveValue('Keep this draft');
});

test('stream snapshots cannot enable a model picker still loading', async ({ page }) => {
  await page.evaluate(() => { window.review.holdModels = true; });
  await page.locator('#composer-model').click();
  await expect(page.locator('#choose-model')).toBeDisabled();
  await page.evaluate(() => { window.reviewState.runtime.contextTokens++; window.emitReview(); });
  await expect(page.locator('#choose-model')).toBeDisabled();
  await page.evaluate(() => window.releaseModels());
  await expect(page.locator('#choose-model')).toBeEnabled();
});

test('a committed create operation reports refresh trouble without a retry', async ({ page }) => {
  await page.locator('[data-new-workspace="w"]').click();
  await expect(page.locator('#inline-error')).toContainText('Change saved.');
  expect(await page.evaluate(() => window.reviewState.conversations.filter(c => c.id.startsWith('created-')).length)).toBe(1);
  await page.evaluate(() => window.emitReview());
  await expect(page.locator('#conversation-label')).toHaveText('New conversation');
});

test('resource edits keep the dialog workspace after a notification switches conversations', async ({ page }) => {
  await page.locator('[data-action="resources"]').click();
  await page.evaluate(() => { window.reviewState.activeId = 'b'; window.reviewState.conversations.find(c => c.id === 'b').workspaceId = 'other'; window.emitReview(); });
  await page.locator('#resources-content [data-kind="skill"]').click();
  await expect(page.locator('#sdk-content .file-path')).toHaveText('/tmp/pith-review');
  await page.locator('#resource-name').fill('fixture-skill');
  await page.locator('#resource-form [type="submit"]').click();
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/resource').body.workspaceId)).toBe('w');
});
