import {test, expect} from './test.ts';
import {installFixture} from './fixture.mjs';

test('streaming and draft input leave unchanged historical message content untouched', async ({page}) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(() => {window.reviewState.messages[0].timestamp = 1791899580000; window.reviewState.messages[0].text = 'Saved historical text 中文 '.repeat(1000);});
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !window.uiQuery<HTMLTextAreaElement>('[id$=composer-input]')!.readOnly);
  expect((await page.locator('[data-reading-id="user"]').getAttribute('data-render-version'))!.length).toBeLessThanOrEqual(32);
  await page.evaluate(() => {
    const row = document.querySelector('[data-reading-id="user"]')!;
    const changes: string[] = [];
    const observer = new MutationObserver(records => changes.push(...records.map(record => record.type)));
    observer.observe(row, {subtree: true, childList: true, characterData: true});
    Object.assign(window, {historyChanges: changes, historyObserver: observer});
  });
  await page.evaluate(() => {window.reviewState.messages.at(-1)!.text += ' next chunk'; window.emitReview();});
  await page.getByRole('textbox', {name: 'Message Pith', exact: true}).pressSequentially('A draft');
  await expect(page.getByText('A streaming answer next chunk', {exact: true})).toBeVisible();
  const changes = await page.evaluate(() => {
    const scope = window as unknown as {historyObserver: MutationObserver; historyChanges: string[]};
    scope.historyObserver.disconnect();
    return scope.historyChanges;
  });
  expect(changes).toEqual([]);
});

test('unchanged welcome actions retain their focus through an unrelated snapshot',async({page})=>{
  await page.addInitScript(installFixture);
  await page.addInitScript(()=>{window.reviewState.messages=[];});
  await page.goto('/');
  const action=page.getByRole('button',{name:'Explore my workspace',exact:true});
  await action.focus();
  await page.evaluate(()=>{window.reviewState.runtime.usage.input++;window.emitReview();});
  await expect(action).toBeFocused();
});

test('reusing an availability object still applies a changed message action state',async({page})=>{
  await page.route('**/message-availability.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><div id="app"></div>'}));
  await page.goto('/message-availability.html');
  await page.evaluate(async()=>{const {mountApplication}=await import('/src/ui-mount.ts');const ui=mountApplication();const availability={copy:false};ui.workspace.updateConversation({id:'saved',messages:[{id:'answer',role:'assistant',text:'Saved response',status:'done',actions:{copy:'Copy response'}}],working:false});ui.workspace.updateMessageAvailability(availability);Object.assign(window,{messageAvailability:{ui,availability}});});
  const copy=page.getByRole('button',{name:'Copy response',exact:true});await expect(copy).toBeEnabled();
  await page.evaluate(()=>{const state=Reflect.get(window,'messageAvailability');state.availability.copy=true;state.ui.workspace.updateMessageAvailability(state.availability);});
  await expect(copy).toBeDisabled();
});
