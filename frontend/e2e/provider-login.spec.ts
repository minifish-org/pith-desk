import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {LoginStatus} from '../src/contract.generated.ts';

const fixed = JSON.parse(readFileSync(new URL('../../internal/desk/testdata/state.active.json', import.meta.url), 'utf8'));
declare global {
  interface Window {
    providerLoginTest: {
      model: {login: LoginStatus};
      controller: {render(): void; resetDismissed(): void};
      answers: Array<{id: string; answer: string}>;
      responses: Array<(ok: boolean) => void>;
    };
  }
}

test.beforeEach(async ({page}) => {
  await page.route('**/provider-login-test.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head><title>Provider login adapter regression</title></head><body></body></html>'}));
  await page.goto('/provider-login-test.html');
  await page.evaluate(async fixed => {
    const source = '/src/provider-login.ts';
    const {createProviderLoginUI} = await import(source);
    const library = '/src/ui-application.ts';
    const {mountDesk} = await import(library);
    const mount = document.createElement('main'); document.body.append(mount);
    const ui = mountDesk(mount);
    const model = {login: {id: 'login-one', provider: 'fixture', phase: 'prompt', message: 'Enter your verification code.', prompt: 'Verification code', promptType: 'text'} as LoginStatus};
    const answers: Array<{id: string; answer: string}> = [], responses: Array<(ok: boolean) => void> = [];
    const controller = createProviderLoginUI({ui,
      state: () => ({...fixed, login: model.login}), error: () => 'The answer was rejected.', refreshProviderAuth() {},
      mutate: (path: string, input: {id: string; answer: string}) => {
        if (path !== '/api/oauth/answer') return Promise.resolve(true);
        answers.push(input); return new Promise<boolean>(resolve => responses.push(resolve));
      },
    });
    window.providerLoginTest = {model, controller, answers, responses}; controller.render();
  }, fixed);
});

test('login metadata updates preserve the answer, input node, focus and selection', async ({page}) => {
  await page.locator('.pui-answer-form :is(input,select)').fill('123456 中文');
  const result = await page.evaluate(() => {
    const fixture = window.providerLoginTest;
    const input = document.querySelector<HTMLInputElement>('.pui-answer-form :is(input,select)')!;
    input.focus(); input.setSelectionRange(2, 6);
    fixture.model.login = {...fixture.model.login, message: 'Still waiting for your code.', code: 'fixture-code', url: 'https://example.com/login'};
    fixture.controller.render();
    const current = document.querySelector<HTMLInputElement>('.pui-answer-form :is(input,select)')!;
    return {same: input === current, value: current.value, start: current.selectionStart, end: current.selectionEnd, focused: document.activeElement === current, message: document.querySelector('.pui-provider-login-status')!.textContent};
  });
  expect(result).toEqual({same: true, value: '123456 中文', start: 2, end: 6, focused: true, message: 'Still waiting for your code.'});
});

test('login metadata updates retain the pending guard and report failure on the same question', async ({page}) => {
  await page.locator('.pui-answer-form :is(input,select)').fill('pending answer');
  await page.locator('.pui-answer-form button').click();
  const result = await page.evaluate(() => {
    const fixture = window.providerLoginTest;
    fixture.model.login = {...fixture.model.login, message: 'Checking your answer…'}; fixture.controller.render();
    document.querySelector<HTMLInputElement>('.pui-answer-form :is(input,select)')!.value = 'pending answer';
    document.querySelector<HTMLFormElement>('.pui-answer-form')!.requestSubmit();
    return {answers: fixture.answers, disabled: document.querySelector<HTMLButtonElement>('.pui-answer-form button')!.disabled};
  });
  expect(result).toEqual({answers: [{id: 'login-one', answer: 'pending answer'}], disabled: true});
  await page.evaluate(async () => {window.providerLoginTest.responses[0](false); await new Promise(resolve => setTimeout(resolve, 0));});
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('pending answer');
  await expect(page.locator('.pui-answer-form button')).toBeEnabled();
  await expect(page.locator('.pui-answer-form + .pui-form-error')).toHaveText('The answer was rejected.');
  await expect(page.locator('.pui-provider-login-status')).toHaveText('Checking your answer…');
});

test('new login identities, questions and close/reopen discard old answers and late failures', async ({page}) => {
  await page.locator('.pui-answer-form :is(input,select)').fill('old identity answer');
  await page.locator('.pui-answer-form button').click();
  await page.evaluate(() => {
    const fixture = window.providerLoginTest;
    fixture.model.login = {...fixture.model.login, id: 'login-two'}; fixture.controller.render();
  });
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('');
  await page.locator('.pui-answer-form :is(input,select)').fill('new identity answer');
  await page.evaluate(async () => {window.providerLoginTest.responses[0](false); await new Promise(resolve => setTimeout(resolve, 0));});
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('new identity answer');
  await expect(page.locator('.pui-answer-form + .pui-form-error')).toHaveText('');
  await page.locator('.pui-answer-form button').click();
  await page.evaluate(() => {
    const fixture = window.providerLoginTest;
    fixture.model.login = {...fixture.model.login, prompt: 'Additional verification'}; fixture.controller.render();
  });
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('');
  await page.locator('.pui-answer-form :is(input,select)').fill('new question answer');
  await page.evaluate(async () => {window.providerLoginTest.responses[1](false); await new Promise(resolve => setTimeout(resolve, 0));});
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('new question answer');
  await expect(page.locator('.pui-answer-form + .pui-form-error')).toHaveText('');
  await page.locator('.pui-answer-form button').click();
  await page.evaluate(async () => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog:has(.pui-provider-login-status)')!;
    const closed = new Promise<void>(resolve => dialog.addEventListener('close', () => resolve(), {once: true}));
    dialog.close(); await closed;
    window.providerLoginTest.controller.resetDismissed(); window.providerLoginTest.controller.render();
  });
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('');
  await page.locator('.pui-answer-form :is(input,select)').fill('reopened answer');
  await page.evaluate(async () => {window.providerLoginTest.responses[2](false); await new Promise(resolve => setTimeout(resolve, 0));});
  await expect(page.locator('.pui-answer-form :is(input,select)')).toHaveValue('reopened answer');
  await expect(page.locator('.pui-answer-form + .pui-form-error')).toHaveText('');
  await expect(page.locator('.pui-answer-form button')).toBeEnabled();
});
