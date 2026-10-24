import { test, expect } from '@playwright/test';
import { installFixture } from './fixture.mjs';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await page.waitForFunction(() => window.reviewSocket?.onmessage && !document.querySelector('textarea[aria-label="Message Pith"]').readOnly);
});

test('stream updates preserve historical selection, code scroll and focus', async ({ page }) => {
  const result = await page.evaluate(() => {
    const range = document.createRange(), selection = getSelection();
    range.selectNodeContents(document.querySelector('[data-user-text]')!);
    selection!.removeAllRanges(); selection!.addRange(range);
    const pre = document.querySelector('.code-block pre') as HTMLElement; pre.scrollLeft = 100;
    const historical = document.querySelector('[data-reading-id="old-answer"]');
    (window as any).reviewState.messages.at(-1).text += ' updated'; (window as any).emitReview();
    return { selected: selection!.toString(), scroll: pre.scrollLeft, sameNode: historical === document.querySelector('[data-reading-id="old-answer"]') };
  });
  expect(result).toEqual({ selected: 'Stable historical text to select', scroll: 100, sameNode: true });
  await page.locator('[data-reading-id="old-answer"] button[aria-label="Copy response"]').focus();
  await page.evaluate(() => { (window as any).reviewState.messages.at(-1).text += ' again'; (window as any).emitReview(); });
  await expect(page.locator('[data-reading-id="old-answer"] button[aria-label="Copy response"]')).toBeFocused();
});

test('text and image drafts restore together after switching and reload', async ({ page }) => {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const transfer = new DataTransfer(); transfer.items.add(new File([png], 'draft-image.png', { type: 'image/png' }));
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement; picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('[data-draft-image]')).toHaveCount(1);
  const composer = page.getByRole('textbox', {name: 'Message Pith'});
  await composer.fill('Keep this draft');
  await page.locator('button[title="Conversation b"]').click();
  await expect(page.locator('[data-draft-image]')).toHaveCount(0);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toHaveValue('');
  await page.locator('button[title="Conversation a"]').click();
  await expect(page.locator('[data-draft-image]')).toHaveCount(1);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toHaveValue('Keep this draft');
  // Host storage lives outside a browser origin; seed it into a fresh frontend.
  await page.getByRole('textbox', {name: 'Message Pith'}).blur();
  await expect.poll(() => page.evaluate(() => (window as any).review.drafts.a?.images?.length)).toBe(1);
  const saved = await page.evaluate(() => (window as any).review.drafts.a);
  await page.addInitScript(draft => { (window as any).review.drafts.a = draft; }, saved);
  await page.reload();
  await expect(page.locator('[data-draft-image]')).toHaveCount(1);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toHaveValue('Keep this draft');
});

test('file drops on the message field and its frame add each image and reference once', async ({page}) => {
  await page.evaluate(() => {
    const original = window.fetch;
    (window as any).dropRequests = [];
    window.fetch = async (url, options) => {
      if (new URL(String(url), location.href).pathname === '/api/workspace-references') {
        (window as any).dropRequests.push(JSON.parse(String(options?.body)));
        return Response.json({paths: ['report.txt']});
      }
      return original(url, options);
    };
  });
  const composer = page.getByRole('textbox', {name: 'Message Pith', exact: true});
  for (const [index, target] of ['field', 'frame'].entries()) {
    await composer.fill('Before after');
    const prevented = await composer.evaluate((node: HTMLTextAreaElement, target: string) => {
      node.setSelectionRange(7, 7);
      const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
      const png = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([png], `drop-${target}.png`, {type: 'image/png'}));
      transfer.setData('text/uri-list', 'file:///tmp/pith-review/report.txt');
      const receiver = target === 'field' ? node : node.closest('form')!;
      receiver.dispatchEvent(new DragEvent('dragover', {dataTransfer: transfer, bubbles: true, cancelable: true}));
      const event = new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true});
      receiver.dispatchEvent(event);
      return event.defaultPrevented;
    }, target);
    expect(prevented).toBe(true);
    await expect(composer).toHaveValue('Before `report.txt` after');
    await expect(page.locator('[data-draft-image]')).toHaveCount(index + 1);
    expect(await page.evaluate(() => (window as any).dropRequests)).toHaveLength(index + 1);
  }
});

