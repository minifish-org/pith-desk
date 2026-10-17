import {test, expect} from './test.ts';
import {installFixture} from './fixture.mjs';

test('streaming and draft input leave unchanged historical message content untouched', async ({page}) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(() => {window.reviewState.messages[0].timestamp = 1791899580000;});
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !window.uiQuery<HTMLTextAreaElement>('[id$=composer-input]')!.readOnly);
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
