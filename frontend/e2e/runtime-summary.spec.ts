import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test.beforeEach(async ({page}) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.evaluate(() => {
    const fixture = window as any;
    Object.assign(fixture.reviewState.runtime, {
      phase: 'complete', model: 'deepseek-flash',
      usage: {input: 73990452, output: 4038, cacheRead: 0, cacheWrite: 0, total: 73994490},
      cost: {total: 1.068332, runTotal: 0.007004, requestCount: 1, unknownRequests: 0, runRequests: 1, runUnknownRequests: 0},
      timing: {startedAt: '2026-10-18T00:00:00Z', elapsedMs: 25000, outputTokens: 4038},
    });
    fixture.emitReview();
  });
});

test('collapsed runtime keeps speed directly visible with compact totals and expanded model details', async ({page}) => {
  const summary = page.locator('[data-runtime-summary]');
  await expect(summary).toHaveText('Finished · 25s · 162 tok/s · 74M tok · ~$1.07');
  await summary.click();
  const details = page.locator('[data-runtime-details]');
  await expect(details.locator('dt').filter({hasText: /^Model$/}).locator('+ dd')).toHaveText('deepseek-flash');
  await expect(details.locator('dt').filter({hasText: /^Input tokens$/}).locator('+ dd')).toHaveText('74M');
  await expect(details.locator('dt').filter({hasText: /^Output tokens$/}).locator('+ dd')).toHaveText('4.04k');
  await expect(details.locator('dt').filter({hasText: /^Latest task$/}).locator('+ dd')).toHaveText('~$0.007');
});

test('interrupted and unrecorded timing never invent a speed or duration', async ({page}) => {
  const summary = page.locator('[data-runtime-summary]');
  await page.evaluate(() => {
    const fixture = window as any, status = fixture.reviewState.runtime;
    status.phase = 'interrupted'; status.timing.partial = true;
    status.cost.unknownRequests = 1; fixture.emitReview();
  });
  await expect(summary).toHaveText('Interrupted · ≥25s · — tok/s · 74M tok · Unknown');
  await page.evaluate(() => {
    const fixture = window as any, status = fixture.reviewState.runtime;
    status.phase = ''; status.timing = {elapsedMs: 0, outputTokens: 0};
    status.cost.requestCount = 0; fixture.emitReview();
  });
  await expect(summary).toHaveText('Ready · 74M tok · Not recorded');
});

test('expanded runtime details share the composer column when the panel scrolls', async ({page}) => {
  await page.setViewportSize({width: 900, height: 500});
  await page.locator('[data-runtime-summary]').click();
  const boxes = await page.evaluate(() => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return {x: Math.round(rect.x), width: Math.round(rect.width)};
    };
    return {
      details: box(document.querySelector('[data-runtime-details]')!),
      composer: box(document.querySelector('[data-composer]')!),
    };
  });
  expect(boxes.details).toEqual(boxes.composer);
});
