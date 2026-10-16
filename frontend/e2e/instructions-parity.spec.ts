import {test, expect} from '@playwright/test';
import {installFixture} from './fixture.mjs';
import type {State} from '../src/app-state';

interface InstructionsFixture {
  writes: Array<{workspaceId: string}>;
  reads: string[];
  created: string[];
  failWrite: boolean;
  failRead: boolean;
  holdWrite: boolean;
  releaseWrite?: () => void;
}
type BrowserFixture = {reviewState: State; emitReview(): void; instructions: InstructionsFixture};

test.beforeEach(async ({page}) => {
  await page.addInitScript(installFixture);
  await page.addInitScript(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.instructions = {writes: [], reads: [], created: [], failWrite: false, failRead: false, holdWrite: false};
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href), controls = fixture.instructions;
      if (url.pathname === '/api/create-instructions' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {workspaceId: string}; controls.writes.push(body);
        if (controls.holdWrite) await new Promise<void>(resolve => {controls.releaseWrite = resolve;});
        if (controls.failWrite) return Response.json({error: 'Instruction creation rejected'}, {status: 409});
        controls.created.push(body.workspaceId);
        return Response.json({path: `/tmp/${body.workspaceId}/AGENTS.md`});
      }
      if (url.pathname === '/api/resources') {
        const id = url.searchParams.get('workspaceId')!; controls.reads.push(id);
        if (controls.failRead) return Response.json({error: 'Instruction inventory refresh failed'}, {status: 503});
        const workspace = fixture.reviewState.workspaces.find(entry => entry.id === id)!;
        const instructions = controls.created.includes(id) ? [{name: 'AGENTS.md', path: workspace.path + '/AGENTS.md', content: '# Project instructions'}] : [];
        return Response.json({instructions, skills: [], templates: [], diagnostics: []});
      }
      return original(input, init);
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => {
    const fixture = window as unknown as {reviewSocket?: {onmessage?: unknown}};
    return fixture.reviewSocket?.onmessage && !document.querySelector<HTMLTextAreaElement>('textarea[id$="composer-input"]')!.readOnly;
  });
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Create AGENTS.md in this workspace', exact: true})).toBeEnabled();
});

test('creating AGENTS.md writes once to the inventory workspace without opening an editor', async ({page}) => {
  const create = page.getByRole('button', {name: 'Create AGENTS.md in this workspace', exact: true});
  await page.evaluate(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.reviewState.conversations.find(entry => entry.id === 'b')!.workspaceId = 'other';
    fixture.reviewState.activeId = 'b';
    fixture.reviewState.runs = [{conversationId: 'a', workspaceId: 'w', phase: 'working', needsApproval: false}];
    fixture.emitReview();
  });
  await expect(create).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as BrowserFixture).instructions.writes)).toEqual([]);
  await page.evaluate(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.reviewState.runs = [{conversationId: 'b', workspaceId: 'other', phase: 'working', needsApproval: false}];
    fixture.emitReview();
  });
  await expect(create).toBeEnabled(); await create.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as BrowserFixture).instructions.writes)).toEqual([{workspaceId: 'w'}]);
  await expect(page.locator('[id$="resources-content"]')).toContainText('AGENTS.md');
  await expect(create).toHaveCount(0);
  await expect(page.locator('[id$="sdk-dialog"]')).not.toBeVisible();
  expect(await page.evaluate(() => (window as unknown as BrowserFixture).instructions.reads)).toEqual(['w', 'w']);
});

test('creation failures permit an explicit retry and a failed refresh never repeats the committed write', async ({page}) => {
  const create = page.getByRole('button', {name: 'Create AGENTS.md in this workspace', exact: true});
  await page.evaluate(() => {(window as unknown as BrowserFixture).instructions.failWrite = true;});
  await create.click();
  await expect(page.locator('[id$="resources-error"]')).toHaveText('Instruction creation rejected');
  await expect(create).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as BrowserFixture).instructions.writes)).toEqual([{workspaceId: 'w'}]);
  await page.evaluate(() => {const controls = (window as unknown as BrowserFixture).instructions; controls.failWrite = false; controls.failRead = true;});
  await create.click();
  await expect(page.locator('[id$="resources-error"]')).toHaveText('Instruction inventory refresh failed');
  await expect(page.locator('[id$="resources-dialog"]')).toBeVisible();
  await expect(create).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as BrowserFixture).instructions.writes)).toEqual([{workspaceId: 'w'}, {workspaceId: 'w'}]);
  await page.evaluate(() => {(window as unknown as BrowserFixture).instructions.failRead = false;});
  await page.locator('[id$="resources-content"]').getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(create).toHaveCount(0);
  expect(await page.evaluate(() => {
    const controls = (window as unknown as BrowserFixture).instructions;
    return {writes: controls.writes, reads: controls.reads};
  })).toEqual({writes: [{workspaceId: 'w'}, {workspaceId: 'w'}], reads: ['w', 'w', 'w']});
});

test('a delayed creation cannot refresh or report into a newly opened inventory', async ({page}) => {
  await page.evaluate(() => {(window as unknown as BrowserFixture).instructions.holdWrite = true;});
  await page.getByRole('button', {name: 'Create AGENTS.md in this workspace', exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as BrowserFixture).instructions.writes)).toEqual([{workspaceId: 'w'}]);
  await page.locator('[id$="resources-dialog"]').getByRole('button', {name: 'Close workspace resources', exact: true}).click();
  await page.evaluate(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.reviewState.conversations.find(entry => entry.id === 'b')!.workspaceId = 'other'; fixture.reviewState.activeId = 'b'; fixture.emitReview();
  });
  await page.getByRole('button', {name: 'Workspace resources', exact: true}).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as BrowserFixture).instructions.reads)).toEqual(['w', 'other']);
  await page.evaluate(() => {(window as unknown as BrowserFixture).instructions.releaseWrite!();});
  await expect(page.getByRole('button', {name: 'Create AGENTS.md in this workspace', exact: true})).toBeEnabled();
  await expect(page.locator('[id$="resources-error"]')).toHaveText('');
  await expect(page.locator('[id$="resources-content"]')).toContainText('Other workspace');
  expect(await page.evaluate(() => {
    const controls = (window as unknown as BrowserFixture).instructions;
    return {writes: controls.writes, reads: controls.reads, created: controls.created};
  })).toEqual({writes: [{workspaceId: 'w'}], reads: ['w', 'other'], created: ['w']});
});
