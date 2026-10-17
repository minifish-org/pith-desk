import {test,expect} from '@playwright/test';

// These native-control checks retain the disabled/pending/copy-pending merge
// previously covered with a fake DOM object in frontend/tests/controls.test.mjs.
test.beforeEach(async ({page}) => {
  await page.goto('/e2e/fixtures/controls-parts.html');
  await page.waitForFunction(() => !!window.controlsRegression);
});

test('authoritative availability and explicit pending combine without losing either state',async ({page}) => {
  const button = page.getByRole('button',{name: 'Run action',exact: true});
  await expect(button).toBeEnabled();
  for (const state of [
    {disabled: false,pending: true},
    {disabled: true,pending: false},
    {disabled: true,pending: true},
  ]) {
    await page.evaluate(state => window.controlsRegression.actionSnapshot(state),state);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy',String(state.pending));
  }
  await page.evaluate(() => window.controlsRegression.actionSnapshot({disabled: false,pending: false}));
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('aria-busy','false');
});

test('an asynchronous action stays pending across snapshots and restores current authoritative availability',async ({page}) => {
  const button = page.getByRole('button',{name: 'Run action',exact: true});
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy','true');
  await page.evaluate(() => window.controlsRegression.actionSnapshot({disabled: false,pending: false}));
  await expect(button).toBeDisabled();
  await button.dispatchEvent('click');
  expect(await page.evaluate(() => window.controlsRegression.counts().actions)).toBe(1);
  await page.evaluate(() => {window.controlsRegression.actionSnapshot({disabled: true,pending: false});window.controlsRegression.resolveAction();});
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy','false');
  await page.evaluate(() => window.controlsRegression.actionSnapshot({disabled: false,pending: false}));
  await expect(button).toBeEnabled();
  await button.click();
  await page.evaluate(() => {window.controlsRegression.actionSnapshot({disabled: false,pending: false});window.controlsRegression.resolveAction();});
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => window.controlsRegression.counts().actions)).toBe(2);
});

test('an asynchronous copy keeps pending through snapshots and restores the current disabled or loading state',async ({page}) => {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  const button = page.getByRole('button',{name: 'Copy result',exact: true});
  await button.click();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy','true');
  await page.evaluate(() => window.controlsRegression.copySnapshot({disabled: false,pending: false}));
  await expect(button).toBeDisabled();
  await button.dispatchEvent('click');
  expect(await page.evaluate(() => window.controlsRegression.counts().copies)).toBe(1);
  await page.evaluate(() => {window.controlsRegression.copySnapshot({disabled: true,pending: false});window.controlsRegression.resolveCopy();});
  const copied = page.getByRole('button',{name: 'Result copied.',exact: true});
  await expect(copied).toHaveText('Copied');
  await expect(page.getByRole('status')).toHaveText('Result copied.');
  await page.evaluate(() => window.controlsRegression.copySnapshot({disabled: true,pending: false}));
  await expect(copied).toBeDisabled();
  await page.clock.fastForward(1500);
  await expect(button).toBeDisabled();
  await page.evaluate(() => window.controlsRegression.copySnapshot({disabled: false,pending: false}));
  await expect(button).toBeEnabled();
  await button.click();
  await page.evaluate(() => {window.controlsRegression.copySnapshot({disabled: false,pending: true});window.controlsRegression.resolveCopy();});
  await expect(copied).toHaveText('Copied');
  await page.clock.fastForward(1500);
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy','true');
  await page.evaluate(() => window.controlsRegression.copySnapshot({disabled: false,pending: false}));
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => window.controlsRegression.counts().copies)).toBe(2);
});
