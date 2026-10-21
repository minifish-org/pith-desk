import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly);
});

test('connection actions use form buttons without submitting while resetting or revealing fields', async ({ page }) => {
  await page.getByRole('button', {name: 'Connections', exact: true}).click();
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await expect(page.locator('input[aria-label="Name"]')).toHaveAttribute('readonly', '');
  const create = page.getByRole('button', { name: 'New connection', exact: true });
  const styles = await create.evaluate(el => ({ height: el.getBoundingClientRect().height, decoration: getComputedStyle(el).textDecorationLine, background: getComputedStyle(el).backgroundColor, reference: getComputedStyle(document.querySelector('.pui-feature-toolbar[aria-label="Connections actions"] button')).backgroundColor }));
  expect(styles.height).toBe(40);
  expect(styles.decoration).toBe('none');
  expect(styles.background).toBe(styles.reference);
  await create.press('Enter');
  await expect(page.locator('input[aria-label="Name"]')).toHaveValue('');
  await expect(page.locator('input[aria-label="Name"]')).toBeFocused();
  await expect(page.locator('.pui-connection-editor > .pui-section-heading > span')).toHaveText('Add connection');
  await expect(page.locator('input[aria-label="Name"]')).not.toHaveAttribute('readonly', '');
  await page.locator('select[aria-label="Connection type"]').selectOption('stdio');
  await page.locator('textarea[name="env"]').fill('{"DEMO":"local example"}');
  const visibility = page.locator('.pui-secret-label button');
  expect(await visibility.evaluate(el => document.querySelector('textarea[name="env"]').getBoundingClientRect().top - el.getBoundingClientRect().bottom)).toBe(8);
  await visibility.press('Space');
  await expect(visibility).toHaveText('Hide');
  await expect(visibility).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('textarea[name="env"]')).toHaveClass(/revealed/);
  await visibility.press('Enter');
  await expect(visibility).toHaveText('Show');
  await expect(visibility).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('textarea[name="env"]')).toHaveValue('{"DEMO":"local example"}');
  expect(await page.evaluate(() => window.review.requests.some(r => r.method === 'POST'))).toBe(false);
});

test('model removal uses the existing destructive button and only changes the unsaved form', async ({ page }) => {
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await page.getByRole('button', { name: 'Add independent model connection', exact: true }).click();
  await page.getByRole('button', {name: 'Add model', exact: true}).click();
  await expect(page.locator('fieldset.pui-custom-model')).toHaveCount(2);
  const remove = page.getByRole('button', { name: 'Remove model', exact: true }).first();
  const styles = await remove.evaluate(el => ({ height: el.getBoundingClientRect().height, decoration: getComputedStyle(el).textDecorationLine, color: getComputedStyle(el).color, errorColor: getComputedStyle(document.querySelector('dialog.pui-feature-modal .pui-form-error')).color }));
  expect(styles.height).toBe(40);
  expect(styles.decoration).toBe('none');
  expect(styles.color).toBe(styles.errorColor);
  expect(await remove.evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom)).toBe(8);
  await remove.press('Enter');
  await expect(page.locator('fieldset.pui-custom-model')).toHaveCount(1);
  await expect(page.locator('dialog.pui-feature-modal')).toBeVisible();
  expect(await page.evaluate(() => window.review.requests.some(r => r.method === 'POST'))).toBe(false);
});

test('workspace Change activates as a button while the logo keeps its style without an action or tab stop', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.messages = []; window.emitReview(); });
  const change = page.getByRole('button', { name: 'Change', exact: true });
  expect(await change.evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('none');
  await change.press('Space');
  await expect(page.locator('dialog:has(input[aria-label="Absolute folder path"])')).toBeVisible();
  await page.locator('dialog:has(input[aria-label="Absolute folder path"]) [data-close]').first().click();
  const logo = page.locator('.pui-brand');
  const appearance = await logo.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, font: getComputedStyle(el).fontSize, align: getComputedStyle(el).textAlign, border: getComputedStyle(el).borderTopWidth }));
  expect(appearance).toEqual({ background: 'rgba(0, 0, 0, 0)', font: '16px', align: 'start', border: '0px' });
  const url = page.url();
  expect(await logo.evaluate(el => el.tabIndex)).toBe(-1);
  await page.getByRole('searchbox',{name: 'Search conversation titles',exact: true}).focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(logo).not.toBeFocused();
  await logo.click();
  await expect(page.locator('textarea[aria-label="Message Pith"]')).not.toBeFocused();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.reviewState.activeId)).toBe('a');
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
    await page.locator('.pui-approval-arguments').evaluate(el => { el.open = true; });
    await page.locator('.pui-run-status').evaluate(el => { el.open = true; });
    await page.locator('textarea[aria-label="Message Pith"]').fill('A multiline draft\n'.repeat(6));
    const geometry = await page.locator('.pui-send-button').evaluate(button => ({ bottom: button.getBoundingClientRect().bottom, bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight, topbarTop: document.querySelector('.pui-topbar').getBoundingClientRect().top, panelsHeight: document.querySelector('.pui-composer-panels').clientHeight }));
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.bodyHeight).toBe(viewport.height);
    expect(geometry.topbarTop).toBe(0);
    expect(geometry.panelsHeight).toBeGreaterThan(0);
    for (const action of ['deny', 'always', 'allow']) {
      await page.getByRole('button', {name: ({deny: 'Deny', always: 'Always allow workspace changes', allow: 'Allow this action'})[action], exact: true}).scrollIntoViewIfNeeded();
      const rect = await page.getByRole('button', {name: ({deny: 'Deny', always: 'Always allow workspace changes', allow: 'Allow this action'})[action], exact: true}).boundingBox();
      expect(rect.y).toBeGreaterThanOrEqual(79);
      expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.locator('textarea[aria-label="Message Pith"]').fill('');
    await expect(page.locator('.pui-send-button')).toHaveAttribute('aria-label', 'Stop agent');
  }
  await page.locator('.pui-send-button').click();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/abort').length)).toBe(1);
});

