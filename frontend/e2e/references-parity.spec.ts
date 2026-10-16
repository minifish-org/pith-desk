import {test, expect} from '@playwright/test';
import {marked} from 'marked';
import type {Application} from 'pith-ui/app';

type ReferenceFixture = {ui: Application};

test.beforeEach(async ({page}) => {
  await page.route('**/references-parity.html', route => route.fulfill({contentType: 'text/html', body: '<!doctype html><html><body><div id="app"></div></body></html>'}));
  await page.goto('/references-parity.html');
  await page.evaluate(async () => {
    const library = '/node_modules/pith-ui/dist/app/index.js', styles = '/node_modules/pith-ui/dist/styles.css';
    const [{createApplication}] = await Promise.all([import(library), import(styles)]);
    const ui = createApplication(document.getElementById('app')!);
    (window as unknown as {referenceFixture: ReferenceFixture}).referenceFixture = {ui};
  });
});

test('references remain editable, preserve spaces and Chinese, and replace the selection', async ({page}) => {
  const result = await page.evaluate(() => {
    const {ui} = (window as unknown as {referenceFixture: ReferenceFixture}).referenceFixture;
    ui.workspace.resetDraft('Review OLD please');
    const input = document.querySelector<HTMLTextAreaElement>('textarea[id$="composer-input"]')!;
    input.setSelectionRange(7, 10);
    ui.workspace.insertReferences(['README.md', 'docs/中文 draft.md', 'quote".txt']);
    const result = {value: ui.workspace.readDraft(), cursor: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input};
    ui.destroy(); return result;
  });
  expect(result).toEqual({value: 'Review `README.md` `docs/中文 draft.md` `quote".txt` please', cursor: 50, end: 50, focused: true});
});

test('Markdown reference round trips backticks and edge spaces without changing the path', async ({page}) => {
  const paths = ['README.md', 'docs/中文 draft.md', 'tick`file.md', '`edge`', 'a``b`file.txt', ' leading.md', 'trailing.md ', '   '];
  const references = await page.evaluate(paths => {
    const {ui} = (window as unknown as {referenceFixture: ReferenceFixture}).referenceFixture;
    const input = document.querySelector<HTMLTextAreaElement>('textarea[id$="composer-input"]')!;
    const result = paths.map(path => {
      ui.workspace.resetDraft(''); ui.workspace.insertReferences([path]);
      return {path, draft: ui.workspace.readDraft(), start: input.selectionStart, end: input.selectionEnd};
    });
    ui.destroy(); return result;
  }, paths);
  for (const reference of references) {
    const tokens = marked.lexer(reference.draft);
    expect(tokens[0].type).toBe('paragraph');
    const inline = tokens[0].type === 'paragraph' ? tokens[0].tokens[0] : undefined;
    expect(inline?.type).toBe('codespan');
    expect(inline && 'text' in inline ? inline.text : undefined, reference.path).toBe(reference.path);
    expect(reference.start).toBe(reference.draft.length);
    expect(reference.end).toBe(reference.draft.length);
  }
});

test('real DOM drops classify empty-MIME PNG and JPEG as images while SVG remains a reference intent', async ({page}) => {
  const result = await page.evaluate(async () => {
    const library = '/node_modules/pith-ui/dist/app/index.js'; const {createApplication} = await import(library);
    (window as unknown as {referenceFixture: ReferenceFixture}).referenceFixture.ui.destroy();
    const images: Array<Array<{name: string; type: string}>> = [], references: Array<{paths: readonly string[]; uris?: string}> = [];
    const ui = createApplication(document.getElementById('app')!, {workspace: {
      onImages: (files: File[]) => images.push(files.map(file => ({name: file.name, type: file.type}))),
      onDropReferences: (input: {paths: readonly string[]; uris?: string}) => references.push(input),
    }});
    const form = document.querySelector<HTMLTextAreaElement>('textarea[id$="composer-input"]')!.closest('form')!;
    for (const value of [{name: 'PHOTO.PNG', type: ''}, {name: 'photo', type: 'image/jpeg'}, {name: 'icon.svg', type: 'image/svg+xml'}]) {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], value.name, {type: value.type}));
      form.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
    }
    const result = {images, references: references.map(input => ({paths: input.paths, uris: input.uris}))};
    ui.destroy(); return result;
  });
  expect(result).toEqual({images: [[{name: 'PHOTO.PNG', type: ''}], [{name: 'photo', type: 'image/jpeg'}]], references: [{paths: [], uris: ''}]});
});
