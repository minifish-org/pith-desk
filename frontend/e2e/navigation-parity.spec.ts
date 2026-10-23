import {expect, test} from '@playwright/test';
import {installFixture} from './fixture.mjs';

for (const populated of [false, true]) test(`expanding ${populated ? 'a populated' : 'an empty'} workspace only reveals its conversations`, async ({page}) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(populated => {
    if (populated) (window as any).reviewState.conversations.push({id: 'other-conversation', title: 'Other conversation', workspaceId: 'other', updatedAt: '', permissionMode: 'ask'});
  }, populated);
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!.readOnly);
  const before = await page.evaluate(() => ({activeId: (window as any).reviewState.activeId, count: (window as any).reviewState.conversations.length}));
  const toggle = page.getByRole('button', {name: 'Other workspace', exact: true});
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  if (populated) await expect(page.getByRole('button', {name: 'Other conversation', exact: true})).toBeVisible();
  const after = await page.evaluate(() => ({
    activeId: (window as any).reviewState.activeId,
    count: (window as any).reviewState.conversations.length,
    navigationWrites: (window as any).review.requests.filter((request: any) => request.method === 'POST' && ['/api/open', '/api/conversations'].includes(request.path)),
  }));
  expect(after).toEqual({...before, navigationWrites: []});
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
