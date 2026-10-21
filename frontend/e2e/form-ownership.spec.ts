import {test,expect} from '@playwright/test';
import type {ActionResult, Application, SettingsSession} from '../src/ui-contract.ts';

type FormFixture = {ui: Application; panel: SettingsSession; calls: unknown[]; result?: ActionResult; release?: (value: boolean) => void; destroy(): void};

test.beforeEach(async ({page}) => {
  await page.route('**/form-ownership.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="app"></div></body></html>'}));
  await page.goto('/form-ownership.html');
});

test('provider actions report to their own form while the SDK dialog is closed',async ({page}) => {
  await page.evaluate(async () => {
    const library = '/src/ui-application.ts', adapter = '/src/sdk-features.ts', styles = '/src/style.css';
    const [{mountDesk}, {createSDKUI}] = await Promise.all([import(library), import(adapter), import(styles)]);
    const ui = mountDesk(document.getElementById('app')!), calls: unknown[] = [];
    const sdk = createSDKUI({ui, state: () => ({runs: []}), busy: () => false, mutate: async (path: string, payload: unknown) => {calls.push({path, payload}); return false;}, error: () => 'Provider rejected'});
    const fixture: FormFixture = {ui, calls, panel: undefined!, destroy() {sdk.destroy(); ui.destroy();}};
    fixture.panel = ui.settings.openSettings({baseUrl: 'https://example.com', hasApiKey: true, ready: true}, {
      onProviderAction: async (action: string, target: {id: string}) => {const result = await sdk.providerAction(action, target); fixture.result = result; return result;},
    });
    fixture.panel.setCredential({status: 'Configured', hidden: true, required: false, placeholder: '', removeVisible: false,
      providerActions: {id: 'example', oauth: true, signedIn: false, custom: false}});
    (window as unknown as {formFixture: FormFixture}).formFixture = fixture;
  });
  await page.getByRole('button', {name: 'Sign in with provider', exact: true}).click();
  await expect(page.locator('.pui-settings-panel > form > .pui-form-error')).toHaveText('Provider rejected');
  const result = await page.evaluate(() => {
    const fixture = (window as unknown as {formFixture: FormFixture}).formFixture;
    const result = {saved: fixture.result?.ok, settings: document.querySelector('.pui-settings-panel > form > .pui-form-error')!.textContent,
      appearance: document.querySelector('.pui-settings-section:has(select[aria-label="Appearance"]) > .pui-form-error')!.textContent,
      sdkOpen: document.querySelector<HTMLDialogElement>('dialog.pui-feature-modal')?.open ?? false, calls: fixture.calls};
    fixture.destroy(); return result;
  });
  expect(result).toEqual({saved: false, settings: 'Provider rejected', appearance: '', sdkOpen: false, calls: [{path: '/api/oauth/start', payload: {provider: 'example'}}]});
});

test('a replaced provider form cannot receive an older action failure',async ({page}) => {
  await page.evaluate(async () => {
    const library = '/src/ui-application.ts', adapter = '/src/sdk-features.ts', styles = '/src/style.css';
    const [{mountDesk}, {createSDKUI}] = await Promise.all([import(library), import(adapter), import(styles)]);
    const ui = mountDesk(document.getElementById('app')!), calls: unknown[] = [];
    const fixture: FormFixture = {ui, calls, panel: undefined!, destroy() {sdk.destroy(); ui.destroy();}};
    const sdk = createSDKUI({ui, state: () => ({runs: []}), busy: () => false,
      mutate: (path: string, payload: unknown) => {calls.push({path, payload}); return new Promise<boolean>(resolve => {fixture.release = resolve;});}, error: () => 'Old provider rejected'});
    fixture.panel = ui.settings.openSettings({baseUrl: 'https://example.com', hasApiKey: true, ready: true}, {
      onProviderAction: async (action: string, target: {id: string}) => {const result = await sdk.providerAction(action, target); fixture.result = result; return result;},
    });
    fixture.panel.setCredential({status: 'Configured', hidden: true, required: false, placeholder: '', removeVisible: false,
      providerActions: {id: 'example', oauth: true, signedIn: false, custom: false}});
    (window as unknown as {formFixture: FormFixture}).formFixture = fixture;
  });
  await page.getByRole('button', {name: 'Sign in with provider', exact: true}).click();
  await page.evaluate(() => {
    const fixture = (window as unknown as {formFixture: FormFixture}).formFixture;
    fixture.panel = fixture.ui.settings.openSettings({baseUrl: 'https://replacement.example.com', hasApiKey: true, ready: true});
    fixture.release!(false);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as {formFixture: FormFixture}).formFixture.result?.ok)).toBe(false);
  const result = await page.evaluate(() => {
    const fixture = (window as unknown as {formFixture: FormFixture}).formFixture;
    const result = {saved: fixture.result?.ok, settings: document.querySelector('.pui-settings-panel > form > .pui-form-error')!.textContent,
      appearance: document.querySelector('.pui-settings-section:has(select[aria-label="Appearance"]) > .pui-form-error')!.textContent, calls: fixture.calls};
    fixture.destroy(); return result;
  });
  expect(result).toEqual({saved: false, settings: '', appearance: '', calls: [{path: '/api/oauth/start', payload: {provider: 'example'}}]});
});
