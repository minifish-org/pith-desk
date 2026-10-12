import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('#composer-input').readOnly);
});

test('long approval, runtime and queue panels keep the composer reachable in short windows', async ({ page }) => {
  for (const viewport of [{ width: 900, height: 568 }, { width: 1366, height: 736 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      window.reviewState.running = true;
      window.reviewState.runtime.phase = 'tool';
      window.reviewState.pendingApproval = {
        id: 'approval', toolName: 'edit_file', args: { path: 'result.md', edits: Array.from({ length: 20 }, () => ({ oldText: 'old line', newText: 'new line' })) },
        preview: { kind: 'modify', path: 'result.md', diff: '--- a/result.md\n+++ b/result.md\n' + '-old line\n+new line\n'.repeat(50) },
      };
      window.reviewState.queuedMessages = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, text: 'Pending follow-up message', mode: 'follow-up' }));
      window.emitReview();
    });
    await page.locator('.approval-arguments').evaluate(el => { el.open = true; });
    await page.locator('#run-status').evaluate(el => { el.open = true; });
    await page.locator('#composer-input').fill('A multiline draft\n'.repeat(6));
    const geometry = await page.locator('#send-button').evaluate(button => ({ bottom: button.getBoundingClientRect().bottom, bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight, topbarTop: document.querySelector('.topbar').getBoundingClientRect().top, panelsHeight: document.querySelector('.composer-panels').clientHeight }));
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.bodyHeight).toBe(viewport.height);
    expect(geometry.topbarTop).toBe(0);
    expect(geometry.panelsHeight).toBeGreaterThan(0);
    for (const action of ['deny', 'always', 'allow']) {
      await page.locator(`[data-approval="${action}"]`).scrollIntoViewIfNeeded();
      const rect = await page.locator(`[data-approval="${action}"]`).boundingBox();
      expect(rect.y).toBeGreaterThanOrEqual(79);
      expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.locator('#composer-input').fill('');
    await expect(page.locator('#send-button')).toHaveAttribute('aria-label', 'Stop agent');
  }
  await page.locator('#send-button').click();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/abort').length)).toBe(1);
});

test('model catalog displays multiple choices while single-line controls retain their height', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 568 });
  await page.evaluate(() => { const model = window.review.models.models[0]; window.review.models.models.push(...Array.from({ length: 8 }, (_, i) => ({ ...model, id: `model-${i}`, name: `Model ${i}` }))); });
  await page.locator('#composer-model').click();
  await expect(page.locator('#picker-model option')).toHaveCount(9);
  const sizes = await page.locator('#model-dialog').evaluate(dialog => ({ list: dialog.querySelector('#picker-model').getBoundingClientRect().height, provider: dialog.querySelector('#picker-provider').getBoundingClientRect().height }));
  expect(sizes.list).toBeGreaterThanOrEqual(100);
  expect(sizes.provider).toBe(40);
  await page.locator('#picker-model').selectOption('model-7');
  await page.locator('#choose-model').click();
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/model-selection').body.model)).toBe('model-7');
});

test('loaded SDK content retains an actionable focus and history uses conversation text sizing', async ({ page }) => {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, options) => new URL(url, location.href).pathname === '/api/history'
      ? Promise.resolve(Response.json([{ id: 'h', role: 'user', text: 'A saved message 中文', active: true }])) : fetch(url, options);
  });
  await page.locator('[data-conversation-menu="a"]').click();
  await page.locator('[data-sdk="history"]').click();
  await expect(page.locator('#sdk-dialog [data-close]').first()).toBeFocused();
  await expect(page.locator('.branch-node')).toHaveCount(1);
  const text = await page.locator('.branch-node p').evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight }));
  expect(text).toEqual({ size: '14px', line: '21px' });
  await page.keyboard.press('Escape');
  await page.locator('[data-action="resources"]').click();
  await page.locator('#resources-content [data-kind="skill"]').click();
  await expect(page.locator('#sdk-dialog [data-close]').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#resource-name')).toBeFocused();
});

test('dark search highlight uses the theme foreground without changing match navigation', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.settings.appearance = 'dark'; window.reviewState.messages = [{ id: 'u', role: 'user', text: 'target and target' }]; window.emitReview(); });
  await page.keyboard.press('Meta+f');
  await page.locator('#conversation-find input').fill('target');
  await expect(page.locator('[data-find-count]')).toHaveText('1 / 2');
  expect(await page.locator('.find-current').evaluate(el => getComputedStyle(el).color)).toBe('rgb(23, 36, 53)');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-find-count]')).toHaveText('2 / 2');
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('[data-find-count]')).toHaveText('1 / 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('#conversation-find')).toBeHidden();
});

test('image viewer ignores internal padding clicks and keeps its source focus on close', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'picture.png', { type: 'image/png' }));
    const picker = document.querySelector('#image-picker'); picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.draft-image img').click();
  await page.locator('#image-dialog').click({ position: { x: 5, y: 60 } });
  await expect(page.locator('#image-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.draft-image img')).toBeFocused();
  await page.locator('.draft-image img').press('Enter');
  await page.locator('#image-dialog').evaluate(dialog => { const rect = dialog.getBoundingClientRect(); dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left - 5, clientY: rect.top - 5 })); });
  await expect(page.locator('#image-dialog')).not.toBeVisible();
  await expect(page.locator('.draft-image img')).toBeFocused();
  await page.evaluate(() => { window.reviewState.settings.supportsImages = false; window.emitReview(); });
  await expect(page.locator('#image-guidance')).toContainText('beside the message box');
  await expect(page.locator('#send-button')).toBeDisabled();
});

test('OAuth prompts keep form spacing and failed sign-in uses an accessible error status', async ({ page }) => {
  for (const prompt of [{ promptType: 'text' }, { promptType: 'secret' }, { options: [{ id: 'yes', label: 'Yes' }] }]) {
    await page.evaluate(prompt => { window.reviewState.login = { id: JSON.stringify(prompt), provider: 'custom-test', phase: 'prompt', message: 'Enter the provider value.', prompt: 'Verification value', ...prompt }; window.emitReview(); }, prompt);
    const gap = await page.locator('#oauth-answer').evaluate(form => form.querySelector('button').getBoundingClientRect().top - form.querySelector('#oauth-value').getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(12);
  }
  await page.evaluate(() => { window.reviewState.login = { id: 'failure', provider: 'custom-test', phase: 'error', message: 'Provider sign-in failed. Please try again.' }; window.emitReview(); });
  await expect(page.locator('.provider-login-status')).toHaveAttribute('role', 'alert');
  const styles = await page.locator('.provider-login-status').evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight, color: getComputedStyle(el).color, expectedColor: getComputedStyle(document.querySelector('#oauth-error')).color }));
  expect(styles).toMatchObject({ size: '13px', line: '20px' });
  expect(styles.color).toBe(styles.expectedColor);
  expect(await page.evaluate(() => window.review.requests.some(r => r.path === '/api/oauth/answer'))).toBe(false);
});
