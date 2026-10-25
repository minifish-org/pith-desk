import {expect} from '@playwright/test';
import {test} from './host-fixture.mjs';

/** Pasting a screenshot attaches it like the picker and drag paths do. */
for (const mode of ['desktop', 'server']) test.describe(`${mode} composer paste`, () => {
  test.use({hostMode: mode});
  test('a pasted image becomes a draft attachment and keeps typed text', async ({page, host}) => {
    await page.goto(host.url);
    const composer = page.getByRole('textbox', {name: 'Message Pith', exact: true});
    await expect(composer).toBeEditable();
    await composer.fill('Before paste');
    const pasted = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
      const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([png], 'pasted.png', {type: 'image/png'}));
      const target = document.querySelector('textarea[aria-label="Message Pith"]')!;
      return target.dispatchEvent(new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}));
    });
    expect(pasted).toBe(false);
    await expect(page.locator('[data-draft-image]')).toHaveCount(1);
    await expect(composer).toHaveValue('Before paste');
  });
});
