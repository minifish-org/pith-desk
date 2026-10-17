import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('.pui-composer textarea[aria-label="Message Pith"]').readOnly);
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
  await page.locator('[data-reading-id="old-answer"] button[aria-label="Copy response"]').focus();
  await page.evaluate(() => { window.reviewState.messages.at(-1).text += ' again'; window.emitReview(); });
  await expect(page.locator('[data-reading-id="old-answer"] button[aria-label="Copy response"]')).toBeFocused();
});

test('text and image drafts restore together after switching and reload', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([png], 'draft-image.png', { type: 'image/png' }));
    const picker = document.querySelector('.pui-composer input[type="file"]'); picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await page.locator('.pui-composer textarea[aria-label="Message Pith"]').fill('Keep this draft');
  await page.locator('.pui-history-item[title="Conversation b"]').click();
  await expect(page.locator('.pui-draft-image')).toHaveCount(0);
  await expect(page.locator('.pui-composer textarea[aria-label="Message Pith"]')).toHaveValue('');
  await page.locator('.pui-history-item[title="Conversation a"]').click();
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await expect(page.locator('.pui-composer textarea[aria-label="Message Pith"]')).toHaveValue('Keep this draft');
  // Host storage lives outside a browser origin; seed it into a fresh frontend.
  await page.locator('.pui-composer textarea[aria-label="Message Pith"]').blur();
  await expect.poll(() => page.evaluate(() => window.review.drafts.a?.images?.length)).toBe(1);
  const saved = await page.evaluate(() => window.review.drafts.a);
  await page.addInitScript((draft) => { window.review.drafts.a = draft; }, saved);
  await page.reload();
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await expect(page.locator('.pui-composer textarea[aria-label="Message Pith"]')).toHaveValue('Keep this draft');
});

test('stream snapshots cannot enable a model picker still loading', async ({ page }) => {
  await page.evaluate(() => { window.review.holdModels = true; });
  await page.locator('.pui-composer-model').click();
  await expect(page.locator('dialog[open] button[type="submit"]')).toBeDisabled();
  await page.evaluate(() => { window.reviewState.runtime.contextTokens++; window.emitReview(); });
  await expect(page.locator('dialog[open] button[type="submit"]')).toBeDisabled();
  await page.evaluate(() => window.releaseModels());
  await expect(page.locator('dialog[open] button[type="submit"]')).toBeEnabled();
});

test('a committed create operation reports refresh trouble without a retry', async ({ page }) => {
  await page.locator('button[aria-label="New conversation in Review workspace"]').click();
  await expect(page.locator('.pui-inline-error')).toContainText('Change saved.');
  expect(await page.evaluate(() => window.reviewState.conversations.filter(c => c.id.startsWith('created-')).length)).toBe(1);
  await page.evaluate(() => window.emitReview());
  await expect(page.locator('.pui-breadcrumb-current')).toHaveText('New conversation');
});

test('resource edits keep the dialog workspace after a notification switches conversations', async ({ page }) => {
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.evaluate(() => { window.reviewState.activeId = 'b'; window.reviewState.conversations.find(c => c.id === 'b').workspaceId = 'other'; window.emitReview(); });
  await page.getByRole('dialog', {name: 'Workspace resources', exact: true}).getByRole('button', { name: 'Add skill', exact: true }).click();
  await expect(page.locator('dialog[open]:has(form textarea[aria-label="Markdown"]) .pui-file-path')).toHaveText('/tmp/pith-review');
  expect(await page.evaluate(() => window.reviewState.activeId)).toBe('b');
  await page.getByRole('textbox', {name: 'Name', exact: true}).fill('fixture-skill');
  await page.getByRole('dialog', {name: 'Create skill', exact: true}).getByRole('button', {name: 'Save', exact: true}).click();
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/resource').body.workspaceId)).toBe('w');
});

test('dialogs share accessible headings, close icons and form control sizes', async ({ page }, testInfo) => {
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.getByRole('dialog', {name: 'Workspace resources', exact: true}).getByRole('button', { name: 'Add skill', exact: true }).click();
  const resource = await page.locator('dialog[open]:has(form textarea[aria-label="Markdown"])').evaluate(dialog => ({ label: dialog.getAttribute('aria-labelledby'), title: dialog.querySelector('h2').id, icon: !!dialog.querySelector('[data-close] svg'), height: dialog.querySelector('[type="submit"]').getBoundingClientRect().height, font: getComputedStyle(dialog.querySelector('.pui-field-label')).fontSize }));
  await page.locator('dialog[open]:has(form textarea[aria-label="Markdown"])').screenshot({ path: `output/playwright/final-resource-${testInfo.project.name}.png` });
  expect(resource).toMatchObject({ icon: true, height: 40, font: '14px' });
  expect(resource.label).toBe(resource.title); expect(resource.title).toMatch(/^pui-dialog-title-\d+$/);
  await page.locator('dialog[open]:has(form textarea[aria-label="Markdown"]) [data-close]').first().click();
  await page.locator('dialog[open]:has(.pui-feature-toolbar[aria-label="Resource actions"]) [data-close]').click();
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await expect(page.locator('.pui-form-layout button[type="submit"]')).toBeEnabled();
  await page.locator('dialog[open]:has(.pui-form-layout)').screenshot({ path: `output/playwright/final-settings-${testInfo.project.name}.png` });
  const settingsHeading = await page.locator('dialog[open]:has(.pui-form-layout)').evaluate(dialog => ({ label: dialog.getAttribute('aria-labelledby'), title: dialog.querySelector('h2').id, icon: !!dialog.querySelector('[data-close] svg'), height: dialog.querySelector('.pui-form-layout button[type="submit"]').getBoundingClientRect().height, font: getComputedStyle(dialog.querySelector('.pui-field-label')).fontSize }));
  expect(settingsHeading).toMatchObject({ icon: true, height: 40, font: '14px' });
  expect(settingsHeading.label).toBe(settingsHeading.title); expect(settingsHeading.title).toMatch(/^pui-dialog-title-\d+$/);
});

