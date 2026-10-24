import {test, expect, type Page} from '@playwright/test';
import {installFixture} from './fixture.mjs';

test.beforeEach(async ({page}) => {
  await page.addInitScript(installFixture);
  await page.goto('/');
  await expect(page.getByRole('textbox', {name: 'Message'})).toBeVisible();
  await page.evaluate(async () => {
    const {runtime} = await import('/src/lib/runtime.ts');
    runtime.nativeBrowser = true;
    window.reviewState.conversations.push({id: 'c', title: 'Other conversation', workspaceId: 'other', permissionMode: 'ask'});
    const original = window.fetch;
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname;
      if (path !== '/api/web-preview') return original(url, options);
      const body = JSON.parse(options.body);
      window.review.requests.push({path, body});
      if (window.review.holdPreview) await new Promise(resolve => {window.releasePreview = resolve;});
      return Response.json({url: body.address});
    };
  });
  await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
  await page.getByRole('button', {name: 'New tool tab', exact: true}).click();
  await page.getByRole('menuitem', {name: 'New Web', exact: true}).click();
});

const address = (page: Page) => page.getByRole('textbox', {name: 'Web address', exact: true});
const closes = (page: Page) => page.evaluate(() => window.review.requests.filter(request => request.path === '/api/web-preview/close'));
async function switchConversation(page: Page, id: string) {
  await page.evaluate(value => {window.reviewState.activeId = value; window.emitReview();}, id);
  await expect(page.getByRole('textbox', {name: 'Web address', exact: true})).toHaveCount(id === 'a' ? 1 : 0);
}
async function navigate(page: Page) {
  await address(page).fill('https://example.com/private-project');
  await address(page).press('Enter');
  await expect.poll(() => page.evaluate(() => window.review.requests.filter(request => request.path === '/api/web-preview').length)).toBe(1);
}

test('native Web retains its address and page across workspace switches and narrow drawer closure', async ({page}) => {
  await navigate(page);
  await expect(page.getByText('Opened', {exact: false})).toBeVisible();
  await switchConversation(page, 'c');
  await switchConversation(page, 'a');
  await expect(address(page)).toHaveValue('https://example.com/private-project');
  expect(await closes(page)).toHaveLength(0);
  await page.setViewportSize({width: 600, height: 850});
  await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
  await expect(address(page)).toHaveValue('https://example.com/private-project');
  await page.getByRole('button', {name: 'Close tools', exact: true}).click();
  await expect(address(page)).toHaveCount(0);
  await page.getByRole('button', {name: 'Toggle tools', exact: true}).click();
  await expect(address(page)).toHaveValue('https://example.com/private-project');
  expect(await closes(page)).toHaveLength(0);
  const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pith-desk.tools.')).map(key => localStorage.getItem(key)).join(''));
  expect(stored).not.toContain('private-project');
  await page.getByRole('button', {name: 'Close Web', exact: true}).click();
  await expect.poll(() => closes(page)).toHaveLength(1);
  await expect(address(page)).toHaveCount(0);
});

test('a pending native navigation finishes while hidden and restores without reopening', async ({page}) => {
  await page.evaluate(() => {window.review.holdPreview = true;});
  await navigate(page);
  await switchConversation(page, 'c');
  await page.evaluate(() => window.releasePreview());
  await switchConversation(page, 'a');
  await expect(address(page)).toHaveValue('https://example.com/private-project');
  await expect(page.getByRole('button', {name: 'Refresh', exact: true})).toBeEnabled();
  expect(await closes(page)).toHaveLength(0);
  expect(await page.evaluate(() => window.review.requests.filter(request => request.path === '/api/web-preview'))).toHaveLength(1);
});

test('closing a pending native navigation releases the page once after its creation completes', async ({page}) => {
  await page.evaluate(() => {window.review.holdPreview = true;});
  await navigate(page);
  await page.getByRole('button', {name: 'Close Web', exact: true}).click();
  await page.evaluate(() => window.releasePreview());
  await expect.poll(() => closes(page)).toHaveLength(1);
  await expect(address(page)).toHaveCount(0);
  const requests = await page.evaluate(() => window.review.requests);
  expect(requests.find(request => request.path === '/api/web-preview/close').body.id).toBe(requests.find(request => request.path === '/api/web-preview').body.id);
});

test('a delayed native placement cannot restore a page after its workspace was hidden', async ({page}) => {
  await page.evaluate(() => {
    const original = window.fetch;
    window.review.shownPreview = '';
    window.fetch = async (url, options) => {
      if (new URL(url, location.href).pathname === '/api/web-preview/view') {
        const body = JSON.parse(options.body);
        if (body.bounds && !window.releasePlacement) await new Promise(resolve => {window.releasePlacement = resolve;});
        if (body.bounds) window.review.shownPreview = body.id;
        else if (window.review.shownPreview === body.id) window.review.shownPreview = '';
      }
      return original(url, options);
    };
  });
  await navigate(page);
  await expect.poll(() => page.evaluate(() => typeof window.releasePlacement)).toBe('function');
  await switchConversation(page, 'c');
  await page.evaluate(() => window.releasePlacement());
  await expect.poll(() => page.evaluate(() => window.review.shownPreview)).toBe('');
  expect(await closes(page)).toHaveLength(0);
});

for (const pending of [false, true]) test(`removing a workspace closes its ${pending ? 'pending' : 'opened'} native Web page`, async ({page}) => {
  await page.evaluate(pending => {
    window.review.holdPreview = pending;
    const original = window.fetch;
    window.fetch = async (url, options) => {
      if (new URL(url, location.href).pathname === '/api/remove-workspace' && options?.method === 'POST') {
        const {id} = JSON.parse(options.body);
        window.reviewState.workspaces = window.reviewState.workspaces.filter(workspace => workspace.id !== id);
        window.reviewState.conversations = window.reviewState.conversations.filter(conversation => conversation.workspaceId !== id);
        window.reviewState.activeId = 'c';
      }
      return original(url, options);
    };
  }, pending);
  await navigate(page);
  if (!pending) await expect(page.getByText('Opened', {exact: false})).toBeVisible();
  await page.getByRole('button', {name: 'Review workspace options', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Remove workspace…', exact: true}).click();
  await page.getByRole('dialog', {name: 'Remove workspace?', exact: true}).getByRole('button', {name: 'Remove workspace', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Review workspace options', exact: true})).toHaveCount(0);
  if (pending) await page.evaluate(() => window.releasePreview());
  await expect.poll(() => closes(page)).toHaveLength(1);
  await expect(address(page)).toHaveCount(0);
  const requests = await page.evaluate(() => window.review.requests);
  expect(requests.find(request => request.path === '/api/web-preview/close').body.id).toBe(requests.find(request => request.path === '/api/web-preview').body.id);
});