test('a collapsed Files folder stays closed when its pending read succeeds or fails', async ({page}) => {
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (url, options) => {
      const target = new URL(String(url), location.href);
      if (target.pathname !== '/api/workspace-files') return original(url, options);
      if (!target.searchParams.get('path')) return Response.json({entries: [{name: 'docs', path: 'docs', directory: true}]});
      await new Promise<void>(resolve => {(window as any).releaseFolder = resolve;});
      return (window as any).failFolder
        ? Response.json({error: 'Directory is temporarily unavailable'}, {status: 503})
        : Response.json({entries: [{name: 'child.txt', path: 'docs/child.txt', directory: false}]});
    };
  });
  await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
  await page.getByRole('button', {name: 'Open files', exact: true}).click();
  const folder = page.getByRole('button', {name: 'docs', exact: true});
  for (const fail of [false, true]) {
    await page.evaluate(fail => {(window as any).failFolder = fail; (window as any).releaseFolder = undefined;}, fail);
    await folder.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).releaseFolder)).toBe('function');
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(async () => {
      (window as any).releaseFolder();
      // Let the fulfilled read and React render settle before checking that it stayed closed.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', {name: 'child.txt', exact: true})).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pith-desk.tools.v1.w')!).tabs[0].files.expanded)).toEqual([]);
  }
});

test('stream snapshots cannot enable a model menu still loading', async ({ page }) => {
  await page.evaluate(() => { (window as any).review.holdModels = true; });
  await page.getByRole('button', {name: 'Choose model'}).click();
  await page.getByRole('menuitem', {name: /^Model/}).click();
  const loading = page.getByText('Loading models…', {exact: true});
  await expect(loading).toBeVisible();
  await page.evaluate(() => { (window as any).reviewState.runtime.contextTokens++; (window as any).emitReview(); });
  await expect(loading).toBeVisible();
  await page.evaluate(() => (window as any).releaseModels());
  await expect(loading).toHaveCount(0);
  await expect(page.getByRole('menuitem', {name: /Fixture/, exact: false})).toBeVisible();
});

test('a committed create operation reports refresh trouble without a retry', async ({ page }) => {
  await page.getByRole('button', {name: 'New conversation in Review workspace'}).click();
  await expect(page.getByRole('alert')).toContainText('Change saved.');
  expect(await page.evaluate(() => (window as any).reviewState.conversations.filter((c: any) => c.id.startsWith('created-')).length)).toBe(1);
  await page.evaluate(() => (window as any).emitReview());
  await expect(page.locator('header')).toContainText('New conversation');
});

test('resource edits keep the dialog workspace after a notification switches conversations', async ({ page }) => {
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.reviewState.activeId = 'b';
    fixture.reviewState.conversations.find((c: any) => c.id === 'b').workspaceId = 'other';
    fixture.emitReview();
  });
  await page.getByRole('dialog', {name: 'Workspace resources', exact: true}).getByRole('button', { name: 'Add skill', exact: true }).click();
  await expect(page.locator('[data-workspace-path]')).toHaveText('/tmp/pith-review');
  expect(await page.evaluate(() => (window as any).reviewState.activeId)).toBe('b');
  await page.getByRole('textbox', {name: 'Name', exact: true}).fill('fixture-skill');
  await page.getByRole('dialog', {name: 'Create skill', exact: true}).getByRole('button', {name: 'Save resource', exact: true}).click();
  expect(await page.evaluate(() => (window as any).review.requests.find((r: any) => r.path === '/api/resource').body.workspaceId)).toBe('w');
});

