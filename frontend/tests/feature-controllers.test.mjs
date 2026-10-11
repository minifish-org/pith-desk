import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComposer } from '../src/composer.ts';
import { createSDKDialog } from '../src/sdk-dialog.ts';
import { createResourceUI } from '../src/resource-editor.ts';
import { createHistoryUI } from '../src/history.ts';

const fixed = JSON.parse(readFileSync(new URL('../../internal/desk/testdata/state.active.json', import.meta.url), 'utf8'));
const turn = () => new Promise(setImmediate);
function elements(t) {
  const nodes = new Map();
  const previous = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (!nodes.has(id)) {
        const handlers = new Map();
        nodes.set(id, { innerHTML: '', open: false, value: '', style: {}, scrollHeight: 20,
          addEventListener: (event, handler) => handlers.set(event, handler),
          showModal() { this.open = true; },
          close() { this.open = false; handlers.get('close')?.(); },
        });
      }
      return nodes.get(id);
    },
  };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  return document.getElementById;
}

test('composer ignores an older draft after the selected conversation changes', async (t) => {
  // The fixture State is read unchanged; only the independently held view changes.
  const nodes = elements(t), input = nodes('composer-input');
  const replies = [];
  let state = structuredClone(fixed);
  const rendered = [];
  const composer = createComposer({
    view: { get state() { return state; }, loaded: true },
    activity: { busy: false, error: '' }, input,
    request: (_path, { query }) => new Promise(resolve => replies.push({ id: query.id, resolve })),
    mutate: async () => true, refresh: async () => {}, render: () => rendered.push(input.value),
    selectedWorkspace: () => state.workspaces[0], openWorkspace() {}, openSettings() {},
    showDialog() {}, followLatest() {}, disposed: () => false,
  });
  composer.loadComposerDraft();
  const original = state.activeId;
  state = { ...state, activeId: state.conversations.find(entry => entry.id !== original).id };
  composer.loadComposerDraft();
  replies[1].resolve({ text: 'current draft 中文', revision: 2 });
  await turn();
  const count = rendered.length;
  replies[0].resolve({ text: 'older draft must not replace it', revision: 1 });
  await turn();
  assert.equal(input.value, 'current draft 中文');
  assert.equal(composer.composerScope.id, state.activeId);
  assert.equal(input.readOnly, false);
  assert.equal(rendered.length, count);
});

test('a resource response cannot replace a newer history dialog', async (t) => {
  const nodes = elements(t);
  let release;
  const state = structuredClone(fixed);
  const api = {
    state: () => state, mutate: async () => true, error: () => '',
    request: path => path === '/api/resource-content' ? new Promise(resolve => { release = resolve; }) : Promise.resolve([]),
    workspaceBusy: () => false, busy: () => false, refreshResources: async () => {}, confirm() {},
  };
  const dialog = createSDKDialog(api);
  const resource = createResourceUI(api, dialog).resource(state.workspaces[0].id, 'instructions', 'AGENTS.md');
  await createHistoryUI(api, dialog).history();
  const history = nodes('sdk-content').innerHTML;
  release({ content: 'delayed private workspace resource' });
  await resource;
  assert.match(history, /Conversation branches/);
  assert.equal(nodes('sdk-content').innerHTML, history);
});

test('closing the shared dialog invalidates an in-flight history read', async (t) => {
  const nodes = elements(t);
  let release;
  const api = { state: () => fixed, mutate: async () => true, error: () => '', request: () => new Promise(resolve => { release = resolve; }) };
  const dialog = createSDKDialog(api);
  const reading = createHistoryUI(api, dialog).history();
  nodes('sdk-dialog').close();
  release([{ id: 'late-node', role: 'user', text: 'late history', active: true }]);
  await reading;
  assert.equal(nodes('sdk-content').innerHTML, '');
  assert.equal(nodes('sdk-dialog').open, false);
});