test('connection probes keep Save disabled across stream snapshots', async ({ page }) => {
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await expect(page.getByRole('button', {name: /^(Test connection|Cancel test)$/})).toBeEnabled();
  await page.evaluate(() => { window.review.holdProbe = true; });
  await page.locator('.pui-provider-advanced summary').click();
  await page.locator('input[name="baseUrl"]').fill('http://localhost/v1');
  await page.getByRole('button', {name: /^(Test connection|Cancel test)$/}).click();
  await expect(page.getByRole('button', {name: /^(Test connection|Cancel test)$/})).toHaveText('Cancel test');
  await page.evaluate(() => { window.reviewState.runtime.contextTokens++; window.emitReview(); });
  await expect(page.locator('.pui-form-layout button[type="submit"]')).toBeDisabled();
  await page.evaluate(() => window.releaseProbe());
  await expect(page.locator('.pui-form-layout button[type="submit"]')).toBeEnabled();
});

test('provider action errors stay with the provider form rather than Appearance', async ({ page }) => {
  await page.evaluate(() => { window.review.models.providers[0].oauth = true; window.review.models.providers[0].apiKeySupported = true; window.review.failMutation = '/api/oauth/start'; });
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await page.locator('button:text-is("Sign in with provider")').click();
  await expect(page.locator('.pui-form-layout > form > .pui-form-error')).toHaveText('Fixture action rejected');
  await expect(page.locator('.pui-form-layout > section:first-child .pui-form-error')).toHaveText('');
});

test('MCP and model connection removal share cancel-first confirmation', async ({ page }) => {
  await page.getByRole('button', {name: 'Connections', exact: true}).click();
  await page.locator('.pui-connection-card button:text-is("Delete")').click();
  await expect(page.locator('.pui-confirm button[type=button]')).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/mcp/remove').length)).toBe(0);
  await page.locator('.pui-connection-card button:text-is("Delete")').click();
  await page.locator('.pui-confirm [type="submit"]').click();
  await expect(page.locator('dialog:has(.pui-confirm)')).not.toBeVisible();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/mcp/remove').length)).toBe(1);
  await page.getByRole('button', {name: 'Close connections', exact: true}).click();
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  await page.locator('button:text-is("Remove connection")').click();
  await expect(page.locator('dialog:has(.pui-confirm) h2')).toHaveText('Remove model connection?');
  await page.locator('.pui-confirm button[type=button]').click();
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/remove-model-connection').length)).toBe(0);
});

test('resource removal confirms its file and reports errors in the active dialog', async ({ page }) => {
  await page.evaluate(() => { window.review.resources = { instructions: [{ name: 'AGENTS.md', path: '/tmp/pith-review/AGENTS.md', content: '# Instructions' }], skills: [], templates: [] }; window.review.failMutation = '/api/resource'; });
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.locator('.pui-resource-card button:text-is("View / edit")').click();
  await page.locator('dialog[open] button:text-is("Delete resource")').click();
  await expect(page.locator('dialog:has(.pui-confirm)')).toContainText('/tmp/pith-review/AGENTS.md');
  await page.locator('.pui-confirm [type="submit"]').click();
  await expect(page.locator('.pui-confirm .pui-notice')).toHaveText('Fixture action rejected');
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/resource' && r.body.remove).length)).toBe(1);
});

test('search marks and tool folds preserve historical reading nodes while streaming', async ({ page }) => {
  await page.keyboard.press('Meta+f');
  await page.locator('.pui-conversation-find input').fill('Stable');
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
  await expect(page.locator('.pui-composer textarea[aria-label="Message Pith"]')).toBeEditable();
  await page.locator('.pui-composer textarea[aria-label="Message Pith"]').fill('Keep the first image draft');
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'first.png', { type: 'image/png' }));
    const picker = document.querySelector('.pui-composer input[type="file"]'); picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  await page.locator('.pui-send-button').click();
  await expect(page.locator('.pui-inline-error')).toContainText('Fixture action rejected');
  await page.evaluate(() => window.emitReview());
  await expect(page.locator('.pui-composer textarea[aria-label="Message Pith"]')).toHaveValue('Keep the first image draft');
  await expect(page.locator('.pui-draft-image')).toHaveCount(1);
  expect(await page.evaluate(() => window.review.requests.filter(r => r.path === '/api/conversations').length)).toBe(1);
  expect(await page.evaluate(() => window.review.requests.find(r => r.path === '/api/send').body.id)).toBe('created-2');
});
