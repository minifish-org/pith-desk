import {test,expect} from '@playwright/test';

test.beforeEach(async ({page}) => {
  await page.route('**/form-ownership.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  await page.goto('/form-ownership.html');
});

test('provider actions report to their own form while the SDK dialog is closed',async ({page}) => {
  const result = await page.evaluate(async () => {
    const library = '/node_modules/pith-ui/dist/index.js',adapter = '/src/sdk-dialog.ts';
    const [{createSettingsPanel,createSDKDialogElements},{createSDKDialog}] = await Promise.all([import(library),import(adapter)]);
    const elements = createSDKDialogElements({idPrefix:''}); document.body.append(elements.dialog,elements.oauthDialog);
    const native = document.createElement('dialog'); document.body.append(native);
    const panel = createSettingsPanel({baseUrl:'https://example.com',hasApiKey:true,ready:true},{idPrefix:''}); native.append(panel.element); native.showModal();
    const dialog = createSDKDialog({mutate:async()=>false,error:()=> 'Provider rejected'});
    const saved = await dialog.act('/api/oauth/start',{provider:'example'},native);
    const result = {saved,settings:panel.element.querySelector('[data-dialog-error]')!.textContent,appearance:panel.element.querySelector('[id$=appearance-error]')!.textContent,sdkOpen:elements.dialog.open};
    dialog.destroy(); panel.destroy(); native.remove(); elements.destroy(); return result;
  });
  expect(result).toEqual({saved:false,settings:'Provider rejected',appearance:'',sdkOpen:false});
});

test('a replaced provider form cannot receive an older action failure',async ({page}) => {
  const result = await page.evaluate(async () => {
    const library = '/node_modules/pith-ui/dist/index.js',adapter = '/src/sdk-dialog.ts';
    const [{createSettingsPanel,createSDKDialogElements},{createSDKDialog}] = await Promise.all([import(library),import(adapter)]);
    const elements = createSDKDialogElements({idPrefix:''}); document.body.append(elements.dialog,elements.oauthDialog);
    const native = document.createElement('dialog'); document.body.append(native);
    const state = {baseUrl:'https://example.com',hasApiKey:true,ready:true};
    const original = createSettingsPanel(state,{idPrefix:''}); native.append(original.element); native.showModal();
    let release!:(value:boolean)=>void;
    const dialog = createSDKDialog({mutate:()=>new Promise<boolean>(resolve=>{release = resolve;}),error:()=> 'Old provider rejected'});
    const pending = dialog.act('/api/oauth/start',{provider:'example'},native);
    original.destroy(); const replacement = createSettingsPanel(state,{idPrefix:''}); native.replaceChildren(replacement.element);
    release(false); const saved = await pending;
    const result = {saved,settings:replacement.element.querySelector('[data-dialog-error]')!.textContent,appearance:replacement.element.querySelector('[id$=appearance-error]')!.textContent};
    dialog.destroy(); replacement.destroy(); native.remove(); elements.destroy(); return result;
  });
  expect(result).toEqual({saved:false,settings:'',appearance:''});
});
