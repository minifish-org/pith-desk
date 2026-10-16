import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test('task recovery targets the selected workspace and stays disabled while that workspace runs', async ({page}) => {
  await page.addInitScript(installFixture); await page.goto('/');
  await page.waitForFunction(() => (window as unknown as {reviewSocket?: {onmessage?: unknown}}).reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('[id$=composer-input]')!.readOnly);
  await page.evaluate(() => {
    const fixture = window as unknown as {reviewState: {failure: {message: string; advice: string; canContinue: boolean}}; emitReview(): void};
    fixture.reviewState.failure = {message: 'Task interrupted', advice: 'Review and continue.', canContinue: true}; fixture.emitReview();
  });
  const recover = page.locator('[id$=task-failure] [data-action="continue"]');
  await expect(recover).toHaveAttribute('data-idle-workspace', 'w'); await expect(recover).toBeEnabled();
  await page.evaluate(() => {
    const fixture = window as unknown as {reviewState: {runs: unknown[]}; emitReview(): void};
    fixture.reviewState.runs = [{conversationId: 'b', workspaceId: 'w', phase: 'working', needsApproval: false}]; fixture.emitReview();
  });
  await expect(recover).toBeDisabled();
  await page.evaluate(() => {const fixture = window as unknown as {reviewState: {runs: unknown[]}; emitReview(): void}; fixture.reviewState.runs = []; fixture.emitReview();});
  await expect(recover).toBeEnabled();
});
