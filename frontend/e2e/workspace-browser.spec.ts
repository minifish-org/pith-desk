import {expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {test} from './host-fixture.mjs';

test.setTimeout(60000);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');

for (const mode of ['desktop','server']) test.describe(mode+' workspace browser',() => {
  test.use({hostMode: mode});
  test('lazy tree, preview, download, reference and refresh preserve drafts and generated-file meaning',async ({page,host}) => {
    const workspace = host.state.workspaces[0];
    await mkdir(workspace.path+'/docs/nested',{recursive: true});
    await writeFile(workspace.path+'/docs/中文 draft.md','# Original content');
    await writeFile(workspace.path+'/docs/nested/unopened.txt','Deep file');
    const reads: string[] = [];
    page.on('request',request => {const url = new URL(request.url());if (url.pathname === '/api/workspace-files') reads.push(url.searchParams.get('path') || '');});
    await page.addInitScript(() => {Object.defineProperty(navigator,'clipboard',{configurable: true,value: {async writeText(text: string) {(window as any).copiedPath = text;}}});});
    await page.goto(host.url);const draft = page.getByRole('textbox',{name: 'Message Pith',exact: true});await expect(draft).toBeEditable();
    expect(reads).toEqual([]);
    await draft.fill('Before after');await draft.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(7,7));
    const picker = page.waitForEvent('filechooser');await page.getByRole('button',{name: 'Attach images',exact: true}).click();await (await picker).setFiles({name: 'draft.png',mimeType: 'image/png',buffer: png});
    await page.getByRole('button',{name: 'Toggle tools',exact: true}).click();const tools = page.getByRole('complementary',{name: 'Workspace files',exact: true});
    await expect(tools).toContainText((mode === 'server' ? 'Server workspace: ' : 'Workspace: ')+workspace.path);
    await expect(tools.getByRole('button',{name: 'docs',exact: true})).toBeVisible();expect(reads).toEqual(['']);
    await tools.getByRole('button',{name: 'docs',exact: true}).click();await expect(tools.getByRole('button',{name: '中文 draft.md',exact: true})).toBeVisible();expect(reads).toEqual(['','docs']);
    await tools.getByRole('button',{name: 'Actions for docs/中文 draft.md',exact: true}).click();
    await page.getByRole('menuitem',{name: mode === 'server' ? 'Copy server path' : 'Copy path',exact: true}).click();
    expect(await page.evaluate(() => (window as any).copiedPath)).toBe(workspace.path+'/docs/中文 draft.md');
    await tools.getByRole('button',{name: 'Actions for docs/中文 draft.md',exact: true}).click();await page.getByRole('menuitem',{name: 'Insert reference',exact: true}).click();
    await expect(draft).toHaveValue('Before `docs/中文 draft.md` after');
    expect((await host.command('stats')).requests).toBe(0);await expect(page.getByRole('button',{name: /Conversation files/})).toHaveCount(0);
    await tools.getByRole('button',{name: '中文 draft.md',exact: true}).click();const preview = page.getByRole('dialog',{name: '中文 draft.md',exact: true});
    await expect(preview).toContainText('Original content');await expect(preview.getByRole('button',{name: 'Reveal',exact: true})).toHaveCount(0);
    await preview.getByRole('button',{name: 'Close 中文 draft.md',exact: true}).click();
    await tools.getByRole('button',{name: 'Actions for docs/中文 draft.md',exact: true}).click();
    const downloaded = page.waitForEvent('download');await page.getByRole('menuitem',{name: 'Download',exact: true}).click();
    expect(await readFile((await (await downloaded).path())!,'utf8')).toBe('# Original content');
    await writeFile(workspace.path+'/docs/中文 draft.md','# Changed after refresh');await writeFile(workspace.path+'/new-result.txt','New result');
    await tools.getByRole('button',{name: 'Refresh workspace files',exact: true}).click();await expect(tools.getByRole('button',{name: 'new-result.txt',exact: true})).toBeVisible();
    await tools.getByRole('button',{name: '中文 draft.md',exact: true}).click();await expect(preview).toContainText('Changed after refresh');await preview.getByRole('button',{name: 'Close 中文 draft.md',exact: true}).click();
    await tools.getByRole('searchbox',{name: 'Find workspace files',exact: true}).fill('unopened');await expect(tools.getByRole('button',{name: 'docs/nested/unopened.txt',exact: true})).toBeVisible();
    await page.reload();await expect(draft).toHaveValue('Before `docs/中文 draft.md` after');await expect(page.getByRole('button',{name: 'Remove draft.png',exact: true})).toBeVisible();
    expect((await host.command('stats')).requests).toBe(0);
  });

  test('workspace switches retire delayed directory and preview responses',async ({page,host}) => {
    const [first,second] = host.state.workspaces;
    await writeFile(first.path+'/old.txt','Old preview');await writeFile(second.path+'/current.txt','Current preview');
    await page.goto(host.url);await expect(page.getByRole('textbox',{name: 'Message Pith',exact: true})).toBeEditable();
    let release!: () => void;const pending = new Promise<void>(resolve => {release = resolve;});let waiting = false;
    await page.route('**/api/workspace-files?**',async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('workspaceId') !== first.id) {await route.continue();return;}
      const response = await route.fetch();waiting = true;await pending;await route.fulfill({response}).catch(() => {});
    });
    await page.getByRole('button',{name: 'Toggle tools',exact: true}).click();await expect.poll(() => waiting).toBe(true);
    await page.getByRole('button',{name: second.name,exact: true}).click();await page.getByRole('button',{name: second.name+' conversation',exact: true}).click();
    const tools = page.getByRole('complementary',{name: 'Workspace files',exact: true});await expect(tools.getByRole('button',{name: 'current.txt',exact: true})).toBeVisible();release();
    await expect(tools.getByRole('button',{name: 'old.txt',exact: true})).toHaveCount(0);
    let previewRelease!: () => void;const previewPending = new Promise<void>(resolve => {previewRelease = resolve;});let previewWaiting = false;
    await page.route('**/api/workspace-preview?**',async route => {const response = await route.fetch();previewWaiting = true;await previewPending;await route.fulfill({response}).catch(() => {});});
    await tools.getByRole('button',{name: 'current.txt',exact: true}).click();await expect.poll(() => previewWaiting).toBe(true);
    await page.getByRole('dialog',{name: 'current.txt',exact: true}).getByRole('button',{name: 'Close current.txt',exact: true}).click();
    await page.getByRole('button',{name: first.name+' conversation',exact: true}).click();previewRelease();
    await expect(page.getByRole('dialog')).not.toBeVisible();await expect(tools.getByRole('button',{name: 'old.txt',exact: true})).toBeVisible();
    await expect(tools).not.toContainText('Current preview');
  });
});

