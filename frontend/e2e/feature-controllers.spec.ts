import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import type {Application} from '../src/ui-contract.ts';

const fixed = JSON.parse(readFileSync(new URL('../../internal/desk/testdata/state.active.json', import.meta.url), 'utf8'));
type ControllerFixture = {ui: Application};

test.beforeEach(async ({page}) => {
  await page.route('**/controller-test.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head><title>Real DOM controller regression</title></head><body><div id="app"></div></body></html>'}));
  await page.goto('/controller-test.html');
  await page.evaluate(async () => {
    const library = '/src/ui-application.ts', styles = '/node_modules/pith-ui/dist/styles.css';
    const [{mountDesk}] = await Promise.all([import(library), import(styles)]);
    const ui = mountDesk(document.getElementById('app')!);
    (window as unknown as {controllerFixture: ControllerFixture}).controllerFixture = {ui};
  });
});

test('composer ignores an older draft after the selected conversation changes', async ({page}) => {
  const result = await page.evaluate(async fixed => {
    const path = '/src/composer.ts'; const {createComposer} = await import(path);
    const {ui} = (window as unknown as {controllerFixture: ControllerFixture}).controllerFixture;
    const replies: Array<{id: string; resolve: (value: unknown) => void}> = [];
    let state = structuredClone(fixed); const rendered: string[] = [];
    const composer = createComposer({
      ui, view: {get state() {return state;}, loaded: true}, activity: {busy: false, error: ''},
      request: (_path: string, {query}: {query: {id: string}}) => new Promise(resolve => replies.push({id: query.id, resolve})),
      mutate: async () => true, refresh: async () => {}, render() {rendered.push(ui.workspace.readDraft()); ui.workspace.updateComposer({readOnly: composer.draftLoading});},
      selectedWorkspace: () => state.workspaces[0], openWorkspace() {}, openSettings() {}, followLatest() {}, disposed: () => false,
    });
    composer.loadComposerDraft(); const original = state.activeId;
    state = {...state, activeId: state.conversations.find((entry: {id: string}) => entry.id !== original)!.id};
    composer.loadComposerDraft(); replies[1].resolve({text: 'current draft 中文', revision: 2});
    await new Promise(resolve => setTimeout(resolve, 0)); const count = rendered.length;
    replies[0].resolve({text: 'older draft must not replace it', revision: 1});
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = {text: ui.workspace.readDraft(), scope: composer.composerScope.id, activeId: state.activeId,
      readOnly: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!.readOnly, count, finalCount: rendered.length, requests: replies.map(reply => reply.id)};
    composer.destroy(); ui.destroy(); return result;
  }, fixed);
  expect(result.text).toBe('current draft 中文');
  expect(result.scope).toBe(result.activeId);
  expect(result.readOnly).toBe(false);
  expect(result.finalCount).toBe(result.count);
  expect(result.requests).toHaveLength(2);
  expect(result.requests[1]).toBe(result.activeId);
});

test('a resource response cannot replace a newer history dialog', async ({page}) => {
  const result = await page.evaluate(async fixed => {
    const resourcePath = '/src/resource-editor.ts', historyPath = '/src/history.ts';
    const [{createResourceUI}, {createHistoryUI}] = await Promise.all([import(resourcePath), import(historyPath)]);
    const {ui} = (window as unknown as {controllerFixture: ControllerFixture}).controllerFixture;
    let release!: (value: {content: string}) => void;
    const state = structuredClone(fixed), requests: unknown[] = [];
    const api = {ui, state: () => state, mutate: async () => true, error: () => '',
      request: (path: string, input: unknown) => {requests.push({path, input}); return path === '/api/resource-content' ? new Promise(resolve => {release = resolve;}) : Promise.resolve([]);},
      workspaceBusy: () => false, busy: () => false, refreshResources: async () => {}, confirm() {}};
    const resources = createResourceUI(api), histories = createHistoryUI(api);
    const resource = resources.resource(state.workspaces[0].id, 'instructions', 'AGENTS.md');
    await histories.history();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.pui-feature-modal')!;
    const history = dialog.innerHTML;
    release({content: 'delayed private workspace resource'}); await resource;
    const result = {history, current: dialog.innerHTML, open: dialog.open, requests};
    resources.destroy(); histories.destroy(); ui.destroy(); return result;
  }, fixed);
  expect(result.history).toContain('Conversation branches');
  expect(result.current).toBe(result.history);
  expect(result.open).toBe(true);
  expect(result.requests).toEqual([
    {path: '/api/resource-content', input: {query: {workspaceId: fixed.workspaces[0].id, path: 'AGENTS.md'}}},
    {path: '/api/history', input: {query: {id: fixed.activeId}}},
  ]);
});

test('closing the shared dialog invalidates an in-flight history read', async ({page}) => {
  const result = await page.evaluate(async fixed => {
    const historyPath = '/src/history.ts'; const {createHistoryUI} = await import(historyPath);
    const {ui} = (window as unknown as {controllerFixture: ControllerFixture}).controllerFixture;
    let release!: (value: unknown) => void;
    const api = {ui, state: () => fixed, mutate: async () => true, error: () => '', request: () => new Promise(resolve => {release = resolve;})};
    const controller = createHistoryUI(api), reading = controller.history();
    const native = document.querySelector<HTMLDialogElement>('dialog.pui-feature-modal')!;
    const closed = new Promise<void>(resolve => native.addEventListener('close', () => resolve(), {once:true}));
    native.close();
    release([{id: 'late-node', role: 'user', text: 'late history', active: true}]); await reading;
    await closed;
    const result = {content: native.innerHTML, open: native.open};
    controller.destroy(); ui.destroy(); return result;
  }, fixed);
  expect(result.content).toBe(''); expect(result.open).toBe(false);
});

