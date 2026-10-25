import {expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

test.setTimeout(60000);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');

async function ready(page,host) {
  await page.goto(host.url);
  await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button',{name: 'Attach images',exact: true})).toBeEnabled();
}
async function draft(page,context,host) {
  const lease = await page.evaluate(() => sessionStorage.getItem('pith-desk-server-lease'));
  return (await context.request.get(host.url + '/api/draft?id=' + host.state.activeId,{headers: {'X-Desk-Lease': lease!}})).json();
}

test('revoked autosave cannot overwrite the new owner and unsent text remains recoverable after reload',async ({page,context,host}) => {
  await ready(page,host);
  let release!: () => void, held = 0, draftPosts = 0;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route('**/api/draft',async route => {
    if (route.request().method() === 'POST') {draftPosts++; held++; await gate;}
    await route.continue();
  });
  await page.getByRole('textbox',{name: 'Message Pith',exact: true}).fill('Unsent text from the old page');
  await expect.poll(() => held).toBe(1);
  const second = await context.newPage();await second.goto(host.url);
  await second.getByRole('button',{name: 'Continue here',exact: true}).click();
  await expect(second.getByRole('dialog')).not.toBeVisible();
  await expect(second.getByRole('button',{name: 'Attach images',exact: true})).toBeEnabled();
  await expect(second.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();
  await expect(page.getByRole('dialog')).toContainText('Other pages will disconnect');
  await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name: 'Unsent text on this page',exact: true})).toHaveValue(/Unsent text from the old page/);
  await second.getByRole('textbox',{name: 'Message Pith',exact: true}).fill('Draft belonging to the new page');
  await expect.poll(async () => (await draft(second,context,host)).text).toBe('Draft belonging to the new page');
  release();
  await expect.poll(() => draftPosts).toBe(1);
  await page.evaluate(() => {window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('focus'));});
  await expect.poll(async () => (await draft(second,context,host)).text).toBe('Draft belonging to the new page');
  expect(draftPosts).toBe(1);
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name: 'Continue here',exact: true}).click()]);
  const recovery = page.getByRole('dialog',{name: 'Recovered unsent text',exact: true});
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('textbox')).toHaveValue(/Unsent text from the old page/);
  const download = page.waitForEvent('download');await recovery.getByRole('button',{name: 'Download text',exact: true}).click();
  expect(await readFile((await (await download).path())!,'utf8')).toContain('Unsent text from the old page');
  await recovery.getByRole('button',{name: 'Discard copy',exact: true}).click();
  await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toHaveValue('Draft belonging to the new page');
  expect((await host.command('stats')).requests).toBe(0);
});

