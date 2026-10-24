import {test, expect, type Page} from '@playwright/test';
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

async function installCostLedger(page: Page, holdFirst = false) {
  await page.evaluate(({holdFirst}) => {
    const fixture = window as any;
    const original = window.fetch.bind(window);
    fixture.costReads = [];
    fixture.failCostRead = false;
    window.fetch = async (input, options) => {
      const url = new URL(String(input), location.href);
      if (url.pathname !== '/api/costs') return original(input, options);
      const id = url.searchParams.get('id');
      const revision = fixture.reviewState.runtime.cost.requestCount;
      fixture.costReads.push({id, revision});
      // Deliberately ignore cancellation: a retired response must still be harmless.
      if (holdFirst && fixture.costReads.length === 1) await new Promise<void>(resolve => {fixture.releaseCostRead = resolve;});
      if (fixture.failCostRead) return Response.json({error: 'Ledger unavailable'}, {status: 503});
      return Response.json({
        total: 0, runTotal: 0, requestCount: revision, unknownRequests: 0, runRequests: revision, runUnknownRequests: 0,
        currency: 'USD', estimated: true,
        requests: [{id: `${id}-${revision}`, purpose: 'task', model: `ledger-${id}-${revision}`, status: 'complete', known: true, usage: {input: 1, output: 2}}],
      });
    };
  }, {holdFirst});
  await page.locator('[data-runtime-summary]').click();
  await page.getByRole('button', {name: 'Request breakdown', exact: true}).click();
}

test('an open cost ledger refreshes when the request count or conversation changes', async ({page}) => {
  await installCostLedger(page);
  await expect(page.getByRole('cell', {name: 'ledger-a-1', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.reviewState.runtime.cost.requestCount = 2;
    fixture.emitReview();
  });
  await expect(page.getByRole('cell', {name: 'ledger-a-2', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.reviewState.activeId = 'b';
    fixture.emitReview();
  });
  await expect(page.getByRole('cell', {name: 'ledger-b-2', exact: true})).toBeVisible();
  await expect(page.getByRole('cell', {name: 'ledger-a-2', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Request breakdown', exact: true}).click();
  await page.getByRole('button', {name: 'Request breakdown', exact: true}).click();
  await expect(page.getByRole('cell', {name: 'ledger-b-2', exact: true})).toBeVisible();
  expect(await page.evaluate(() => (window as any).costReads.length)).toBe(3);
});

test('a retired cost response cannot replace the newly selected conversation ledger', async ({page}) => {
  await installCostLedger(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).costReads.length)).toBe(1);
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.reviewState.activeId = 'b';
    fixture.emitReview();
  });
  await expect(page.getByRole('cell', {name: 'ledger-b-1', exact: true})).toBeVisible();
  await page.evaluate(async () => {
    (window as any).releaseCostRead();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByRole('cell', {name: 'ledger-b-1', exact: true})).toBeVisible();
  await expect(page.getByRole('cell', {name: 'ledger-a-1', exact: true})).toHaveCount(0);
});

test('reopening a failed cost ledger clears the error and retries', async ({page}) => {
  await installCostLedger(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).costReads.length)).toBe(1);
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.failCostRead = true;
    fixture.releaseCostRead();
  });
  await expect(page.getByText('Request breakdown could not be loaded. Reopen this section to retry.')).toBeVisible();
  await page.getByRole('button', {name: 'Request breakdown', exact: true}).click();
  await page.evaluate(() => {(window as any).failCostRead = false;});
  await page.getByRole('button', {name: 'Request breakdown', exact: true}).click();
  await expect(page.getByRole('cell', {name: 'ledger-a-1', exact: true})).toBeVisible();
  await expect(page.getByText('Request breakdown could not be loaded. Reopen this section to retry.')).toHaveCount(0);
});

test('closing a pending ledger retires its error before the same section is reopened', async ({page}) => {
  await installCostLedger(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).costReads.length)).toBe(1);
  const disclosure = page.getByRole('button', {name: 'Request breakdown', exact: true});
  await disclosure.click();
  await disclosure.click();
  await expect(page.getByRole('cell', {name: 'ledger-a-1', exact: true})).toBeVisible();
  expect(await page.evaluate(() => (window as any).costReads.length)).toBe(2);
  await page.evaluate(async () => {
    const fixture = window as any;
    fixture.failCostRead = true;
    fixture.releaseCostRead();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByRole('cell', {name: 'ledger-a-1', exact: true})).toBeVisible();
  await expect(page.getByText('Request breakdown could not be loaded. Reopen this section to retry.')).toHaveCount(0);
});
