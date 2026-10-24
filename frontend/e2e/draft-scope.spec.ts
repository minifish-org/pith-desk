import {expect} from '@playwright/test';
import {test} from './host-fixture.mjs';

for (const hostMode of ['desktop', 'server']) test.describe(`${hostMode} workspace draft`, () => {
  test.use({hostMode});

  test('the displayed workspace retains its draft without an active conversation', async ({page, host}) => {
    await page.goto(host.url);
    const composer = page.getByRole('textbox', {name: 'Message Pith', exact: true});
    await expect(composer).toBeEditable();
    await page.getByRole('button', {name: 'Actions for Workspace A conversation', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Delete…', exact: true}).click();
    await page.getByRole('button', {name: 'Delete conversation', exact: true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(composer).toBeEditable();
    await expect(page.locator('[data-breadcrumb-workspace]')).toHaveText('Workspace A');
    await composer.fill('Keep this workspace draft 中文');
    await page.evaluate(() => new Promise(resolve => window.dispatchEvent(new CustomEvent('pith:flush-drafts', {cancelable: true, detail: resolve}))));
    await page.reload();
    await expect(composer).toHaveValue('Keep this workspace draft 中文');
  });
});
