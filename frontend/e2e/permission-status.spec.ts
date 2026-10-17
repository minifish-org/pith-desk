import {test,expect} from './test.ts';
import {installFixture} from './fixture.mjs';

test('full access retains a visible warning and returning to workspace permission removes it',async({page})=>{
  await page.addInitScript(installFixture);await page.goto('/');
  await expect(page.getByRole('textbox',{name:'Message Pith',exact:true})).toBeEditable();
  await page.waitForFunction(()=>Reflect.get(window,'reviewSocket')?.onmessage);
  await page.evaluate(()=>{const state=Reflect.get(window,'reviewState');state.conversations[0].permissionMode='full-access';Reflect.get(window,'emitReview')();});
  const warning=page.getByRole('alert').filter({hasText:'Full access:'});
  await expect(warning).toBeVisible();await expect(warning).toHaveClass(/pui-notice-warning/);
  await expect(warning).toContainText('There is no OS sandbox.');
  await page.evaluate(()=>{const state=Reflect.get(window,'reviewState');state.conversations[0].permissionMode='workspace-write';Reflect.get(window,'emitReview')();});
  await expect(warning).toBeHidden();
  await expect(page.getByRole('combobox',{name:'Conversation permissions',exact:true})).toContainText('Allow workspace changes');
});
