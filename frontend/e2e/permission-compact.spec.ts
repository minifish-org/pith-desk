import {test,expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

interface PermissionFixture {review:{requests:Array<{path:string;body?:unknown}>};reviewState:{activeId:string};emitReview():void}
test('compact permission icons preserve full access confirmation and conversation scope',async ({page})=>{
  await page.setViewportSize({width:390,height:760});await page.addInitScript(installFixture);await page.goto('/');
  const trigger=page.getByRole('combobox',{name:'Conversation permissions',exact:true}),field=page.getByRole('textbox',{name:'Message Pith',exact:true});
  await expect(field).toBeEditable();await expect(trigger).toHaveAttribute('title','Ask before changes');
  await expect.poll(async () => (await trigger.boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(44);
  await field.fill('Keep this draft 中文');
  const scope=page.locator('.pui-permission-control'),glyph=()=>scope.locator(':scope > svg').first().innerHTML();
  const ask=await glyph();
  await trigger.click();await page.getByRole('option',{name:'Allow workspace changes',exact:true}).click();
  await expect(trigger).toHaveAttribute('title','Allow workspace changes');const workspace=await glyph();expect(workspace).not.toBe(ask);
  await trigger.click();await page.getByRole('option',{name:'Full access',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Enable full access?',exact:true});await expect(dialog).toBeVisible();
  await expect(trigger).toHaveAttribute('title','Allow workspace changes');expect(await glyph()).toBe(workspace);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as PermissionFixture).review.requests.filter(request=>request.path==='/api/permissions').map(request=>request.body))).toEqual([{id:'a',mode:'workspace-write'}]);
  await trigger.click();await page.getByRole('option',{name:'Full access',exact:true}).click();await dialog.getByRole('button',{name:'Enable full access',exact:true}).click();
  await expect(dialog).toHaveCount(0);await expect(trigger).toHaveAttribute('title','Full access');expect(await glyph()).not.toBe(workspace);expect(await glyph()).not.toBe(ask);
  await expect(field).toHaveValue('Keep this draft 中文');
  expect(await page.evaluate(()=>(window as unknown as PermissionFixture).review.requests.filter(request=>request.path==='/api/permissions').map(request=>request.body))).toEqual([{id:'a',mode:'workspace-write'},{id:'a',mode:'full-access'}]);
  await page.evaluate(()=>{const fixture=window as unknown as PermissionFixture;fixture.reviewState.activeId='b';fixture.emitReview();});await expect(trigger).toHaveAttribute('title','Ask before changes');expect(await glyph()).toBe(ask);
});