test('model catalog displays multiple choices while single-line controls retain their height', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 568 });
  await page.evaluate(() => { const model = window.review.models.models[0]; window.review.models.models.push(...Array.from({ length: 8 }, (_, i) => ({ ...model, id: `model-${i}`, name: `Model ${i}` }))); });
  await page.locator('.pui-composer-model').click();
  await expect(page.locator('select[aria-label="Choose model"] option')).toHaveCount(9);
  const sizes = await page.locator('dialog:has(select[aria-label="Choose model"])').evaluate(dialog => ({ list: dialog.querySelector('select[aria-label="Choose model"]').getBoundingClientRect().height, provider: dialog.querySelector('select[aria-label="Provider"]').getBoundingClientRect().height }));
  expect(sizes.list).toBeGreaterThanOrEqual(100);
  expect(sizes.provider).toBe(40);
  await page.locator('select[aria-label="Choose model"]').selectOption('model-7');
  await page.getByRole('button', {name: 'Use model', exact: true}).click();
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/model-selection').body.model)).toBe('model-7');
});

test('loaded SDK content retains an actionable focus and history uses conversation text sizing', async ({ page }) => {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, options) => new URL(url, location.href).pathname === '/api/history'
      ? Promise.resolve(Response.json([{ id: 'h', role: 'user', text: 'A saved message 中文', active: true }])) : fetch(url, options);
  });
  await page.getByRole('button', {name: 'Actions for Conversation a', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Conversation branches', exact: true}).click();
  await expect(page.locator('dialog.pui-feature-modal:last-of-type [data-close]').first()).toBeFocused();
  await expect(page.locator('.pui-branch-node')).toHaveCount(1);
  const text = await page.locator('.pui-branch-node p').evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight }));
  expect(text).toEqual({ size: '14px', line: '21px' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.locator('dialog:has(.pui-feature-toolbar[aria-label="Resource actions"])').getByRole('button', { name: 'Add skill', exact: true }).click();
  await expect(page.locator('dialog.pui-feature-modal:last-of-type [data-close]').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('input[aria-label="Name"]')).toBeFocused();
});

test('dark search highlight uses the theme foreground without changing match navigation', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.settings.appearance = 'dark'; window.reviewState.messages = [{ id: 'u', role: 'user', text: 'target and target' }]; window.emitReview(); });
  await page.keyboard.press('Meta+f');
  await page.locator('.pui-conversation-find input').fill('target');
  await expect(page.locator('[data-find-count]')).toHaveText('1 / 2');
  expect(await page.locator('.pui-find-current').evaluate(el => getComputedStyle(el).color)).toBe('rgb(23, 36, 53)');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-find-count]')).toHaveText('2 / 2');
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('[data-find-count]')).toHaveText('1 / 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pui-conversation-find')).toBeHidden();
});

test('image viewer ignores internal padding clicks and keeps its source focus on close', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'picture.png', { type: 'image/png' }));
    const picker = document.querySelector('input[type="file"]'); picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.pui-draft-image img').click();
  await page.locator('dialog.pui-image-viewer').click({ position: { x: 5, y: 60 } });
  await expect(page.locator('dialog.pui-image-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pui-draft-image img')).toBeFocused();
  await page.locator('.pui-draft-image img').press('Enter');
  await page.locator('dialog.pui-image-viewer').evaluate(dialog => { const rect = dialog.getBoundingClientRect(); dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left - 5, clientY: rect.top - 5 })); });
  await expect(page.locator('dialog.pui-image-viewer')).not.toBeVisible();
  await expect(page.locator('.pui-draft-image img')).toBeFocused();
  await page.evaluate(() => { window.reviewState.settings.supportsImages = false; window.emitReview(); });
  await expect(page.locator('.pui-image-guidance')).toContainText('beside the message box');
  await expect(page.locator('.pui-send-button')).toBeDisabled();
});

test('OAuth prompts keep form spacing and failed sign-in uses an accessible error status', async ({ page }) => {
  for (const prompt of [{ promptType: 'text' }, { promptType: 'secret' }, { options: [{ id: 'yes', label: 'Yes' }] }]) {
    await page.evaluate(prompt => { window.reviewState.login = { id: JSON.stringify(prompt), provider: 'custom-test', phase: 'prompt', message: 'Enter the provider value.', prompt: 'Verification value', ...prompt }; window.emitReview(); }, prompt);
    const gap = await page.locator('.pui-answer-form').evaluate(form => form.querySelector('button[type="submit"]').getBoundingClientRect().top - form.querySelector(':is(input,select)').getBoundingClientRect().bottom);
    expect(gap).toBe(12);
  }
  await page.evaluate(() => { window.reviewState.login = { id: 'failure', provider: 'custom-test', phase: 'error', message: 'Provider sign-in failed. Please try again.' }; window.emitReview(); });
  await expect(page.locator('.pui-provider-login-status')).toHaveAttribute('role', 'alert');
  const styles = await page.locator('.pui-provider-login-status').evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight, color: getComputedStyle(el).color, expectedColor: getComputedStyle(document.querySelector('.pui-answer-form + .pui-form-error')).color }));
  expect(styles).toMatchObject({ size: '14px', line: '21px' });
  expect(styles.color).toBe(styles.expectedColor);
  expect(await page.evaluate(() => window.review.requests.some(r => r.path === '/api/oauth/answer'))).toBe(false);
});
