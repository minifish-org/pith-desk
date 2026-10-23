import { test, expect, type Page } from '@playwright/test';
import { installFixture } from './fixture.mjs';

// Characterize the accepted queue policy before sharing its editor UI.
async function fixture(page: Page, imageOnly = false) {
  await page.addInitScript(installFixture);
  await page.addInitScript(({ imageOnly }) => {
    const scope = window as unknown as { reviewState: { running: boolean; queuedMessages: unknown[] } };
    scope.reviewState.running = true;
    scope.reviewState.queuedMessages = [{ id: 'queued', mode: 'follow-up', text: imageOnly ? '' : 'Pending 中文', imageCount: imageOnly ? 1 : 0 }];
  }, { imageOnly });
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Edit pending message', exact: true})).toBeEnabled();
  await page.getByRole('button', {name: 'Edit pending message', exact: true}).click();
  await expect(page.locator('[data-text-edit] textarea')).toBeFocused();
}

test('running tasks permit editing a pending message; failures keep its draft and target', async ({ page }) => {
  await fixture(page);
  await page.locator('[data-text-edit] textarea').fill('Revised pending 中文');
  await page.evaluate(() => { (window as any).review.failMutation = '/api/queue/edit'; });
  await page.getByRole('button', { name: 'Save message', exact: true }).click();
  await expect(page.locator('[data-text-edit] [role=alert]')).toHaveText('Fixture action rejected');
  await expect(page.locator('[data-text-edit] textarea')).toHaveValue('Revised pending 中文');
  expect(await page.evaluate(() => (window as any).review.requests.filter((entry: any) => entry.path === '/api/queue/edit').map((entry: any) => entry.body))).toEqual([
    { id: 'a', messageId: 'queued', text: 'Revised pending 中文' },
  ]);
});

test('a removed pending message keeps copyable text and cannot be submitted', async ({ page }) => {
  await fixture(page);
  await page.locator('[data-text-edit] textarea').fill('Keep this draft');
  await page.evaluate(() => { (window as any).reviewState.queuedMessages = []; (window as any).emitReview(); });
  await expect(page.getByRole('button', { name: 'Save message', exact: true })).toBeDisabled();
  await expect(page.locator('[data-text-edit] textarea')).toHaveValue('Keep this draft');
  await expect(page.locator('[data-text-edit] textarea')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).review.requests.some((entry: any) => entry.path === '/api/queue/edit'))).toBe(false);
});

test('switching conversations does not retarget an open pending editor', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).reviewState.activeId = 'b'; (window as any).emitReview(); });
  await expect(page.getByRole('button', { name: 'Save message', exact: true })).toBeDisabled();
  await expect(page.locator('[data-text-edit] textarea')).toHaveValue('Pending 中文');
});

test('an image-only queued message remains saveable and cancel sends no write', async ({ page }) => {
  await fixture(page, true);
  await expect(page.getByRole('button', { name: 'Save message', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).review.requests.some((entry: any) => entry.path === '/api/queue/edit'))).toBe(false);
});