test.describe('phone workspace files',() => {
  test.use({viewport: {width: 390,height: 844},isMobile: true,hasTouch: true});
  test('keyboard geometry keeps directory scrolling, preview, download and both dismiss paths usable',async ({page,host}) => {
    const root = host.state.workspaces[0].path;await mkdir(root+'/docs');
    await Promise.all(Array.from({length: 60},(_,index) => writeFile(root+`/docs/file-${String(index).padStart(2,'0')}.txt`,'Phone preview')));
    await page.goto(host.url);const draft = page.getByRole('textbox',{name: 'Message Pith',exact: true});await expect(draft).toBeEditable();await draft.fill('Phone draft stays');
    await page.evaluate(() => {Object.defineProperty(window.visualViewport!,'height',{configurable: true,value: 330});window.visualViewport!.dispatchEvent(new Event('resize'));});
    await page.getByRole('button',{name: 'Toggle tools',exact: true}).click();const tools = page.getByRole('complementary',{name: 'Workspace files',exact: true});
    await tools.getByRole('button',{name: 'docs',exact: true}).click();const nav = tools.getByRole('navigation',{name: 'Workspace files',exact: true});
    await expect.poll(async () => nav.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await tools.getByRole('button',{name: 'file-59.txt',exact: true}).click();const preview = page.getByRole('dialog',{name: 'file-59.txt',exact: true});await expect(preview).toContainText('Phone preview');
    const box = (await preview.boundingBox())!;expect(box.y+box.height).toBeLessThanOrEqual(330);
    const download = page.waitForEvent('download');await preview.getByRole('button',{name: 'Download',exact: true}).click();expect(await readFile((await (await download).path())!,'utf8')).toBe('Phone preview');
    await preview.getByRole('button',{name: 'Close file-59.txt',exact: true}).click();await tools.getByRole('button',{name: 'Close tools',exact: true}).click();await expect(page.getByRole('button',{name: 'Toggle tools',exact: true})).toBeFocused();
    await page.getByRole('button',{name: 'Toggle navigation',exact: true}).click();await page.locator('.pui-sidebar-scrim.pui-visible').click({position: {x: 380,y: 100}});
    await expect(page.getByRole('button',{name: 'Toggle navigation',exact: true})).toBeFocused();await expect(draft).toHaveValue('Phone draft stays');
  });
});
