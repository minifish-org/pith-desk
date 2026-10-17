import { test, expect } from './test.ts';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !window.uiQuery('[id$=composer-input]').readOnly);
});

test('connection actions use form buttons without submitting while resetting or revealing fields', async ({ page }) => {
  await page.locator('ui=[data-action="connections"]').click();
  await page.locator('ui=[data-mcp-edit]').click();
  await expect(page.locator('ui=[id$=mcp-name]')).toHaveAttribute('readonly', '');
  const create = page.getByRole('button', { name: 'New connection', exact: true });
  const styles = await create.evaluate(el => ({ height: el.getBoundingClientRect().height, decoration: getComputedStyle(el).textDecorationLine, background: getComputedStyle(el).backgroundColor, reference: getComputedStyle(window.uiQuery('[data-action="refresh-mcp"]')).backgroundColor }));
  expect(styles.height).toBe(40);
  expect(styles.decoration).toBe('none');
  expect(styles.background).toBe(styles.reference);
  await create.press('Enter');
  await expect(page.locator('ui=[id$=mcp-name]')).toHaveValue('');
  await expect(page.locator('ui=[id$=mcp-name]')).toBeFocused();
  await expect(page.locator('ui=[id$=mcp-form-title]')).toHaveText('Add connection');
  await expect(page.locator('ui=[id$=mcp-name]')).not.toHaveAttribute('readonly', '');
  await page.locator('ui=[id$=mcp-type]').selectOption('stdio');
  await page.locator('ui=[id$=mcp-env]').fill('{"DEMO":"local example"}');
  const visibility = page.locator('ui=[id$=mcp-env-visibility]');
  expect(await visibility.evaluate(el => el.getBoundingClientRect().top-window.uiQuery('[id$=mcp-env]').getBoundingClientRect().bottom)).toBe(8);
  await visibility.press('Space');
  await expect(visibility).toHaveText('Hide');
  await expect(visibility).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('ui=[id$=mcp-env]').evaluate(node=>getComputedStyle(node).getPropertyValue('-webkit-text-security'))).toBe('none');
  await visibility.press('Enter');
  await expect(visibility).toHaveText('Show');
  await expect(visibility).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('ui=[id$=mcp-env]')).toHaveValue('{"DEMO":"local example"}');
  expect(await page.evaluate(() => window.review.requests.some(r => r.method === 'POST'))).toBe(false);
});

test('model removal uses the existing destructive button and only changes the unsaved form', async ({ page }) => {
  await page.locator('ui=[id$=sidebar] [data-action="settings"]').click();
  await page.getByRole('button', { name: 'Add model connection', exact: true }).click();
  await page.locator('ui=[id$=add-custom-model]').click();
  await expect(page.locator('ui=[id$=custom-models] fieldset')).toHaveCount(2);
  const remove = page.getByRole('button', { name: 'Remove model', exact: true }).first();
  const styles = await remove.evaluate(el => ({ height: el.getBoundingClientRect().height, decoration: getComputedStyle(el).textDecorationLine, color: getComputedStyle(el).color, errorColor: getComputedStyle(window.uiQuery('[id$=sdk-error]')).color }));
  expect(styles.height).toBe(40);
  expect(styles.decoration).toBe('none');
  expect(styles.color).toBe(styles.errorColor);
  expect(await remove.evaluate(el => el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().bottom)).toBe(12);
  await remove.press('Enter');
  await expect(page.locator('ui=[id$=custom-models] fieldset')).toHaveCount(1);
  await expect(page.locator('ui=[id$=sdk-dialog]')).toBeVisible();
  expect(await page.evaluate(() => window.review.requests.some(r => r.method === 'POST'))).toBe(false);
});

