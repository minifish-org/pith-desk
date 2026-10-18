import {test,expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test.beforeEach(async ({page}) => {
  await page.addInitScript(installFixture);await page.goto('/');
  await page.evaluate(() => {
    const fixture = window as any;
    Object.assign(fixture.reviewState.runtime,{
      phase: 'complete',model: 'deepseek-flash',
      usage: {input: 73990452,output: 4038,cacheRead: 0,cacheWrite: 0,total: 73994490},
      cost: {total: 1.068332,runTotal: 0.007004,requestCount: 1,unknownRequests: 0,runRequests: 1,runUnknownRequests: 0},
      timing: {startedAt: '2026-10-18T00:00:00Z',elapsedMs: 25000,outputTokens: 4038},
    });
    fixture.emitReview();
  });
});

test('collapsed runtime keeps speed directly visible with compact totals and expanded model details',async ({page}) => {
  const summary = page.locator('.pui-run-status > summary');
  await expect(summary).toHaveText('Finished · 25s · 162 tok/s · 74M tok · ~$1.07');
  await summary.click();
  await expect(page.locator('.pui-run-status dt').filter({hasText: /^Model$/}).locator('+ dd')).toHaveText('deepseek-flash');
  await expect(page.locator('.pui-run-status dt').filter({hasText: /^Session input \/ output$/}).locator('+ dd')).toHaveText('74M / 4.04k');
  await expect(page.locator('.pui-run-status dt').filter({hasText: /^Latest task \(USD\)$/}).locator('+ dd')).toHaveText('~$0.007');
});

test('interrupted and unrecorded timing never invent a speed or duration',async ({page}) => {
  const summary = page.locator('.pui-run-status > summary');
  await page.evaluate(() => {
    const fixture = window as any,status = fixture.reviewState.runtime;
    status.phase = 'interrupted';status.timing.partial = true;
    status.cost.unknownRequests = 1;fixture.emitReview();
  });
  await expect(summary).toHaveText('Interrupted · ≥25s · — tok/s · 74M tok · Unknown');
  await page.evaluate(() => {
    const fixture = window as any,status = fixture.reviewState.runtime;
    status.phase = '';status.timing = {elapsedMs: 0,outputTokens: 0};
    status.cost.requestCount = 0;fixture.emitReview();
  });
  await expect(summary).toHaveText('Ready · 74M tok · Not recorded');
});
