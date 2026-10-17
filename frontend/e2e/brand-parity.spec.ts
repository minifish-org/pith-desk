import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

for (const appearance of ['light', 'dark'] as const) {
  test(`the ${appearance} application keeps the original four-tile brand without an external image`, async ({page}) => {
    await page.addInitScript(installFixture);
    await page.addInitScript(value => {
      const scope = window as unknown as {reviewState: {settings: {appearance: string}}};
      scope.reviewState.settings.appearance = value;
    }, appearance);
    await page.goto('/');
    await expect(page.locator('.pui-composer textarea[aria-label="Message Pith"]')).toBeEditable();
    const brand = page.locator('.pui-brand');
    const mark = brand.locator('.pui-logo-mark');
    await expect(mark).toBeVisible();
    await expect(mark.locator('i')).toHaveCount(4);
    await expect(brand.locator('img')).toHaveCount(0);
    await expect(brand).toHaveText('Pith Desk');
    expect(await mark.evaluate(element => {
      const style = getComputedStyle(element);
      return {width: style.width, height: style.height, gap: style.gap, overflow: style.overflow};
    })).toEqual({width: '24px', height: '24px', gap: '3px', overflow: 'visible'});
    await expect(mark.locator('i').first()).toHaveCSS('background-color', appearance === 'light' ? 'rgb(74, 98, 200)' : 'rgb(134, 182, 242)');
    expect(await brand.evaluate(element => element.tabIndex)).toBe(-1);
  });
}