test('workspace Change activates as a button while the logo keeps its style without an action or tab stop', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.messages = []; window.emitReview(); });
  const change = page.getByRole('button', { name: 'Change workspace', exact: true });
  expect(await change.evaluate(el => getComputedStyle(el).textDecorationLine)).toBe('none');
  await change.press('Space');
  await expect(page.locator('ui=[id$=workspace-dialog]')).toBeVisible();
  await page.locator('ui=[id$=workspace-dialog] [data-close]').first().click();
  const logo = page.locator('ui=.pui-brand');
  const appearance = await logo.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, font: getComputedStyle(el.querySelector('h3')).fontSize, align: getComputedStyle(el).textAlign, border: getComputedStyle(el).borderTopWidth }));
  expect(appearance).toEqual({ background: 'rgba(0, 0, 0, 0)', font: '16px', align: 'start', border: '0px' });
  const url = page.url();
  expect(await logo.evaluate(el => el.tabIndex)).toBe(-1);
  await page.locator('ui=[id$=history-search]').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(logo).not.toBeFocused();
  await logo.click();
  await expect(page.locator('ui=[id$=composer-input]')).not.toBeFocused();
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
    await page.locator('ui=.pui-approval-arguments').evaluate(el => { el.open = true; });
    await page.locator('ui=[id$=run-status]').evaluate(el => { el.open = true; });
    await page.locator('ui=[id$=composer-input]').fill('A multiline draft\n'.repeat(6));
    const geometry = await page.locator('ui=[id$=send-button]').evaluate(button => ({ bottom: button.getBoundingClientRect().bottom, bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight, topbarTop: window.uiQuery('.pui-topbar').getBoundingClientRect().top, panelsHeight: window.uiQuery('.pui-composer-panels').clientHeight }));
    expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
    expect(geometry.bodyHeight).toBe(viewport.height);
    expect(geometry.topbarTop).toBeGreaterThanOrEqual(0);expect(geometry.topbarTop).toBeLessThanOrEqual(24);
    expect(geometry.panelsHeight).toBeGreaterThan(0);
    for (const action of ['deny', 'always', 'allow']) {
      await page.locator(`ui=[data-approval="${action}"]`).scrollIntoViewIfNeeded();
      const rect = await page.locator(`ui=[data-approval="${action}"]`).boundingBox();
      expect(rect.y).toBeGreaterThanOrEqual(79);
      expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
    }
    await page.locator('ui=[id$=composer-input]').fill('');
    await expect(page.locator('ui=[id$=send-button]')).toHaveAttribute('aria-label', 'Stop agent');
  }
  await page.locator('ui=[id$=send-button]').click();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/abort').length)).toBe(1);
});

test('model catalog displays multiple choices while single-line controls retain their height', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 568 });
  await page.evaluate(() => { const model = window.review.models.models[0]; window.review.models.models.push(...Array.from({ length: 8 }, (_, i) => ({ ...model, id: `model-${i}`, name: `Model ${i}` }))); });
  await page.locator('ui=[id$=composer-model]').click();
  await expect(page.locator('ui=[id$=picker-model] option')).toHaveCount(9);
  const sizes = await page.locator('ui=[id$=model-dialog]').evaluate(dialog => ({ list: window.uiQuery('[id$=picker-model]').getBoundingClientRect().height, provider: window.uiQuery('[id$=picker-provider]').getBoundingClientRect().height }));
  expect(sizes.list).toBeGreaterThanOrEqual(100);
  expect(sizes.provider).toBe(40);
  await page.locator('ui=[id$=picker-model]').selectOption('model-7');
  await page.locator('ui=[id$=choose-model]').click();
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/model-selection').body.model)).toBe('model-7');
});

test('loaded SDK content retains an actionable focus and history uses conversation text sizing', async ({ page }) => {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (url, options) => new URL(url, location.href).pathname === '/api/history'
      ? Promise.resolve(Response.json([{ id: 'h', role: 'user', text: 'A saved message 中文', active: true }])) : fetch(url, options);
  });
  await page.locator('ui=[data-conversation-menu="a"]').click();
  await page.locator('ui=[data-action="history"]').click();
  await expect(page.locator('ui=[id$=sdk-dialog] [data-close]').first()).toBeFocused();
  await expect(page.locator('ui=.pui-branch-node')).toHaveCount(1);
  const text = await page.locator('ui=.pui-branch-node p').evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight }));
  expect(text).toEqual({ size: '14px', line: '21px' });
  await page.keyboard.press('Escape');
  await page.locator('ui=[data-action="resources"]').click();
  await page.locator('ui=[id$=resources-content]').getByRole('button', { name: 'Add skill', exact: true }).click();
  await expect(page.locator('ui=[id$=sdk-dialog] [data-close]').first()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('ui=[id$=resource-name]')).toBeFocused();
});