test('Server configuration explains execution location and downloads diagnostics',async ({page,host}) => {
  await ready(page,host);
  await page.getByRole('button',{name: 'Settings',exact: true}).click();
  const settings = page.getByRole('dialog',{name: 'Settings',exact: true});
  await expect(settings).toContainText('localhost in a Base URL refers to the server');
  await expect(settings.getByRole('button',{name: 'Check for updates',exact: true})).toHaveCount(0);
  await expect(settings.getByRole('button',{name: 'Update and restart',exact: true})).toHaveCount(0);
  const download = page.waitForEvent('download');await settings.getByRole('button',{name: 'Download diagnostics',exact: true}).click();
  const diagnostics = await readFile((await (await download).path())!,'utf8');
  expect(() => JSON.parse(diagnostics)).not.toThrow();expect(diagnostics).not.toContain('fixture-provider-key');
  await settings.getByRole('combobox',{name: 'Provider'}).click();
  await page.getByRole('option',{name: /OpenAI Codex/i}).click();
  await expect(settings.getByRole('button',{name: 'Sign in with provider',exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name: 'Connections',exact: true}).click();
  const connections = page.getByRole('dialog',{name: 'Connections',exact: true});
  await expect(connections).toContainText('environment variables and runtime dependencies all refer to that server');
});

for (const hostMode of ['desktop', 'server']) test.describe(`${hostMode} MCP OAuth controls`, () => {
  test.use({hostMode});
  test('the actual connection menu and editor expose new authorization in both modes', async ({page, host}) => {
    const snapshot = page.waitForRequest(request => new URL(request.url()).pathname === '/api/state');
    await ready(page, host);
    // Seed a saved OAuth connection through the real authenticated Host API.
    const headers = await (await snapshot).allHeaders();
    const saved = await page.request.post(host.url + '/api/mcp/save', {
      headers: {Origin: host.url, 'X-Desk-Request': String(Date.now()), ...Object.fromEntries(Object.entries(headers).filter(([key]) => ['authorization', 'x-desk-lease'].includes(key)))},
      data: {name: 'saved-oauth', type: 'http', url: 'https://example.invalid/mcp', args: [], oauth: true, enabled: false},
    });
    expect(saved.ok()).toBe(true);
    // Reload renews the Server lease after this test-only setup write.
    await page.reload();
    await expect(page.getByRole('textbox', {name: 'Message Pith', exact: true})).toBeEditable();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', {name: 'Connections', exact: true}).click();
    const connections = page.getByRole('dialog', {name: 'Connections', exact: true});
    await connections.getByRole('button', {name: 'saved-oauth options', exact: true}).click();
    const signIn = page.getByRole('menu').getByRole('menuitem', {name: 'Sign in…', exact: true});
    await expect(signIn).toBeEnabled();
    await page.keyboard.press('Escape');
    await connections.getByRole('button', {name: 'New connection', exact: true}).click();
    await expect(connections.getByLabel('Bearer token')).toBeVisible();
    const oauth = connections.getByRole('switch', {name: 'Use OAuth', exact: true});
    await oauth.check();
    await expect(connections.getByLabel('OAuth client ID')).toBeVisible();
    await expect(connections.getByLabel('OAuth scope')).toBeVisible();
    if (hostMode === 'server') await expect(connections).toContainText('paste the complete redirect URL from the browser address bar');
  });
});

test('takeover preserves an unsubmitted message edit without editing or resending the conversation',async ({page,context,host}) => {
  await ready(page,host);
  const input = page.getByRole('textbox',{name: 'Message Pith',exact: true});
  await input.fill('Original question');await page.getByRole('button',{name: 'Send message',exact: true}).click();
  await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
  await page.getByRole('button',{name: 'Edit message',exact: true}).click();
  await page.locator('[data-text-edit] textarea').fill('Unsubmitted edit from the old page');
  const second = await context.newPage();await second.goto(host.url);await second.getByRole('button',{name: 'Continue here',exact: true}).click();
  await expect(page.getByRole('textbox',{name: 'Unsent text on this page',exact: true})).toHaveValue(/Unsubmitted edit from the old page/);
  await expect(page.getByRole('button',{name: 'Send again',exact: true})).toHaveCount(0);
  const actual = await host.command('state');expect(actual.requests).toBe(1);
  expect(actual.state.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Original question']);
});

test('browser-local file drops are rejected while images and typed server references survive refresh',async ({page,context,host}) => {
  await ready(page,host);
  let resolvers = 0;page.on('request',request => {if (new URL(request.url()).pathname === '/api/workspace-references') resolvers++;});
  const path = host.state.workspaces[0].path + '/report.txt';
  await page.evaluate(path => {
    const field = document.querySelector('textarea[aria-label="Message Pith"]')!;
    const uri = new DataTransfer();uri.setData('text/uri-list','file://' + path);field.dispatchEvent(new DragEvent('drop',{bubbles: true,cancelable: true,dataTransfer: uri}));
    const files = new DataTransfer();files.items.add(new File(['local content'],'report.txt',{type: 'text/plain'}));field.dispatchEvent(new DragEvent('drop',{bubbles: true,cancelable: true,dataTransfer: files}));
  },path);
  await expect(page.getByText('Files on this device are not uploaded.',{exact: false})).toBeVisible();expect(resolvers).toBe(0);
  await page.getByRole('textbox',{name: 'Message Pith',exact: true}).fill('Review `report.txt` in this server workspace');
  const picker = page.waitForEvent('filechooser');await page.getByRole('button',{name: 'Attach images',exact: true}).click();
  await (await picker).setFiles({name: 'photo.png',mimeType: 'image/png',buffer: png});
  await expect.poll(async () => (await draft(page,context,host)).images?.length || 0).toBe(1);
  expect((await draft(page,context,host)).text).toBe('Review `report.txt` in this server workspace');
  expect(await page.evaluate(() => sessionStorage.getItem('pith-desk-unsaved-text') || '')).not.toContain(png.toString('base64'));
  await page.reload();
  await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toHaveValue('Review `report.txt` in this server workspace');
  expect((await draft(page,context,host)).images).toHaveLength(1);
  expect((await host.command('stats')).requests).toBe(0);
});

test('queued work and unread completion survive a refresh and closed browser without replay',async ({page,context,host}) => {
  await ready(page,host);await host.command('hold-provider',{enabled: true});
  await page.getByRole('textbox',{name: 'Message Pith',exact: true}).fill('First task');await page.getByRole('button',{name: 'Send message',exact: true}).click();
  await expect.poll(async () => (await host.command('stats')).requests).toBe(1);
  await page.getByRole('textbox',{name: 'Message Pith',exact: true}).fill('Queued follow up');await page.getByRole('button',{name: 'Queue message',exact: true}).click();
  await expect.poll(async () => (await host.command('state')).state.queuedMessages.length).toBe(1);
  await page.reload();await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();
  await expect(page.getByText('Queued follow up',{exact: true})).toBeVisible();
  expect((await host.command('stats')).requests).toBe(1);
  await page.close();await host.command('hold-provider',{enabled: false});
  await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
  const finished = await host.command('state');
  expect(finished.requests).toBe(2);expect(finished.state.queuedMessages).toHaveLength(0);
  expect(finished.state.conversations.find(conversation => conversation.id === host.state.activeId).unread).toBe(true);
  const reopened = await context.newPage();await reopened.goto(host.url);await reopened.getByRole('button',{name: 'Continue here',exact: true}).click();
  await expect(reopened.locator('[data-conversation-scroll]')).toContainText('Queued follow up');
  expect((await host.command('stats')).requests).toBe(2);expect((await host.command('state')).canceled).toBe(0);
});

test.describe('phone browser',() => {
  test.use({viewport: {width: 390,height: 844},isMobile: true,hasTouch: true});
  test('simulated keyboard keeps input and approval reachable, sidebar switches and results download',async ({page,host}) => {
    await ready(page,host);await host.command('write-tool',{enabled: true});
    await page.getByRole('textbox',{name: 'Message Pith',exact: true}).fill('Write a phone result');await page.getByRole('button',{name: 'Send message',exact: true}).click();
    await expect(page.getByRole('button',{name: 'Allow this action',exact: true})).toBeVisible();
    await page.evaluate(() => {Object.defineProperty(window.visualViewport!,'height',{configurable: true,value: 330});window.visualViewport!.dispatchEvent(new Event('resize'));});
    const input = page.getByRole('textbox',{name: 'Message Pith',exact: true});await input.fill('Unsent text with the keyboard open');
    await expect.poll(async () => (await input.boundingBox())!.y + (await input.boundingBox())!.height).toBeLessThanOrEqual(330);
    const panels = page.locator('[data-composer-panels]');expect(await panels.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await page.getByRole('button',{name: 'Toggle navigation',exact: true}).click();await expect(page.getByRole('button',{name: 'Settings',exact: true})).toBeVisible();
    await page.mouse.click(380,100);await expect(page.getByRole('button',{name: 'Toggle navigation',exact: true})).toHaveAttribute('aria-expanded','false');
    await page.getByRole('button',{name: 'Allow this action',exact: true}).click();
    await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
    await expect(input).toHaveValue('Unsent text with the keyboard open');
    const edited = page.locator('[data-edited-files]');
    await expect(edited.locator('[data-edited-file]')).toHaveCount(1);
    await edited.locator('[data-edited-file]').click();
    const download = page.waitForEvent('download');
    await page.getByRole('dialog',{name: 'approved.txt',exact: true}).getByRole('button',{name: 'Download',exact: true}).click();
    expect(await readFile((await (await download).path())!,'utf8')).toBe('Approved on Server');
  });
});