test('dialogs share accessible headings and close controls', async ({ page }) => {
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await page.getByRole('dialog', {name: 'Workspace resources', exact: true}).getByRole('button', { name: 'Add skill', exact: true }).click();
  const resource = await page.getByRole('dialog', {name: 'Create skill'}).evaluate(dialog => ({
    label: dialog.getAttribute('aria-labelledby'),
    title: dialog.querySelector('h2')?.id,
    close: !!dialog.querySelector('button[aria-label="Close"], [data-slot="dialog-close"]'),
    formControls: dialog.querySelectorAll('input, textarea').length,
  }));
  expect(resource.close).toBe(true);
  expect(resource.formControls).toBeGreaterThanOrEqual(2);
  expect(resource.label).toBe(resource.title);
  expect(resource.title).toBeTruthy();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
  const settingsHeading = await settings.evaluate(dialog => ({
    label: dialog.getAttribute('aria-labelledby'),
    title: dialog.querySelector('h2')?.id,
    close: !!dialog.querySelector('button[aria-label="Close"], [data-slot="dialog-close"]'),
  }));
  expect(settingsHeading.close).toBe(true);
  expect(settingsHeading.label).toBe(settingsHeading.title);
  expect(settingsHeading.title).toBeTruthy();
});

test('connection probes keep Save disabled across stream snapshots', async ({ page }) => {
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await expect(settings.getByRole('button', {name: 'Test connection', exact: true})).toBeEnabled();
  await page.evaluate(() => { (window as any).review.holdProbe = true; });
  await settings.getByText('Advanced connection settings').click();
  await settings.getByLabel('API base URL').fill('http://localhost/v1');
  await settings.getByRole('button', {name: 'Test connection', exact: true}).click();
  const cancel = settings.getByRole('button', {name: 'Cancel test', exact: true});
  await expect(cancel).toBeVisible();
  await page.evaluate(() => { (window as any).reviewState.runtime.contextTokens++; (window as any).emitReview(); });
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeDisabled();
  await page.evaluate(() => (window as any).releaseProbe());
  await expect(cancel).toHaveCount(0);
  await expect(settings.getByRole('button', {name: 'Save settings', exact: true})).toBeEnabled();
});

test('provider action errors stay with the provider form rather than Appearance', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.review.models.providers[0].oauth = true;
    fixture.review.models.providers[0].apiKeySupported = true;
    fixture.review.failMutation = '/api/oauth/start';
  });
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await settings.getByRole('button', {name: /Sign in with/}).click();
  await expect(settings.getByRole('alert')).toHaveText('Fixture action rejected');
  await expect(settings.getByRole('alert')).toHaveCount(1);
});

test('MCP and model connection removal share cancel-first confirmation', async ({ page }) => {
  await page.getByRole('button', {name: 'Connections', exact: true}).click();
  const connections = page.getByRole('dialog', {name: 'Connections', exact: true});
  await connections.getByRole('button', {name: 'fixture-tools options'}).click();
  await page.getByRole('menuitem', {name: 'Delete…'}).click();
  const confirm = page.getByRole('dialog', {name: 'Delete connection?'});
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).review.requests.filter((r: any) => r.path === '/api/mcp/remove').length)).toBe(0);
  await connections.getByRole('button', {name: 'fixture-tools options'}).click();
  await page.getByRole('menuitem', {name: 'Delete…'}).click();
  await confirm.getByRole('button', {name: 'Delete connection', exact: true}).click();
  await expect(confirm).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).review.requests.filter((r: any) => r.path === '/api/mcp/remove').length)).toBe(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.getByRole('dialog', {name: 'Settings', exact: true});
  await settings.getByRole('button', {name: 'Remove connection…', exact: true}).click();
  const modelConfirm = page.getByRole('dialog', {name: 'Remove model connection?'});
  await expect(modelConfirm).toBeVisible();
  await modelConfirm.getByRole('button', {name: 'Cancel', exact: true}).click();
  expect(await page.evaluate(() => (window as any).review.requests.filter((r: any) => r.path === '/api/remove-model-connection').length)).toBe(0);
});

