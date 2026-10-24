import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

for (const appearance of ['light', 'dark'] as const) {
  test(`the ${appearance} application keeps the four-tile brand as a source-controlled mark`, async ({page}) => {
    await page.addInitScript(installFixture);
    await page.addInitScript(value => {
      const scope = window as unknown as {reviewState: {settings: {appearance: string}}};
      scope.reviewState.settings.appearance = value;
    }, appearance);
    await page.goto('/');
    await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
    const brand = page.locator('[data-brand]');
    const mark = brand.locator('[data-brand-mark]');
    await expect(brand).toBeVisible();
    await expect(mark).toBeVisible();
    await expect(mark.locator('i')).toHaveCount(4);
    await expect(brand.locator('img')).toHaveCount(0);
    await expect(brand).toContainText('Pith');
    await expect(brand).toContainText('Desk');
    const markStyle = await mark.evaluate(element => ({display: getComputedStyle(element).display, transform: getComputedStyle(element).transform, color: getComputedStyle(element).color}));
    expect(markStyle.display).toBe('grid');
    expect(markStyle.transform).not.toBe('none');
    expect(markStyle.color).not.toBe('');
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(appearance === 'dark');
  });
}