test('dark search highlight uses the theme foreground without changing match navigation', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.settings.appearance = 'dark'; window.reviewState.messages = [{ id: 'u', role: 'user', text: 'target and target' }]; window.emitReview(); });
  await page.keyboard.press('Meta+f');
  await page.locator('ui=[id$=conversation-find] input').fill('target');
  await expect(page.locator('ui=[data-find-count]')).toHaveText('1 / 2');
  expect(await page.locator('ui=.pui-find-current').evaluate(el => getComputedStyle(el).color)).toBe('rgb(23, 36, 53)');
  await page.keyboard.press('Enter');
  await expect(page.locator('ui=[data-find-count]')).toHaveText('2 / 2');
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('ui=[data-find-count]')).toHaveText('1 / 2');
  await page.keyboard.press('Escape');
  await expect(page.locator('ui=[id$=conversation-find]')).toBeHidden();
});

test('image viewer ignores internal padding clicks and keeps its source focus on close', async ({ page }) => {
  await page.getByRole('button',{name:'Attach images',exact:true}).click();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'picture.png', { type: 'image/png' }));
    const picker = window.uiQuery('[id$=image-picker]'); picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('ui=.pui-draft-image img').click();
  await page.locator('ui=[id$=image-dialog]').click({ position: { x: 5, y: 60 } });
  await expect(page.locator('ui=[id$=image-dialog]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pui-image-attachment > .pui-image-open')).toBeFocused();
  await page.locator('.pui-image-attachment > .pui-image-open').press('Enter');
  await page.locator('ui=[id$=image-dialog]').evaluate(dialog => { const rect = dialog.getBoundingClientRect(); dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left - 5, clientY: rect.top - 5 })); });
  await expect(page.locator('ui=[id$=image-dialog]')).not.toBeVisible();
  await expect(page.locator('.pui-image-attachment > .pui-image-open')).toBeFocused();
  await page.evaluate(() => { window.reviewState.settings.supportsImages = false; window.emitReview(); });
  await expect(page.locator('ui=[id$=image-guidance]')).toContainText('beside the message box');
  await expect(page.locator('ui=[id$=send-button]')).toBeDisabled();
});

test('OAuth prompts keep form spacing and failed sign-in uses an accessible error status', async ({ page }) => {
  for (const prompt of [{ promptType: 'text' }, { promptType: 'secret' }, { options: [{ id: 'yes', label: 'Yes' }] }]) {
    await page.evaluate(prompt => { window.reviewState.login = { id: JSON.stringify(prompt), provider: 'custom-test', phase: 'prompt', message: 'Enter the provider value.', prompt: 'Verification value', ...prompt }; window.emitReview(); }, prompt);
    const gap = await page.locator('ui=[id$=oauth-answer]').evaluate(form => form.querySelector('button[type="submit"]').getBoundingClientRect().top - window.uiQuery('[id$=oauth-value]').getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(12);expect(gap).toBeLessThanOrEqual(64);
  }
  await page.evaluate(() => { window.reviewState.login = { id: 'failure', provider: 'custom-test', phase: 'error', message: 'Provider sign-in failed. Please try again.' }; window.emitReview(); });
  await expect(page.locator('ui=.pui-provider-login-status')).toHaveAttribute('role', 'alert');
  const styles = await page.locator('ui=.pui-provider-login-status').evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight, color: getComputedStyle(el).color, expectedColor: getComputedStyle(window.uiQuery('[id$=oauth-error]')).color }));
  expect(styles).toMatchObject({ size: '14px', line: '21px' });
  expect(styles.color).toBe(styles.expectedColor);
  expect(await page.evaluate(() => window.review.requests.some(r => r.path === '/api/oauth/answer'))).toBe(false);
});
