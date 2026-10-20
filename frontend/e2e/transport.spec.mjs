import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test } from './host-fixture.mjs';

test.setTimeout(90000);

async function ready(page, url) {
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: 'Message Pith' })).toBeEditable();
  await expect(page.locator('.pui-composer-model')).toBeEnabled();
}

test('Server delayed HTTP cannot revert newer WS state', async ({ page, host }) => {
  await ready(page, host.url);
  const target = host.state.conversations[1];
  await page.getByRole('button', {name: host.state.workspaces.find(entry => entry.id === target.workspaceId).name, exact: true}).click();
  let captured, release;
  const held = new Promise((resolve) => { captured = resolve; });
  const unblock = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    captured();
    await unblock;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', {name: target.title || 'Untitled conversation', exact: true}).click();
    await held;
    await host.command('rename', { id: target.id, title: 'Newer streamed title 中文' });
    await expect(page.locator('.pui-breadcrumb-current')).toHaveText('Newer streamed title 中文');
  } finally { release(); }
  await expect(page.locator('.pui-composer-model')).toBeEnabled();
  await expect(page.locator('.pui-breadcrumb-current')).toHaveText('Newer streamed title 中文');
  expect((await host.command('state')).state.activeId).toBe(target.id);
});

test('committed create and send survive failed refresh and WS reconnect without replay', async ({ page, host }) => {
  const sockets = [], posts = [];
  const authenticated = [];
  let hold = false, failRead = false;
  await page.routeWebSocket('**/api/socket', (route) => {
    const server = route.connectToServer();
    sockets.push({ route, server });
    server.onMessage((message) => { if (!hold) route.send(message); });
    expect(route.protocols()[0]).toBe('pith-desk');
    expect(route.protocols()[1]).toMatch(/^lease\./);
    expect(route.url()).not.toContain('bearer');
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    authenticated.push(request);
    if (request.method() === 'POST') posts.push(url.pathname);
  });
  await page.route('**/api/state', async (route) => {
    if (failRead) {
      failRead = false;
      await route.fulfill({ status: 503, json: { error: 'Injected snapshot interruption' } });
    } else await route.continue();
  });
  await ready(page, host.url);
  await expect.poll(() => sockets.length).toBe(1);
  expect((await page.request.get(host.url + '/api/state')).status()).toBe(409);
  expect((await page.request.get(host.url + '/api/state', { headers: { Origin: 'https://example.invalid' } })).status()).toBe(403);
  const before = host.state.conversations.length;
  const reconnect = async () => {
    hold = false;
    const count = sockets.length;
    const closed = sockets.at(-1);
    await closed.route.close({ code: 1001, reason: 'Injected disconnect' });
    await closed.server.close({ code: 1001, reason: 'Injected disconnect' });
    await expect.poll(() => sockets.length).toBe(count + 1);
    await expect(page.locator('.pui-local-status')).toBeHidden();
  };
  hold = true; failRead = true;
  await page.getByRole('button', {name: `New conversation in ${host.state.workspaces[0].name}`, exact: true}).click();
  await expect(page.locator('.pui-inline-error')).toContainText('Change saved');
  expect((await host.command('state')).state.conversations).toHaveLength(before + 1);
  await reconnect();
  await expect(page.locator('.pui-breadcrumb-current')).toHaveText('New conversation');
  expect(posts.filter((path) => path === '/api/conversations')).toHaveLength(1);
  for (const request of authenticated.filter((request) => request.resourceType() === 'fetch' && !new URL(request.url()).pathname.startsWith('/api/server/'))) {
    expect((await request.allHeaders())['x-desk-lease']).toMatch(/^[a-f0-9]{64}$/);
    expect((await request.allHeaders()).authorization).toBeUndefined();
    expect(new URL(request.url()).origin).toBe(host.url);
    expect(request.url()).not.toContain('bearer');
  }

  hold = true; failRead = true;
  await page.getByRole('textbox', { name: 'Message Pith' }).fill('One committed send');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.pui-inline-error')).toContainText('Change saved');
  await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
  await reconnect();
  await expect(page.locator('.pui-messages')).toContainText('Fixture answer');
  const actual = await host.command('state');
  expect(actual.requests).toBe(1);
  expect(actual.state.messages.filter((message) => message.role === 'user' && message.text === 'One committed send')).toHaveLength(1);
  expect(posts.filter((path) => path === '/api/send')).toHaveLength(1);
  expect(posts.filter((path) => path === '/api/conversations')).toHaveLength(1);
});

test('real SDK history, drafts and completion survive isolated restart; downloads and cancellation retain semantics', async ({ page, host }) => {
  await ready(page, host.url);
  await page.getByRole('textbox', { name: 'Message Pith' }).fill('Persistent history 中文');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.pui-messages')).toContainText('Fixture answer');
  await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
  const finished = await host.command('state');
  const id = finished.state.activeId;
  const completed = finished.state.conversations.find((entry) => entry.id === id).completedRunId;
  expect(completed).toBeTruthy();

  const composer = page.getByRole('textbox', { name: 'Message Pith' });
  await composer.fill('Persistent draft 中文');
  const saved = await page.evaluate(() => new Promise((resolve) => {
    const event = new CustomEvent('pith:flush-drafts', { cancelable: true, detail: resolve });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) resolve(false);
  }));
  expect(saved).toBe(true);
  const restarted = await host.command('restart');
  expect(restarted.requests).toBe(1);
  expect(restarted.state.conversations.find((entry) => entry.id === id).completedRunId).toBe(completed);
  await ready(page, restarted.url);
  await expect(page.locator('.pui-messages')).toContainText('Persistent history 中文');
  await expect(page.locator('.pui-messages')).toContainText('Fixture answer');
  await expect(composer).toHaveValue('Persistent draft 中文');

  const download = page.waitForEvent('download');
  await page.getByRole('button', {name: `Actions for ${restarted.state.conversations.find(entry => entry.id === id).title || 'Untitled conversation'}`, exact: true}).click();
  await page.getByRole('menuitem', { name: 'Export Markdown' }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/\.md$/);
  expect(await exported.failure()).toBeNull();
  const markdown = await readFile(await exported.path(), 'utf8');
  expect(markdown).toContain('Persistent history 中文');
  expect(markdown).toContain('Fixture answer');

  await host.command('hold-provider', { enabled: true });
  await composer.fill('Task to cancel');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(async () => (await host.command('stats')).requests).toBe(2);
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
  await expect.poll(async () => (await host.command('state')).state.running).toBe(false);
  await expect.poll(async () => (await host.command('stats')).canceled).toBe(1);
  expect((await host.command('state')).state.conversations.find((entry) => entry.id === id).completedRunId).toBe(completed);
});
