import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkspaceFileDrop, localFileURIs } from '../src/workspace-files.ts';

// Reference insertion, CommonMark round trips and MIME classification now run
// against the installed application in e2e/references-parity.spec.ts.

test('browser URI extraction never treats a basename or remote URL as a local identity', () => {
  assert.deepEqual(localFileURIs('# comment\nfile:///workspace/%E4%B8%AD%E6%96%87%20file.md\nREADME.md\nhttps://example.com/file.md\nfile://remote/workspace/file.md'), ['file:///workspace/%E4%B8%AD%E6%96%87%20file.md']);
});

function harness(native, resolve = async () => ['docs/中文 draft.md']) {
  const inserted = [], errors = [], resolved = [], changes = [], pending = [], events = [];
  let context = 'workspace/chat/1';
  const controller = installWorkspaceFileDrop({
    ui: { workspace: {
      setDropPending: value => { pending.push(value); events.push({ kind: 'scene-pending', value }); },
      insertReferences: paths => { inserted.push(paths); events.push({ kind: 'insert', paths }); },
    } },
    native, busy: () => false, context: () => context, workspaceID: () => 'workspace', disposed: () => false,
    resolve: async (workspace, paths) => { resolved.push({ workspace, paths }); return resolve(); },
    pending: value => events.push({ kind: 'host-pending', value }),
    changed: () => changes.push(inserted.at(-1)), error: message => errors.push(message),
  });
  return { inserted, errors, resolved, changes, pending, events, references: controller.references, destroy: controller.destroy, context: value => { context = value; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Native hit testing, mixed image delivery and selection insertion are exercised
// with the installed application in e2e/feature-controllers.spec.ts. The host
// does not duplicate the scene's DOM routing or its draft editing implementation.
test('native mixed reference intents resolve only workspace file paths', async () => {
  const ui = harness(true);
  ui.references({ paths: ['/workspace/photo.png', '/workspace/docs/中文 draft.md'], hasUnidentifiedFiles: false });
  await settle();
  assert.deepEqual(ui.resolved, [{ workspace: 'workspace', paths: ['/workspace/docs/中文 draft.md'] }]);
  assert.deepEqual(ui.inserted, [['docs/中文 draft.md']]);
  assert.deepEqual(ui.changes, [['docs/中文 draft.md']]);
  assert.deepEqual(ui.events, [
    { kind: 'scene-pending', value: true }, { kind: 'host-pending', value: true },
    { kind: 'scene-pending', value: false }, { kind: 'host-pending', value: false },
    { kind: 'insert', paths: ['docs/中文 draft.md'] },
  ]);
  assert.deepEqual(ui.errors, []);
});

test('browser unidentified reference intent asks for a relative path instead of guessing File.name', async () => {
  const ui = harness(false);
  ui.references({ paths: [], hasUnidentifiedFiles: true });
  await settle();
  assert.deepEqual(ui.resolved, []);
  assert.deepEqual(ui.inserted, []);
  assert.match(ui.errors[0], /Browser preview cannot identify/);
});

test('browser complete local file URI is validated by the host', async () => {
  const ui = harness(false);
  ui.references({ paths: [], uris: 'file:///workspace/docs/%E4%B8%AD%E6%96%87%20draft.md', hasUnidentifiedFiles: false });
  await settle();
  assert.deepEqual(ui.resolved, [{ workspace: 'workspace', paths: ['file:///workspace/docs/%E4%B8%AD%E6%96%87%20draft.md'] }]);
  assert.deepEqual(ui.inserted, [['docs/中文 draft.md']]);
});

test('late path validation never inserts into a different workspace or conversation', async () => {
  let finish;
  const ui = harness(true, () => new Promise((resolve) => { finish = resolve; }));
  ui.references({ paths: ['/workspace/file.md'], hasUnidentifiedFiles: false });
  ui.context('other-workspace/chat/2');
  finish(['file.md']);
  await settle();
  assert.deepEqual(ui.inserted, []);
  assert.deepEqual(ui.changes, []);
  assert.deepEqual(ui.pending, [true, false]);
});
