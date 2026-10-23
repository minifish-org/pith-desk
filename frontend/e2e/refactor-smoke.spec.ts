import {expect, test} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test.beforeEach(async ({page}) => {
  await page.addInitScript(installFixture);
});

test('the React shell renders the conversation, composer and navigation', async ({page}) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', {name: 'Message Pith'});
  await expect(composer).toBeEditable();
  await expect(page.getByRole('button', {name: 'Review workspace', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Conversation a', exact: true})).toBeVisible();
  await expect(page.getByText('Stable historical text to select')).toBeVisible();
  await expect(page.getByText('A streaming answer')).toBeVisible();
  await composer.fill('Hello from the new shell');
  await expect(page.getByRole('button', {name: 'Send message'})).toBeEnabled();
  await page.getByRole('button', {name: 'Send message'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).review.requests.find((request: any) => request.path === '/api/send')?.body))
    .toEqual({id: 'a', text: 'Hello from the new shell', images: []});
});

test('workspace tools open with the file browser and settings lists providers', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
  const tools = page.getByRole('complementary', {name: 'Workspace tools'});
  await expect(tools.getByRole('tab', {name: 'Files', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Close tools', exact: true}).click();
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings'});
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('combobox', {name: 'Provider'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
});
