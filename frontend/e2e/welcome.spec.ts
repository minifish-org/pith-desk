import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test('the welcome suggestion chips seed the composer', async ({page}) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!.readOnly);
  await page.evaluate(() => {
    const scope = window as unknown as {reviewState: {messages: unknown[]}; emitReview(): void};
    scope.reviewState.messages = [];
    scope.emitReview();
  });
  await expect(page.getByRole('heading', {name: 'What are we working on?', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Explore my workspace', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toHaveValue('Explore this workspace and give me a concise overview of its files.');
});
