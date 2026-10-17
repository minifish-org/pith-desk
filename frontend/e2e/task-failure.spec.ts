import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test('task recovery targets the selected workspace and stays disabled while that workspace runs', async ({page}) => {
  await page.addInitScript(installFixture); await page.goto('/');
  await page.waitForFunction(() => (window as unknown as {reviewSocket?: {onmessage?: unknown}}).reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('.pui-composer textarea[aria-label="Message Pith"]')!.readOnly);
  await page.evaluate(() => {
    const fixture = window as unknown as {reviewState: {failure: {message: string; advice: string; canContinue: boolean}}; emitReview(): void};
    fixture.reviewState.failure = {message: 'Task interrupted', advice: 'Review and continue.', canContinue: true}; fixture.emitReview();
  });
  const recover = page.getByRole('button', {name: 'Review and continue', exact: true});
  await expect(recover).toBeEnabled();
  // Observe workspace scope through availability, rather than removed DOM metadata.
  await page.evaluate(() => {
    const fixture = window as unknown as {reviewState: {runs: unknown[]}; emitReview(): void};
    fixture.reviewState.runs = [{conversationId: 'remote', workspaceId: 'other', phase: 'working', needsApproval: false}]; fixture.emitReview();
  });
  await expect(recover).toBeEnabled();
  await page.evaluate(() => {
    const fixture = window as unknown as {reviewState: {runs: unknown[]}; emitReview(): void};
    fixture.reviewState.runs = [{conversationId: 'b', workspaceId: 'w', phase: 'working', needsApproval: false}]; fixture.emitReview();
  });
  await expect(recover).toBeDisabled();
  await page.evaluate(() => {const fixture = window as unknown as {reviewState: {runs: unknown[]}; emitReview(): void}; fixture.reviewState.runs = []; fixture.emitReview();});
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect.poll(() => page.evaluate(() => (window as any).review.requests.filter((request: any) => request.path === '/api/continue').map((request: any) => request.body))).toEqual([{id: 'a'}]);
});
