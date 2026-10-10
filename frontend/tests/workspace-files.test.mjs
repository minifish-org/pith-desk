import test from 'node:test';
import assert from 'node:assert/strict';
import { insertWorkspaceReferences, installWorkspaceFileDrop, isImageFile, localFileURIs, formatWorkspaceReference } from '../src/workspace-files.ts';
import { marked } from 'marked';

test('references remain editable, preserve spaces and Chinese, and replace the selection', () => {
  assert.deepEqual(insertWorkspaceReferences('Review OLD please', 7, 10, ['README.md', 'docs/中文 draft.md', 'quote".txt']), {
    value: 'Review `README.md` `docs/中文 draft.md` `quote".txt` please', cursor: 50,
  });
});

test('Markdown reference round trips backticks and edge spaces without changing the path', () => {
  for (const path of ['README.md', 'docs/中文 draft.md', 'tick`file.md', '`edge`', 'a``b`file.txt', ' leading.md', 'trailing.md ', '   ']) {
    const tokens = marked.lexer(formatWorkspaceReference(path));
    assert.equal(tokens[0].tokens[0].type, 'codespan');
    assert.equal(tokens[0].tokens[0].text, path);
  }
});

test('browser URI extraction never treats a basename or remote URL as a local identity', () => {
  assert.deepEqual(localFileURIs('# comment\nfile:///workspace/%E4%B8%AD%E6%96%87%20file.md\nREADME.md\nhttps://example.com/file.md\nfile://remote/workspace/file.md'), ['file:///workspace/%E4%B8%AD%E6%96%87%20file.md']);
  assert.equal(isImageFile({ name: 'PHOTO.PNG', type: '' }), true);
  assert.equal(isImageFile({ name: 'photo', type: 'image/jpeg' }), true);
  assert.equal(isImageFile({ name: 'icon.svg', type: 'image/svg+xml' }), false);
});

function harness(native, resolve = async () => ['docs/中文 draft.md']) {
  globalThis.window = new EventTarget();
  const form = new EventTarget();
  form.classList = { add() {}, remove() {} };
  const inside = {};
  form.contains = (target) => target === inside;
  globalThis.document = { elementFromPoint: (x, y) => x === 5 && y === 8 ? inside : {} };
  const input = { value: 'Review ', selectionStart: 7, selectionEnd: 7, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, focus() {} };
  const images = [], errors = [], resolved = [], changes = [];
  let context = 'workspace/chat/1';
  installWorkspaceFileDrop({
    form, input, native, busy: () => false, context: () => context, workspaceID: () => 'workspace', disposed: () => false,
    resolve: async (workspace, paths) => { resolved.push({ workspace, paths }); return resolve(); },
    images: async (files) => { images.push(...files); }, pending() {}, changed: () => changes.push(input.value), error: (message) => errors.push(message),
  });
  return { input, images, errors, resolved, changes, context: (value) => { context = value; },
    drop: (files, uris = '') => { const event = new Event('drop', { cancelable: true }); event.dataTransfer = { files, getData: () => uris }; form.dispatchEvent(event); },
    nativeDrop: (paths, x = 5, y = 8) => { const event = new Event('pith:file-drop'); event.detail = { paths, x, y }; window.dispatchEvent(event); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('native mixed drops preserve image attachment and resolve only workspace file paths', async () => {
  const ui = harness(true);
  const image = { name: 'photo.png', type: 'image/png' };
  ui.drop([image, { name: '中文 draft.md', type: 'text/markdown' }]);
  ui.nativeDrop(['/workspace/photo.png', '/workspace/docs/中文 draft.md']);
  await settle();
  assert.deepEqual(ui.images, [image]);
  assert.deepEqual(ui.resolved, [{ workspace: 'workspace', paths: ['/workspace/docs/中文 draft.md'] }]);
  assert.equal(ui.input.value, 'Review `docs/中文 draft.md`');
  assert.deepEqual(ui.errors, []);
});

test('native drops outside composer do not insert paths', async () => {
  const ui = harness(true);
  ui.nativeDrop(['/workspace/file.md'], 30, 30);
  await settle();
  assert.deepEqual(ui.resolved, []);
});

test('image attachments still arrive when native paths begin resolving before the DOM drop', async () => {
  let finish;
  const ui = harness(true, () => new Promise((resolve) => { finish = resolve; }));
  const image = { name: 'photo.png', type: 'image/png' };
  ui.nativeDrop(['/workspace/docs/中文 draft.md', '/workspace/photo.png']);
  ui.drop([image, { name: '中文 draft.md', type: 'text/markdown' }]);
  assert.deepEqual(ui.images, [image]);
  finish(['docs/中文 draft.md']);
  await settle();
  assert.equal(ui.input.value, 'Review `docs/中文 draft.md`');
});

test('browser mixed drop keeps image and asks for a relative path instead of guessing File.name', async () => {
  const ui = harness(false);
  ui.drop([{ name: 'photo.png', type: 'image/png' }, { name: 'README.md', type: 'text/plain' }]);
  await settle();
  assert.equal(ui.images.length, 1);
  assert.deepEqual(ui.resolved, []);
  assert.match(ui.errors[0], /Browser preview cannot identify/);
});

test('browser complete local file URI is validated by the host', async () => {
  const ui = harness(false);
  ui.drop([{ name: '中文 draft.md', type: 'text/markdown' }], 'file:///workspace/docs/%E4%B8%AD%E6%96%87%20draft.md');
  await settle();
  assert.equal(ui.resolved[0].paths[0], 'file:///workspace/docs/%E4%B8%AD%E6%96%87%20draft.md');
  assert.equal(ui.input.value, 'Review `docs/中文 draft.md`');
});

test('late path validation never inserts into a different workspace or conversation', async () => {
  let finish;
  const ui = harness(true, () => new Promise((resolve) => { finish = resolve; }));
  ui.nativeDrop(['/workspace/file.md']);
  ui.context('other-workspace/chat/2');
  finish(['file.md']);
  await settle();
  assert.equal(ui.input.value, 'Review ');
  assert.deepEqual(ui.changes, []);
});
