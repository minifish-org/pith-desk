import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('#composer-input').readOnly);
});

test('stream updates preserve historical selection, code scroll and focus', async ({ page }) => {
  const result = await page.evaluate(() => {
    const range = document.createRange(), selection = getSelection();
    range.selectNodeContents(document.querySelector('.pui-user-text'));
    selection.removeAllRanges(); selection.addRange(range);
    const pre = document.querySelector('.pui-code-block pre'); pre.scrollLeft = 100;
    const historical = document.querySelector('[data-reading-id="old-answer"]');
    window.reviewState.messages.at(-1).text += ' updated'; window.emitReview();
    return { selected: selection.toString(), scroll: pre.scrollLeft, sameNode: historical === document.querySelector('[data-reading-id="old-answer"]') };
  });
  expect(result).toEqual({ selected: 'Stable historical text to select', scroll: 100, sameNode: true });
  await page.locator('[data-copy-message="old-answer"]').focus();
  await page.evaluate(() => { window.reviewState.messages.at(-1).text += ' again'; window.emitReview(); });
  await expect(page.locator('[data-copy-message="old-answer"]')).toBeFocused();
});

test('text and image drafts restore together after switching and reload', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([png], 'draft-image.png', { type: 'image/png' }));
    const picker = document.querySelector('#image-picker'); picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await page.locator('#composer-input').fill('Keep this draft');
  await page.locator('[data-conversation="b"]').click();
  await expect(page.locator('.pui-draft-image')).toHaveCount(0);
  await expect(page.locator('#composer-input')).toHaveValue('');
  await page.locator('[data-conversation="a"]').click();
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await expect(page.locator('#composer-input')).toHaveValue('Keep this draft');
  // Host storage lives outside a browser origin; seed it into a fresh frontend.
  await page.locator('#composer-input').blur();
  await expect.poll(() => page.evaluate(() => window.review.drafts.a?.images?.length)).toBe(1);
  const saved = await page.evaluate(() => window.review.drafts.a);
  await page.addInitScript((draft) => { window.review.drafts.a = draft; }, saved);
  await page.reload();
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await expect(page.locator('#composer-input')).toHaveValue('Keep this draft');
});

test('stream snapshots cannot enable a model picker still loading', async ({ page }) => {
  await page.evaluate(() => { window.review.holdModels = true; });
  await page.locator('#composer-model').click();
  await expect(page.locator('#choose-model')).toBeDisabled();
  await page.evaluate(() => { window.reviewState.runtime.contextTokens++; window.emitReview(); });
  await expect(page.locator('#choose-model')).toBeDisabled();
  await page.evaluate(() => window.releaseModels());
  await expect(page.locator('#choose-model')).toBeEnabled();
});

test('a committed create operation reports refresh trouble without a retry', async ({ page }) => {
  await page.locator('[data-new-workspace="w"]').click();
  await expect(page.locator('#inline-error')).toContainText('Change saved.');
  expect(await page.evaluate(() => window.reviewState.conversations.filter(c => c.id.startsWith('created-')).length)).toBe(1);
  await page.evaluate(() => window.emitReview());
  await expect(page.locator('#conversation-label')).toHaveText('New conversation');
});

test('resource edits keep the dialog workspace after a notification switches conversations', async ({ page }) => {
  await page.locator('[data-action="resources"]').click();
  await page.evaluate(() => { window.reviewState.activeId = 'b'; window.reviewState.conversations.find(c => c.id === 'b').workspaceId = 'other'; window.emitReview(); });
  await page.locator('#resources-content').getByRole('button', { name: 'Add skill', exact: true }).click();
  await expect(page.locator('#sdk-content .pui-file-path')).toHaveText('/tmp/pith-review');
  expect(await page.evaluate(() => window.reviewState.activeId)).toBe('b');
  await page.locator('#resource-name').fill('fixture-skill');
  await page.locator('#resource-form [type="submit"]').click();
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/resource').body.workspaceId)).toBe('w');
});

test('dialogs share accessible headings, close icons and form control sizes', async ({ page }, testInfo) => {
  await page.locator('[data-action="resources"]').click();
  await page.locator('#resources-content').getByRole('button', { name: 'Add skill', exact: true }).click();
  const resource = await page.locator('#sdk-dialog').evaluate(dialog => ({ label: dialog.getAttribute('aria-labelledby'), title: dialog.querySelector('h2').id, icon: !!dialog.querySelector('[data-close] svg'), height: dialog.querySelector('[type="submit"]').getBoundingClientRect().height, font: getComputedStyle(dialog.querySelector('.pui-field-label')).fontSize }));
  await page.locator('#sdk-dialog').screenshot({ path: `output/playwright/final-resource-${testInfo.project.name}.png` });
  expect(resource).toEqual({ label: 'sdk-title', title: 'sdk-title', icon: true, height: 40, font: '13px' });
  await page.locator('#sdk-dialog [data-close]').first().click();
  await page.locator('#resources-dialog [data-close]').click();
  await page.locator('#sidebar [data-action="settings"]').click();
  await expect(page.locator('#save-settings')).toBeEnabled();
  await page.locator('#settings-dialog').screenshot({ path: `output/playwright/final-settings-${testInfo.project.name}.png` });
  expect(await page.locator('#settings-dialog').evaluate(dialog => ({ label: dialog.getAttribute('aria-labelledby'), title: dialog.querySelector('h2').id, icon: !!dialog.querySelector('[data-close] svg'), height: dialog.querySelector('#save-settings').getBoundingClientRect().height, font: getComputedStyle(dialog.querySelector('.pui-field-label')).fontSize }))).toEqual({ label: 'settings-title', title: 'settings-title', icon: true, height: 40, font: '13px' });
});

