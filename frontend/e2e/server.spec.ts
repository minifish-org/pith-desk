import {expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

test.use({serverAutoLogin: false});
test.setTimeout(60000);

async function login(page, host) {
  await page.goto(host.url);
  await page.getByRole('textbox', {name: 'Server token', exact: true}).fill(host.token);
  await Promise.all([page.waitForEvent('load'),page.getByRole('button', {name: 'Sign in', exact: true}).click()]);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}

test('Server token login, refresh and takeover revoke the old page immediately', async ({page, context, host}) => {
  let hmrConnected = false;
  page.on('websocket',socket => {
    if (new URL(socket.url()).pathname === '/__desk_hmr') socket.on('framereceived',frame => {
      if (String(frame.payload).includes('"type":"connected"')) hmrConnected = true;
    });
  });
  await page.goto(host.url);
  await page.getByRole('textbox', {name: 'Server token', exact: true}).fill('invalid-token');
  await page.getByRole('button', {name: 'Sign in', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('Invalid server token');
  await page.getByRole('textbox', {name: 'Server token', exact: true}).fill(host.token);
  await Promise.all([page.waitForEvent('load'),page.getByRole('button', {name: 'Sign in', exact: true}).click()]);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(() => hmrConnected).toBe(true);
  const logout = page.getByRole('button', {name: 'Log out', exact: true});
  await expect(logout).toHaveText('Log out');
  await expect(logout.locator('svg')).toBeVisible();
  await expect(logout).toHaveAttribute('title', 'Log out');
  const oldLease = await page.evaluate(() => sessionStorage.getItem('pith-desk-server-lease'));
  const cookies = await context.cookies();
  expect(cookies.find(cookie => cookie.name === 'pith_desk_session')).toMatchObject({httpOnly: true, sameSite: 'Strict'});
  await page.reload();
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const renewed = await page.evaluate(() => sessionStorage.getItem('pith-desk-server-lease'));
  expect(renewed).not.toBe(oldLease);
  expect((await context.request.get(host.url + '/api/state', {headers: {'X-Desk-Lease': oldLease!}})).status()).toBe(409);

  const second = await context.newPage();
  await second.goto(host.url);
  const access = second.getByRole('dialog');
  await expect(access).toContainText('Other pages will disconnect');
  await expect(access.getByRole('button',{name: 'Take over',exact: true})).toHaveCount(0);
  await expect(access.getByRole('button',{name: 'Reconnect',exact: true})).toHaveCount(0);
  await expect(access.getByRole('button',{name: 'Continue here',exact: true})).toBeEnabled();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await access.getByRole('button', {name: 'Continue here', exact: true}).click();
  await expect(second.getByRole('dialog')).not.toBeVisible();
  await expect(second.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await expect(page.getByRole('dialog')).toContainText('Other pages will disconnect');
  expect((await context.request.post(host.url + '/api/conversations', {
    data: {workspaceId: host.state.workspaces[0].id}, headers: {'X-Desk-Lease': renewed!, 'X-Desk-Request': '100'},
  })).status()).toBe(409);
  await second.getByRole('textbox', {name: 'Message Pith'}).fill('Draft kept after logging out');
  await second.getByRole('button', {name: 'Log out', exact: true}).click();
  await expect(second.getByRole('textbox', {name: 'Server token', exact: true})).toBeVisible();
  expect((await context.request.get(host.url + '/api/state', {headers: {'X-Desk-Lease': renewed!}})).status()).toBe(401);
  await second.getByRole('textbox', {name: 'Server token', exact: true}).fill(host.token);
  await Promise.all([second.waitForEvent('load'),second.getByRole('button', {name: 'Sign in', exact: true}).click()]);
  await expect(second.getByRole('textbox', {name: 'Message Pith'})).toHaveValue('Draft kept after logging out');
});

test('Server workspace entry uses server paths and omits the native folder picker',async ({page,host}) => {
  await page.addInitScript(() => {Object.defineProperty(navigator,'clipboard',{configurable: true,value: {async writeText(text: string) {(window as unknown as {copiedServerPath: string}).copiedServerPath = text;}}});});
  await login(page,host);
  const folder = host.state.workspaces[0].path + '/Server folder 中文';
  await mkdir(folder);
  await writeFile(folder + '/AGENTS.md','# Isolated Server resources');
  await writeFile(host.state.workspaces[0].path + '/AGENTS.md','# Isolated Server resources');
  await page.getByRole('button',{name: 'Manage workspaces',exact: true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('on the server');
  await expect(dialog.getByRole('button',{name: 'Choose a folder…'})).toHaveCount(0);
  await dialog.getByRole('textbox',{name: 'Server folder path',exact: true}).fill(folder);
  await dialog.getByRole('button',{name: 'Add workspace',exact: true}).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await host.command('state')).state.workspaces.some(workspace => workspace.path === folder)).toBe(true);
  await expect(page.getByRole('button',{name: 'Server folder 中文',exact: true})).toBeVisible();
  await expect(page.locator('header')).toContainText('Server folder 中文');
  await page.getByRole('button',{name: 'Workspace resources',exact: true}).click();
  const resources = page.getByRole('dialog',{name: 'Workspace resources',exact: true});
  await expect(resources).toContainText('AGENTS.md');
  await expect(resources.getByRole('button',{name: 'Reveal',exact: true})).toHaveCount(0);
  const workspaceInstructions = resources.locator('[data-resource-path]').filter({hasText: folder + '/AGENTS.md'});
  await expect(workspaceInstructions.getByRole('button',{name: 'Copy server path',exact: true})).toBeVisible();
  await workspaceInstructions.getByRole('button',{name: 'Copy server path',exact: true}).click();
  expect(await page.evaluate(() => (window as unknown as {copiedServerPath: string}).copiedServerPath)).toBe(folder + '/AGENTS.md');
});

test('closing and reopening a browser page preserves an actual running task without resubmission', async ({page, context, host}) => {
  await login(page, host);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await host.command('hold-provider', {enabled: true});
  await page.getByRole('textbox', {name: 'Message Pith'}).fill('Finish while the browser is closed');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect.poll(async () => (await host.command('stats')).requests).toBe(1);
  await page.close();
  const disconnected = await host.command('state');
  expect(disconnected.state.running).toBe(true);
  expect(disconnected.canceled).toBe(0);
  const reopened = await context.newPage();
  await reopened.goto(host.url);
  await reopened.getByRole('button', {name: 'Continue here', exact: true}).click();
  await expect(reopened.getByRole('button', {name: 'Stop agent', exact: true})).toBeVisible();
  await host.command('hold-provider', {enabled: false});
  await expect(reopened.locator('[data-conversation-scroll]')).toContainText('Fixture answer');
  const finished = await host.command('state');
  expect(finished.requests).toBe(1);
  expect(finished.canceled).toBe(0);
  expect(finished.state.messages.filter(message => message.role === 'user')).toHaveLength(1);
});

test('pending tool approval survives takeover, rejects the old lease, and exports the result', async ({page, context, host}) => {
  await login(page, host);
  await expect(page.getByRole('textbox', {name: 'Message Pith'})).toBeEditable();
  await host.command('write-tool', {enabled: true});
  await page.getByRole('textbox', {name: 'Message Pith'}).fill('Write a file after approval');
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  await expect.poll(async () => !!(await host.command('state')).state.pendingApproval).toBe(true);
  const pending = (await host.command('state')).state.pendingApproval;
  const oldLease = await page.evaluate(() => sessionStorage.getItem('pith-desk-server-lease'));
  const second = await context.newPage();
  await second.goto(host.url);
  await second.getByRole('button', {name: 'Continue here', exact: true}).click();
  await expect(second.getByRole('button', {name: 'Allow this action', exact: true})).toBeVisible();
  expect((await context.request.post(host.url + '/api/approval', {
    data: {id: pending.id, allow: true}, headers: {'X-Desk-Lease': oldLease!, 'X-Desk-Request': '100'},
  })).status()).toBe(409);
  expect((await host.command('state')).state.pendingApproval.id).toBe(pending.id);
  await second.getByRole('button', {name: 'Allow this action', exact: true}).click();
  await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
  await expect(second.locator('[data-conversation-scroll]')).toContainText('Fixture answer');
  const edited = second.locator('[data-edited-files]');
  await expect(edited.locator('[data-edited-files-title]')).toHaveText('Edited 1 file');
  await expect(edited.locator('[data-edited-file]')).toHaveCount(1);
  await expect(edited.locator('[data-edit-totals]')).toHaveText('+1');
  await edited.locator('[data-edited-file]').click();
  const preview = second.getByRole('dialog',{name: 'approved.txt',exact: true});
  await expect(preview).toContainText('Approved on Server');
  await expect(preview.locator('[data-preview-mode]')).toContainText('1 change');
  await expect(preview.locator('[data-preview-diff]')).toContainText('+Approved on Server');
  await preview.getByRole('button',{name: 'File',exact: true}).click();
  await expect(preview.locator('[data-file-preview-text]')).toContainText('Approved on Server');
  await expect(preview.getByRole('button',{name: 'Reveal',exact: true})).toHaveCount(0);
  const fileDownload = second.waitForEvent('download');
  await preview.getByRole('button',{name: 'Download', exact: true}).click();
  expect(await readFile((await (await fileDownload).path())!,'utf8')).toBe('Approved on Server');
  await preview.getByRole('button',{name: 'Close',exact: true}).first().click();
  const state = (await host.command('state')).state;
  const lease = await second.evaluate(() => sessionStorage.getItem('pith-desk-server-lease'));
  const file = await context.request.get(host.url + '/api/conversation-file?id=' + state.activeId + '&path=approved.txt', {headers: {'X-Desk-Lease': lease!}});
  expect(file.status()).toBe(200);
  expect(await file.text()).toBe('Approved on Server');
  const download = second.waitForEvent('download');
  await second.getByRole('button', {name: `Actions for ${state.conversations.find(entry => entry.id === state.activeId).title}`, exact: true}).click();
  await second.getByRole('menuitem', {name: 'Export Markdown'}).click();
  const exported = await download;
  expect(await readFile((await exported.path())!, 'utf8')).toContain('Write a file after approval');
});