// These regressions moved from workspace-files.test.mjs: actual scenes own
// routing, image delivery and selection insertion; host fakes must not copy them.
test('native drops outside composer do not insert paths', async ({page}) => {
  const result = await page.evaluate(async () => {
    const path = '/src/workspace-files.ts', library = '/src/ui-application.ts';
    const [{installWorkspaceFileDrop}, {mountDesk}] = await Promise.all([import(path), import(library)]);
    (window as unknown as {controllerFixture: ControllerFixture}).controllerFixture.ui.destroy();
    const resolved: unknown[] = [], errors: string[] = [];
    let controller: ReturnType<typeof installWorkspaceFileDrop>;
    const ui = mountDesk(document.getElementById('app')!, {workspace: {onDropReferences: (input: {paths: readonly string[]; uris?: string}) => controller.references(input)}});
    controller = installWorkspaceFileDrop({ui, native: true, busy: () => false, context: () => 'workspace/chat/1', workspaceID: () => 'workspace', disposed: () => false,
      resolve: async (workspace: string, paths: string[]) => {resolved.push({workspace, paths}); return ['file.md'];}, pending() {}, changed() {}, error: (message: string) => errors.push(message)});
    ui.workspace.resetDraft('Review ');
    ui.workspace.receiveNativeDrop({paths: ['/workspace/file.md'], x: 1, y: 1});
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = {resolved, errors, draft: ui.workspace.readDraft()};
    controller.destroy(); ui.destroy(); return result;
  });
  expect(result).toEqual({resolved: [], errors: [], draft: 'Review '});
});

test('mixed images still arrive when native paths resolve before the DOM drop', async ({page}) => {
  const result = await page.evaluate(async () => {
    const path = '/src/workspace-files.ts', library = '/src/ui-application.ts';
    const [{installWorkspaceFileDrop}, {mountDesk}] = await Promise.all([import(path), import(library)]);
    (window as unknown as {controllerFixture: ControllerFixture}).controllerFixture.ui.destroy();
    const images: string[][] = [], resolved: unknown[] = [], errors: string[] = [], changes: string[] = [], pending: boolean[] = [];
    let release!: (paths: string[]) => void;
    let controller: ReturnType<typeof installWorkspaceFileDrop>;
    const ui = mountDesk(document.getElementById('app')!, {workspace: {
      onImages: (files: File[]) => images.push(files.map(file => file.name)),
      onDropReferences: (input: {paths: readonly string[]; uris?: string}) => controller.references(input),
    }});
    const options = {ui, native: true, busy: () => false, context: () => 'workspace/chat/1', workspaceID: () => 'workspace', disposed: () => false,
      resolve: (workspace: string, paths: string[]) => {resolved.push({workspace, paths}); return new Promise<string[]>(resolve => {release = resolve;});},
      pending: (value: boolean) => pending.push(value), changed: () => changes.push(ui.workspace.readDraft()), error: (message: string) => errors.push(message)};
    controller = installWorkspaceFileDrop(options);
    ui.workspace.resetDraft('Review OLD please');
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Pith"]')!, form = input.closest('form')!;
    input.setSelectionRange(7, 10);
    const rect = input.getBoundingClientRect();
    ui.workspace.receiveNativeDrop({paths: ['/workspace/docs/中文 draft.md', '/workspace/photo.png'], x: rect.x + 8, y: rect.y + 8});
    const transfer = new DataTransfer();
    transfer.items.add(new File(['image'], 'photo.png', {type: 'image/png'}));
    transfer.items.add(new File(['text'], '中文 draft.md', {type: 'text/markdown'}));
    form.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
    const during = {images: structuredClone(images), resolved: structuredClone(resolved), pending: [...pending]};
    release(['docs/中文 draft.md']); await new Promise(resolve => setTimeout(resolve, 0));
    const native = {draft: ui.workspace.readDraft(), cursor: input.selectionStart, pending: [...pending], changes: [...changes]};
    controller.destroy();
    controller = installWorkspaceFileDrop({...options, native: false});
    ui.workspace.resetDraft('Review ');
    const browserTransfer = new DataTransfer();
    browserTransfer.items.add(new File(['image'], 'photo.png', {type: 'image/png'}));
    browserTransfer.items.add(new File(['text'], 'README.md', {type: 'text/plain'}));
    form.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: browserTransfer}));
    await new Promise(resolve => setTimeout(resolve, 0));
    const result = {during, native, images, resolved, errors, browserDraft: ui.workspace.readDraft()};
    controller.destroy(); ui.destroy(); return result;
  });
  expect(result.during).toEqual({images: [['photo.png']], resolved: [{workspace: 'workspace', paths: ['/workspace/docs/中文 draft.md']}], pending: [true]});
  expect(result.native).toEqual({draft: 'Review `docs/中文 draft.md` please', cursor: 25, pending: [true, false], changes: ['Review `docs/中文 draft.md` please']});
  expect(result.images).toEqual([['photo.png'], ['photo.png']]);
  expect(result.resolved).toEqual([{workspace: 'workspace', paths: ['/workspace/docs/中文 draft.md']}]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('Browser preview cannot identify');
  expect(result.browserDraft).toBe('Review ');
});