test('connection probes keep Save disabled across stream snapshots', async ({ page }) => {
  await page.locator('#sidebar [data-action="settings"]').click();
  await expect(page.locator('#test-connection')).toBeEnabled();
  await page.evaluate(() => { window.review.holdProbe = true; });
  await page.locator('#provider-advanced summary').click();
  await page.locator('#base-url').fill('http://localhost/v1');
  await page.locator('#test-connection').click();
  await expect(page.locator('#test-connection')).toHaveText('Cancel test');
  await page.evaluate(() => { window.reviewState.runtime.contextTokens++; window.emitReview(); });
  await expect(page.locator('#save-settings')).toBeDisabled();
  await page.evaluate(() => window.releaseProbe());
  await expect(page.locator('#save-settings')).toBeEnabled();
});

test('provider action errors stay with the provider form rather than Appearance', async ({ page }) => {
  await page.evaluate(() => { window.review.models.providers[0].oauth = true; window.review.models.providers[0].apiKeySupported = true; window.review.failMutation = '/api/oauth/start'; });
  await page.locator('#sidebar [data-action="settings"]').click();
  await page.locator('[data-sdk="login"]').click();
  await expect(page.locator('#settings-error')).toHaveText('Fixture action rejected');
  await expect(page.locator('#appearance-error')).toHaveText('');
});

test('MCP and model connection removal share cancel-first confirmation', async ({ page }) => {
  await page.locator('[data-action="connections"]').click();
  await page.locator('[data-mcp-remove]').click();
  await expect(page.locator('#cancel-delete')).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/mcp/remove').length)).toBe(0);
  await page.locator('[data-mcp-remove]').click();
  await page.locator('#delete-form [type="submit"]').click();
  await expect(page.locator('#delete-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/mcp/remove').length)).toBe(1);
  await page.locator('#connections-dialog [data-close]').first().click();
  await page.locator('#sidebar [data-action="settings"]').click();
  await page.locator('[data-sdk="remove-connection"]').click();
  await expect(page.locator('#delete-title')).toHaveText('Remove model connection?');
  await page.locator('#cancel-delete').click();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/remove-model-connection').length)).toBe(0);
});

test('resource removal confirms its file and reports errors in the active dialog', async ({ page }) => {
  await page.evaluate(() => { window.review.resources = { instructions: [{ name: 'AGENTS.md', path: '/tmp/pith-review/AGENTS.md', content: '# Instructions' }], skills: [], templates: [] }; window.review.failMutation = '/api/resource'; });
  await page.locator('[data-action="resources"]').click();
  await page.locator('[data-sdk="resource"][data-path]').click();
  await page.locator('#delete-resource').click();
  await expect(page.locator('#delete-dialog')).toContainText('/tmp/pith-review/AGENTS.md');
  await page.locator('#delete-form [type="submit"]').click();
  await expect(page.locator('#delete-error')).toHaveText('Fixture action rejected');
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/resource' && r.body.remove).length)).toBe(1);
});

test('search marks and tool folds preserve historical reading nodes while streaming', async ({ page }) => {
  await page.keyboard.press('Meta+f');
  await page.locator('#conversation-find input').fill('Stable');
  const selected = await page.evaluate(() => {
    const text = document.querySelector('.pui-user-text'), range = document.createRange();
    range.selectNodeContents(text); getSelection().removeAllRanges(); getSelection().addRange(range);
    window.reviewState.messages.at(-1).text += ' updated'; window.emitReview();
    return getSelection().toString();
  });
  expect(selected).toBe('Stable historical text to select');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.reviewState.messages.splice(1, 0, { id: 'tool-a', role: 'tool', toolCallId: 'call-a', toolName: 'read_file', text: 'Completed tool', status: 'done' }); window.emitReview(); });
  await page.locator('.pui-tool-group > summary').click();
  await page.locator('.pui-tool-message > summary').click();
  await page.evaluate(() => { window.reviewState.messages.splice(2, 0, { id: 'tool-b', role: 'tool', toolCallId: 'call-b', toolName: 'read_file', text: 'New tool', status: 'running' }); window.emitReview(); });
  expect(await page.locator('.pui-tool-group').evaluate(node => node.open)).toBe(true);
  expect(await page.locator('[data-reading-id="tool-a"]').evaluate(node => node.open)).toBe(true);
});

test('first image send preserves its draft and target when creation refresh fails and send is rejected', async ({ page }) => {
  await page.evaluate(() => { window.reviewState.activeId = ''; window.reviewState.messages = []; window.emitReview(); window.review.failMutation = '/api/send'; });
  await expect(page.locator('#composer-input')).toBeEditable();
  await page.locator('#composer-input').fill('Keep the first image draft');
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'first.png', { type: 'image/png' }));
    const picker = document.querySelector('#image-picker'); picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await page.locator('#send-button').click();
  await expect(page.locator('#inline-error')).toContainText('Fixture action rejected');
  await page.evaluate(() => window.emitReview());
  await expect(page.locator('#composer-input')).toHaveValue('Keep the first image draft');
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/conversations').length)).toBe(1);
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/send').body.id)).toBe('created-2');
});
