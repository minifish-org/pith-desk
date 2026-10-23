import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => (window as any).reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!.readOnly);
});

test('long approval, runtime and queue panels keep the composer reachable in short windows', async ({ page }) => {
  for (const viewport of [{ width: 900, height: 568 }, { width: 1366, height: 736 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      const fixture = (window as any);
      fixture.reviewState.running = true;
      fixture.reviewState.runtime.phase = 'tool';
      fixture.reviewState.pendingApproval = {
        id: 'approval', toolName: 'edit_file', args: { path: 'result.md', edits: Array.from({ length: 20 }, () => ({ oldText: 'old line', newText: 'new line' })) },
        preview: { kind: 'modify', path: 'result.md', diff: '--- a/result.md\n+++ b/result.md\n' + '-old line\n+new line\n'.repeat(50) },
      };
      fixture.reviewState.queuedMessages = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, text: 'Pending follow-up message', mode: 'follow-up' }));
      fixture.emitReview();
    });
    await page.getByRole('button', {name: 'Tool arguments', exact: true}).click();
    await page.locator('[data-runtime-summary]').click();
    await page.getByRole('textbox', {name: 'Message Pith'}).fill('A multiline draft\n'.repeat(6));
    const geometry = await page.getByRole('button', {name: 'Queue message'}).evaluate(button => ({
      bottom: button.getBoundingClientRect().bottom,
      bodyHeight: document.documentElement.scrollHeight,
      viewport: innerHeight,
      topbarTop: document.querySelector('header')!.getBoundingClientRect().top,
    }));
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.bodyHeight).toBe(geometry.viewport);
    expect(geometry.topbarTop).toBe(0);
    for (const name of ['Deny', 'Always allow workspace changes', 'Allow this action']) {
      const action = page.getByRole('button', {name, exact: true});
      await action.scrollIntoViewIfNeeded();
      const rect = (await action.boundingBox())!;
      expect(rect.y).toBeGreaterThanOrEqual(44);
      expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.getByRole('textbox', {name: 'Message Pith'}).fill('');
    const stop = page.getByRole('button', {name: 'Stop agent'});
    await expect(stop).toBeVisible();
    if (viewport.width === 1366) {
      await stop.click();
      await expect.poll(() => page.evaluate(() => (window as any).review.requests.filter((r: any) => r.path === '/api/abort').length)).toBe(1);
    }
  }
});

test('model catalog displays multiple choices and applies the chosen model', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any), model = fixture.review.models.models[0];
    fixture.review.models.models.push(...Array.from({ length: 8 }, (_, i) => ({ ...model, id: `model-${i}`, name: `Model ${i}` })));
  });
  await page.getByRole('button', {name: 'Choose model'}).click();
  const dialog = page.getByRole('dialog', {name: 'Choose model'});
  await expect(dialog.getByRole('button', {name: /Model 7/})).toBeVisible();
  await dialog.getByRole('button', {name: /Model 7/}).click();
  await dialog.getByRole('button', {name: 'Use this model'}).click();
  await expect.poll(() => page.evaluate(() => (window as any).review.requests.find((r: any) => r.path === '/api/model-selection')?.body.model)).toBe('model-7');
});

test('image viewer keeps its source focus and ignores internal clicks', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'picture.png', { type: 'image/png' }));
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement; picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const trigger = page.getByRole('button', {name: 'Open picture.png'});
  await trigger.click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await viewer.click({position: {x: 5, y: 60}});
  await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(viewer).toBeVisible();
  await page.locator('[data-slot="dialog-overlay"]').click({position: {x: 4, y: 4}});
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('OAuth sign-in failures use an accessible error status', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.reviewState.login = {id: 'failure', provider: 'custom-test', phase: 'error', message: 'Provider sign-in failed. Please try again.'};
    fixture.emitReview();
  });
  const dialog = page.getByRole('dialog', {name: 'Sign in with custom-test'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText('Provider sign-in failed. Please try again.');
  expect(await page.evaluate(() => (window as any).review.requests.some((r: any) => r.path === '/api/oauth/answer'))).toBe(false);
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(dialog).toHaveCount(0);
});

test('the workspace Change control opens the picker without changing the logo action', async ({ page }) => {
  await page.evaluate(() => {(window as any).reviewState.messages = []; (window as any).emitReview();});
  const change = page.getByRole('button', {name: 'Change', exact: true});
  await expect(change).toBeVisible();
  await change.press('Space');
  await expect(page.getByRole('dialog', {name: 'Workspaces', exact: true})).toBeVisible();
  expect(await page.locator('[data-brand]').evaluate(element => element.getAttribute('tabindex'))).toBeNull();
});
