import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

interface PermissionFixture {review: {requests: Array<{path: string; body?: unknown}>}; reviewState: {activeId: string}; emitReview(): void}

test('compact permission control preserves full access confirmation and conversation scope', async ({page}) => {
  await page.setViewportSize({width: 390, height: 760});
  await page.addInitScript(installFixture);
  await page.goto('/');
  const trigger = page.getByRole('button', {name: 'Conversation permissions', exact: true});
  const field = page.getByRole('textbox', {name: 'Message Pith', exact: true});
  await expect(field).toBeEditable();
  await expect(trigger).toHaveAttribute('title', 'Ask before changes');
  await expect.poll(async () => (await trigger.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(44);
  await field.fill('Keep this draft 中文');
  await trigger.click();
  await page.getByRole('menuitem', {name: /Allow workspace changes/}).click();
  await expect(trigger).toHaveAttribute('title', 'Allow workspace changes');
  await trigger.click();
  await page.getByRole('menuitem', {name: /Full access/}).click();
  const dialog = page.getByRole('dialog', {name: 'Enable full access?', exact: true});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveAttribute('title', 'Allow workspace changes');
  expect(await page.evaluate(() => (window as unknown as PermissionFixture).review.requests.filter(request => request.path === '/api/permissions').map(request => request.body)))
    .toEqual([{id: 'a', mode: 'workspace-write'}]);
  await trigger.click();
  await page.getByRole('menuitem', {name: /Full access/}).click();
  await dialog.getByRole('button', {name: 'Enable full access', exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveAttribute('title', 'Full access');
  await expect(field).toHaveValue('Keep this draft 中文');
  expect(await page.evaluate(() => (window as unknown as PermissionFixture).review.requests.filter(request => request.path === '/api/permissions').map(request => request.body)))
    .toEqual([{id: 'a', mode: 'workspace-write'}, {id: 'a', mode: 'full-access'}]);
  await page.evaluate(() => {const fixture = window as unknown as PermissionFixture; fixture.reviewState.activeId = 'b'; fixture.emitReview();});
  await expect(trigger).toHaveAttribute('title', 'Ask before changes');
});
