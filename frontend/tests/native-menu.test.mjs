import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeMenu } from '../src/native-menu.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(native, request = async () => ({ ok: true })) {
  class HostEvents extends EventTarget {
    listeners = new Set();
    addEventListener(type, listener, options) { super.addEventListener(type, listener, options); this.listeners.add(listener); }
    removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); this.listeners.delete(listener); }
  }
  globalThis.window = new HostEvents();
  globalThis.document = new HostEvents();
  const context = { ready: true, busy: false, modal: false, workspaceId: 'workspace', activeId: 'chat' };
  const actions = [], requests = [];
  let canExport = true;
  const controller = installNativeMenu({
    native, context: () => context, canExport: () => canExport,
    request: (path, input) => { requests.push({ path, input }); return request(path, input); },
    actions: {
      newConversation: () => { actions.push('new'); }, chooseWorkspace: () => { actions.push('workspace'); },
      exportConversation: () => { actions.push('export'); }, settings: () => { actions.push('settings'); },
    },
  });
  return {
    controller, context, actions, requests,
    modal: (value) => { context.modal = value; controller.update(); },
    canExport: (value) => { canExport = value; },
    nativeAction: (action) => { const event = new Event('pith:native-menu'); event.detail = { action }; window.dispatchEvent(event); },
    key: (options = {}) => { const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: 'n', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false }, options); document.dispatchEvent(event); return event; },
  };
}

test('native shortcuts use one platform event and check the live page state', async () => {
  const ui = harness(true);
  ui.key();
  assert.deepEqual(ui.actions, []);
  ui.nativeAction('new-conversation');
  ui.context.busy = true;
  ui.nativeAction('new-conversation');
  ui.nativeAction('settings');
  ui.context.busy = false;
  ui.modal(true);
  ui.nativeAction('choose-workspace');
  ui.modal(false);
  ui.context.ready = false;
  ui.nativeAction('settings');
  ui.context.ready = true;
  ui.nativeAction('unexpected');
  assert.deepEqual(ui.actions, ['new']);
  await settle();
  ui.controller.dispose();
});

test('export verifies the currently selected conversation again', () => {
  const ui = harness(true);
  ui.canExport(false);
  ui.nativeAction('export-conversation');
  ui.canExport(true);
  ui.context.activeId = null;
  ui.nativeAction('export-conversation');
  ui.context.activeId = 'done';
  ui.nativeAction('export-conversation');
  assert.deepEqual(ui.actions, ['export']);
  ui.controller.dispose();
});

test('browser keeps New Conversation without consuming modifier variants or composition', () => {
  const ui = harness(false);
  for (const variant of [{ repeat: true }, { isComposing: true }, { shiftKey: true }, { altKey: true }, { metaKey: false }]) {
    assert.equal(ui.key(variant).defaultPrevented, false);
  }
  assert.equal(ui.key({ metaKey: false, ctrlKey: true }).defaultPrevented, true);
  ui.modal(true);
  ui.key();
  assert.deepEqual(ui.actions, ['new']);
  assert.deepEqual(ui.requests, []);
  ui.nativeAction('settings');
  assert.deepEqual(ui.actions, ['new']);
  ui.controller.dispose();
});

test('menu synchronization serializes requests and sends only the latest queued state', async () => {
  const finish = [];
  const ui = harness(true, () => new Promise((resolve) => finish.push(resolve)));
  assert.equal(ui.requests.length, 1);
  ui.context.busy = true;
  ui.controller.update();
  ui.context.busy = false;
  ui.modal(true);
  assert.equal(ui.requests.length, 1);
  finish.shift()({ ok: true });
  await settle();
  assert.equal(ui.requests.length, 2);
  assert.deepEqual(ui.requests[1].input, { ready: true, busy: false, modal: true, workspaceId: 'workspace', activeId: 'chat' });
  finish.shift()({ ok: true });
  await settle();
  ui.controller.update();
  assert.equal(ui.requests.length, 2);
  ui.controller.dispose();
  assert.equal(window.listeners.size, 0);
  assert.equal(document.listeners.size, 0);
  ui.nativeAction('new-conversation');
  ui.context.busy = true;
  ui.controller.update();
  assert.deepEqual(ui.actions, []);
  assert.equal(ui.requests.length, 2);
});