test('resource removal confirms its file and reports errors in the active dialog', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.review.resources = {instructions: [{name: 'AGENTS.md', path: '/tmp/pith-review/AGENTS.md', content: '# Instructions'}], skills: [], templates: []};
    fixture.review.failMutation = '/api/resource';
  });
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  const resources = page.getByRole('dialog', {name: 'Workspace resources', exact: true});
  await resources.getByRole('button', {name: 'Edit', exact: true}).click();
  await page.getByRole('dialog', {name: 'Edit resource'}).getByRole('button', {name: 'Delete', exact: true}).click();
  const confirm = page.getByRole('dialog', {name: 'Delete resource?'});
  await expect(confirm).toContainText('/tmp/pith-review/AGENTS.md');
  await confirm.getByRole('button', {name: 'Delete resource', exact: true}).click();
  await expect(confirm.getByRole('alert')).toHaveText('Fixture action rejected');
  expect(await page.evaluate(() => (window as any).review.requests.filter((r: any) => r.path === '/api/resource' && r.body.remove).length)).toBe(1);
});

test('search highlights and tool folds preserve historical reading nodes while streaming', async ({ page }) => {
  await page.keyboard.press('Meta+f');
  const find = page.getByRole('textbox', {name: 'Find in conversation'});
  await find.fill('Stable');
  await expect(page.getByText('1 match')).toBeVisible();
  const selected = await page.evaluate(() => {
    const text = document.querySelector('[data-user-text]'), range = document.createRange();
    range.selectNodeContents(text!); getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    (window as any).reviewState.messages.at(-1).text += ' updated'; (window as any).emitReview();
    return getSelection()!.toString();
  });
  expect(selected).toBe('Stable historical text to select');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.reviewState.messages.splice(1, 0, { id: 'tool-a', role: 'tool', toolCallId: 'call-a', toolName: 'read_file', text: 'Completed tool', status: 'done' });
    fixture.emitReview();
  });
  const group = page.locator('[data-tool-group]');
  const groupSummary = group.locator('[data-tool-group-summary]');
  await groupSummary.click();
  await expect(groupSummary).toHaveAttribute('aria-expanded', 'true');
  const card = page.locator('[data-reading-id="tool-a"]');
  const cardSummary = card.locator('[data-tool-card-summary]');
  await cardSummary.click();
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.reviewState.messages.splice(2, 0, { id: 'tool-b', role: 'tool', toolCallId: 'call-b', toolName: 'read_file', text: 'New tool', status: 'running' });
    fixture.emitReview();
  });
  await expect(groupSummary).toHaveAttribute('aria-expanded', 'true');
  await expect(cardSummary).toHaveAttribute('aria-expanded', 'true');
});

test('first image send preserves its draft and target when creation refresh fails and send is rejected', async ({ page }) => {
  await page.evaluate(() => {
    const fixture = (window as any);
    fixture.reviewState.activeId = ''; fixture.reviewState.messages = []; fixture.emitReview();
    fixture.review.failMutation = '/api/send';
  });
  const composer = page.getByRole('textbox', {name: 'Message Pith'});
  await expect(composer).toBeEditable();
  await composer.fill('Keep the first image draft');
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 10;
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([bytes], 'first.png', { type: 'image/png' }));
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement; picker.files = files.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('[data-draft-image]')).toHaveCount(1);
  await page.getByRole('button', {name: 'Send message'}).click();
  await expect(page.getByRole('alert')).toContainText('Fixture action rejected');
  await page.evaluate(() => (window as any).emitReview());
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toHaveValue('Keep the first image draft');
  await expect(page.locator('[data-draft-image]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).review.requests.filter((r: any) => r.path === '/api/conversations').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).review.requests.find((r: any) => r.path === '/api/send').body.id)).toBe('created-2');
});
