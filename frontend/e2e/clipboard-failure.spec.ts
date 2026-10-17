import {test, expect} from './test.ts';
import {installFixture} from './fixture.mjs';

for (const kind of ['message', 'code'] as const) test(`a rejected ${kind} copy reports its error and remains retryable`, async ({page}) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(() => {
    const fixture = window as any;
    fixture.copyAttempts = 0;
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {async writeText() {fixture.copyAttempts++; throw new Error('Clipboard denied');}}});
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  const button = kind === 'message'
    ? page.getByRole('button', {name: 'Copy message', exact: true})
    : page.locator('ui=[data-copy-code]').first();
  await button.click();
  await expect(page.locator('ui=[id$=inline-error]')).toContainText('Clipboard denied');
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => (window as any).copyAttempts)).toBe(1);
  await button.click();
  await expect.poll(() => page.evaluate(() => (window as any).copyAttempts)).toBe(2);
  await expect(button).toBeEnabled();
});
