import {expect, test} from './test.ts';
import type {Application} from '../src/ui-types';

interface CustomFixture {ui: Application; custom(id?: string): Promise<void>; reads: string[]; destroy(): void;}

test.beforeEach(async ({page}) => {
  await page.route('**/custom-defaults.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body><div id="app"></div></body></html>'}));
  await page.goto('/custom-defaults.html');
  await page.evaluate(async () => {
    const library = '/src/ui-mount.ts', styles = '/node_modules/pith-ui/dist/styles.css', controller = '/src/custom-connections.ts';
    const [{mountApplication:createApplication}, {createCustomUI}] = await Promise.all([import(library), import(controller), import(styles)]);
    const ui: Application = createApplication(), reads: string[] = [];
    const custom = createCustomUI({ui, settings() {}, error: () => '', mutate: async () => true,
      request: async (_path: string, {query}: {query: {id: string}}) => {
        reads.push(query.id);
        return {name: 'Saved connection', baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [
          {id: 'unknown-limits'},
          {id: 'saved-model', name: 'Saved 中文', contextWindow: 256000, maxTokens: 16384, reasoning: true, input: ['text', 'image']},
        ]};
      },
    });
    const fixture: CustomFixture = {ui, reads, custom: custom.custom, destroy() {custom.destroy(); ui.destroy();}};
    (window as unknown as {customFixture: CustomFixture}).customFixture = fixture;
  });
});

test('a new connection and added models share defaults without copying the edited first row', async ({page}) => {
  await page.evaluate(() => (window as unknown as {customFixture: CustomFixture}).customFixture.custom());
  const rows = page.locator('ui=[id$="custom-models"] fieldset');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('128000');
  await expect(rows.first().getByLabel(/^Max output tokens(?:\s*\*)?$/)).toHaveValue('8192');
  await rows.first().getByLabel(/^Model ID(?:\s*\*)?$/).fill('unsaved-model');
  await rows.first().getByLabel(/^Context tokens(?:\s*\*)?$/).fill('64000');
  await page.getByRole('button', {name: 'Add model', exact: true}).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.last().getByLabel(/^Model ID(?:\s*\*)?$/)).toHaveValue('');
  await expect(rows.last().getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('128000');
  await expect(rows.last().getByLabel(/^Max output tokens(?:\s*\*)?$/)).toHaveValue('8192');
  await expect(rows.first().getByLabel(/^Model ID(?:\s*\*)?$/)).toHaveValue('unsaved-model');
  await expect(rows.first().getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('64000');
  expect(await page.evaluate(() => (window as unknown as {customFixture: CustomFixture}).customFixture.reads)).toEqual([]);
  await page.evaluate(() => (window as unknown as {customFixture: CustomFixture}).customFixture.destroy());
});

test('editing keeps absent and saved limits while Add model uses fresh starting values', async ({page}) => {
  await page.evaluate(() => (window as unknown as {customFixture: CustomFixture}).customFixture.custom('saved'));
  const rows = page.locator('ui=[id$="custom-models"] fieldset');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByLabel(/^Model ID(?:\s*\*)?$/)).toHaveValue('unknown-limits');
  await expect(rows.first().getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('');
  await expect(rows.first().getByLabel(/^Max output tokens(?:\s*\*)?$/)).toHaveValue('');
  await expect(rows.nth(1).getByLabel('Display name', {exact: true})).toHaveValue('Saved 中文');
  await expect(rows.nth(1).getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('256000');
  await expect(rows.nth(1).getByLabel(/^Max output tokens(?:\s*\*)?$/)).toHaveValue('16384');
  await expect(rows.nth(1).getByLabel('Thinking effort', {exact: true})).toBeChecked();
  await expect(rows.nth(1).getByLabel('Images', {exact: true})).toBeChecked();
  await page.getByRole('button', {name: 'Add model', exact: true}).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.last().getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('128000');
  await expect(rows.last().getByLabel(/^Max output tokens(?:\s*\*)?$/)).toHaveValue('8192');
  await expect(rows.first().getByLabel(/^Context tokens(?:\s*\*)?$/)).toHaveValue('');
  expect(await page.evaluate(() => (window as unknown as {customFixture: CustomFixture}).customFixture.reads)).toEqual(['saved']);
  await page.evaluate(() => (window as unknown as {customFixture: CustomFixture}).customFixture.destroy());
});
