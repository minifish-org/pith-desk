import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceBrowser} from '../src/workspace-browser.ts';
import type {Application} from '../src/ui-contract.ts';
import type {ApiRequest} from '../src/api.ts';

function harness() {
  let workspace = {id: 'first',path: '/srv/first',name: 'First'},disabled = false,referenceDisabled = false,open = false,cleared = 0,changed = 0;
  const states: Array<any> = [],reads: Array<{query: any;signal: AbortSignal;resolve(value: unknown): void}> = [],inserted: string[][] = [],actions: unknown[] = [];
  const browser = createWorkspaceBrowser({
    ui: {files: {areToolsOpen: () => open,closeToolsOverlay() {}},workspace: {insertReferences(paths) {inserted.push([...paths]);},focusComposer() {}}} as Application,
    view: {update(state) {states.push(state);}},visible: () => open,
    request: ((_: string,options: any) => new Promise(resolve => {reads.push({...options,resolve});})) as ApiRequest,
    workspace: () => workspace,disabled: () => disabled,referenceDisabled: () => referenceDisabled,server: true,native: false,
    clearPreview() {cleared++;},changedDraft() {changed++;},async fileAction(action,target) {actions.push({action,target});},
  });
  return {browser,states,reads,inserted,actions,get cleared() {return cleared;},get changed() {return changed;},set workspace(value: typeof workspace) {workspace = value;},set disabled(value: boolean) {disabled = value;},set referenceDisabled(value: boolean) {referenceDisabled = value;},open() {open = true;browser.sync();}};
}
const tick = () => new Promise(resolve => setTimeout(resolve,0));
const listing = (path: string,directory = false) => ({entries: [{name: path,path,directory}],truncated: false});

test('opening is lazy; workspace switches abort old listings and ignore late same-ID responses',async () => {
  const h = harness();h.browser.sync();assert.equal(h.reads.length,0);h.open();assert.equal(h.reads.length,1);
  h.workspace = {id: 'second',path: '/srv/second',name: 'Second'};h.browser.sync();assert.equal(h.reads[0]!.signal.aborted,true);
  h.workspace = {id: 'first',path: '/srv/first',name: 'First'};h.browser.sync();
  h.reads[2]!.resolve(listing('current.txt'));await tick();
  h.reads[0]!.resolve(listing('late.txt'));h.reads[1]!.resolve(listing('second.txt'));await tick();
  assert.deepEqual(h.states.at(-1).directories[0].entries.map((entry: any) => entry.path),['current.txt']);
  h.browser.destroy();
});

test('reference inserts only into the current editable draft, never submits, and lease retirement stops all actions',async () => {
  const h = harness();h.open();h.reads[0]!.resolve(listing('中文 `draft`.md'));await tick();
  const target = {workspaceId: 'first',path: '中文 `draft`.md'};
  await h.browser.action('reference',target);assert.deepEqual(h.inserted,[['中文 `draft`.md']]);assert.equal(h.changed,1);assert.deepEqual(h.actions,[]);
  h.referenceDisabled = true;await h.browser.action('reference',target);assert.equal(h.changed,1);
  h.referenceDisabled = false;h.workspace = {id: 'second',path: '/srv/second',name: 'Second'};
  await h.browser.action('reference',target);assert.equal(h.changed,1);
  h.browser.sync();h.disabled = true;await h.browser.action('download',{workspaceId: 'second',path: 'file'});assert.deepEqual(h.actions,[]);
  h.browser.destroy();h.reads[1]!.resolve(listing('retired.txt'));await tick();
  await h.browser.action('preview',target);assert.deepEqual(h.actions,[]);
});

test('refresh retires removed directories and a workspace switch cannot continue the old refresh',async () => {
  const h = harness();h.open();h.reads[0]!.resolve(listing('docs',true));await tick();
  h.browser.toggle({workspaceId: 'first',path: 'docs'},true);h.reads[1]!.resolve(listing('docs/a.txt'));await tick();
  const refreshing = h.browser.refresh();assert.equal(h.reads.length,3);
  h.workspace = {id: 'second',path: '/srv/second',name: 'Second'};h.browser.sync();
  h.reads[2]!.resolve(listing('docs',true));await refreshing;
  assert.equal(h.reads.length,4);assert.equal(h.reads[3]!.query.workspaceId,'second');assert.equal(h.reads[3]!.query.path,'');
  h.browser.destroy();
});

test('a collapsed folder whose pending read was retired by refresh can load again',async () => {
  const h = harness();h.open();h.reads[0]!.resolve(listing('docs',true));await tick();
  const target = {workspaceId: 'first',path: 'docs'};
  h.browser.toggle(target,true);h.browser.toggle(target,false);
  const refreshing = h.browser.refresh();assert.equal(h.reads[1]!.signal.aborted,true);
  h.reads[2]!.resolve(listing('docs',true));await refreshing;
  h.browser.toggle(target,true);assert.equal(h.reads.length,4);
  h.reads[3]!.resolve(listing('docs/current.txt'));h.reads[1]!.resolve(listing('docs/retired.txt'));await tick();
  assert.deepEqual(h.states.at(-1).directories.find((entry: any) => entry.path === 'docs').entries.map((entry: any) => entry.path),['docs/current.txt']);
  h.browser.destroy();
});
