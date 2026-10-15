import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

const fixed = JSON.parse(readFileSync(new URL('../../internal/desk/testdata/state.active.json', import.meta.url), 'utf8'));

test.beforeEach(async ({page}) => {
  await page.route('**/controller-test.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><head><title>Real DOM controller regression</title></head><body></body></html>'}));
  await page.goto('/controller-test.html');
  await page.evaluate(async () => {
    // Resolve the library through Vite's normal module graph, using the app's source import.
    const source = '/src/sdk-dialog.ts';
    await import(source);
    const library = '/node_modules/pith-ui/dist/index.js';
    const {createWorkspaceShell, createSDKDialogElements} = await import(library);
    const shell = createWorkspaceShell({brand: document.createElement('span'), prefix: ''});
    document.body.append(shell.element);
    const sdk = createSDKDialogElements({idPrefix: ''}); document.body.append(sdk.dialog, sdk.oauthDialog);
  });
});

test('composer ignores an older draft after the selected conversation changes', async ({page}) => {
  const result = await page.evaluate(async fixed => {
    const path = '/src/composer.ts'; const {createComposer} = await import(path);
    const input = document.querySelector<HTMLTextAreaElement>('#composer-input')!;
    const replies: Array<{id: string; resolve: (value: unknown) => void}> = [];
    let state = structuredClone(fixed); const rendered: string[] = [];
    const composer = createComposer({
      view: {get state() {return state;}, loaded: true}, activity: {busy: false, error: ''}, input,
      request: (_path: string, {query}: {query: {id: string}}) => new Promise(resolve => replies.push({id: query.id, resolve})),
      mutate: async () => true, refresh: async () => {}, render: () => rendered.push(input.value),
      selectedWorkspace: () => state.workspaces[0], openWorkspace() {}, openSettings() {}, showDialog() {}, followLatest() {}, disposed: () => false, resizeInput() {},
    });
    composer.loadComposerDraft(); const original = state.activeId;
    state = {...state, activeId: state.conversations.find((entry: {id: string}) => entry.id !== original)!.id};
    composer.loadComposerDraft(); replies[1].resolve({text: 'current draft 中文', revision: 2});
    await new Promise(resolve => setTimeout(resolve, 0)); const count = rendered.length;
    replies[0].resolve({text: 'older draft must not replace it', revision: 1});
    await new Promise(resolve => setTimeout(resolve, 0));
    return {text: input.value, scope: composer.composerScope.id, activeId: state.activeId, readOnly: input.readOnly, count, finalCount: rendered.length};
  }, fixed);
  expect(result.text).toBe('current draft 中文');
  expect(result.scope).toBe(result.activeId);
  expect(result.readOnly).toBe(false);
  expect(result.finalCount).toBe(result.count);
});

test('a resource response cannot replace a newer history dialog', async ({page}) => {
  const result = await page.evaluate(async fixed => {
    const sdkPath = '/src/sdk-dialog.ts', resourcePath = '/src/resource-editor.ts', historyPath = '/src/history.ts';
    const [{createSDKDialog}, {createResourceUI}, {createHistoryUI}] = await Promise.all([import(sdkPath), import(resourcePath), import(historyPath)]);
    let release!: (value: {content: string}) => void;
    const state = structuredClone(fixed);
    const api = {state: () => state, mutate: async () => true, error: () => '', request: (path: string) => path === '/api/resource-content' ? new Promise(resolve => {release = resolve;}) : Promise.resolve([]), workspaceBusy: () => false, busy: () => false, refreshResources: async () => {}, confirm() {}};
    const dialog = createSDKDialog(api);
    const resource = createResourceUI(api, dialog).resource(state.workspaces[0].id, 'instructions', 'AGENTS.md');
    await createHistoryUI(api, dialog).history();
    const history = document.querySelector('#sdk-content')!.innerHTML;
    release({content: 'delayed private workspace resource'}); await resource;
    return {history, current: document.querySelector('#sdk-content')!.innerHTML};
  }, fixed);
  expect(result.history).toContain('Conversation branches');
  expect(result.current).toBe(result.history);
});

test('closing the shared dialog invalidates an in-flight history read', async ({page}) => {
  const result = await page.evaluate(async fixed => {
    const sdkPath = '/src/sdk-dialog.ts', historyPath = '/src/history.ts';
    const [{createSDKDialog}, {createHistoryUI}] = await Promise.all([import(sdkPath), import(historyPath)]);
    let release!: (value: unknown) => void;
    const api = {state: () => fixed, mutate: async () => true, error: () => '', request: () => new Promise(resolve => {release = resolve;})};
    const dialog = createSDKDialog(api); const reading = createHistoryUI(api, dialog).history();
    const native = document.querySelector<HTMLDialogElement>('#sdk-dialog')!;
    const closed = new Promise<void>(resolve => native.addEventListener('close', () => resolve(), {once:true}));
    native.close();
    release([{id: 'late-node', role: 'user', text: 'late history', active: true}]); await reading;
    await closed;
    return {content: document.querySelector('#sdk-content')!.innerHTML, open: native.open};
  }, fixed);
  expect(result.content).toBe(''); expect(result.open).toBe(false);
});
