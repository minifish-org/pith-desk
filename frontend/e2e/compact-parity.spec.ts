import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

for (const scenario of ['empty', 'running', 'no active conversation'] as const) {
  test(`Compact remains unavailable with ${scenario}`, async ({page}) => {
    await page.addInitScript(installFixture);
    await page.goto('/');
    const compact = page.getByRole('button', {name: 'Compress context', exact: true});
    await expect(page.locator('[id$=composer-input]')).toBeEditable();
    await expect(compact).toBeEnabled();
    await page.evaluate(value => {
      const scope = window as unknown as {
        reviewState: {messages: unknown[]; activeId: string | null; running: boolean};
        emitReview(): void;
      };
      if (value === 'empty') scope.reviewState.messages = [];
      else if (value === 'running') scope.reviewState.running = true;
      else scope.reviewState.activeId = null;
      scope.emitReview();
    }, scenario);
    await expect(compact).toBeDisabled();
    await expect(page.locator('[id$=inline-error]')).not.toContainText('This action is no longer available.');
  });
}
