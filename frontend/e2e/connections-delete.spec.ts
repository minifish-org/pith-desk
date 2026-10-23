import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test('deleting a connection refreshes the list and closes the confirmation', async ({page}) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.getByRole('button', {name: 'Connections', exact: true}).click();
  const connections = page.getByRole('dialog', {name: 'Connections', exact: true});
  await expect(connections.getByText('fixture-tools', {exact: true})).toBeVisible();
  await connections.getByRole('button', {name: 'fixture-tools options', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Delete…', exact: true}).click();
  const confirm = page.getByRole('dialog', {name: 'Delete connection?', exact: true});
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', {name: 'Delete connection', exact: true}).click();
  await expect(confirm).toHaveCount(0);
  await expect(connections.getByText('No connections yet', {exact: true})).toBeVisible();
});
