import {expect, test} from './test.ts';
import {installFixture} from './fixture.mjs';

for (const populated of [false, true]) test(`expanding ${populated ? 'a populated' : 'an empty'} workspace only reveals its conversations`, async ({page}) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(populated => {
    if (populated) (window as any).reviewState.conversations.push({id: 'other-conversation', title: 'Other conversation', workspaceId: 'other', updatedAt: '', permissionMode: 'ask'});
  }, populated);
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).reviewSocket?.onmessage && !window.uiQuery<HTMLTextAreaElement>('[id$=composer-input]')!.readOnly);
  const before = await page.evaluate(() => ({activeId: (window as any).reviewState.activeId, count: (window as any).reviewState.conversations.length}));
  const toggle = page.locator('details').filter({has:page.locator('summary',{hasText:'Other workspace'})});
  await expect(toggle).toHaveJSProperty('open',false);
  await toggle.locator(':scope > summary').click();
  await expect(toggle).toHaveJSProperty('open',true);
  if (populated) await expect(page.getByRole('button',{name:'Other conversation',exact:true})).toBeVisible();
  const after = await page.evaluate(() => ({
    activeId: (window as any).reviewState.activeId,
    count: (window as any).reviewState.conversations.length,
    navigationWrites: (window as any).review.requests.filter((request: any) => request.method === 'POST' && ['/api/open', '/api/conversations'].includes(request.path)),
  }));
  expect(after).toEqual({...before, navigationWrites: []});
  await toggle.locator(':scope > summary').click();
  await expect(toggle).toHaveJSProperty('open',false);
});
