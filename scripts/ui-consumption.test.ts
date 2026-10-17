import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkUIConsumption, readConsumptionInput } from './ui-consumption.ts';

const version = '0.4.1';
const integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
const packageJSON = {
  name: 'pith-desk-frontend', private: true, type: 'module',
  dependencies: { 'pith-ui': version },
};
const packageLock = {
  name: 'pith-desk-frontend', lockfileVersion: 3,
  packages: {
    '': { dependencies: { 'pith-ui': version } },
    'node_modules/pith-ui': {
      version, resolved: `https://registry.npmjs.org/pith-ui/-/pith-ui-${version}.tgz`, integrity,
    },
  },
};
const installedPackage = {
  name: 'pith-ui', version,
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './styles.css': './dist/styles.css',
  },
};
const baselineFiles: Record<string, string> = {
  'frontend/package.json': JSON.stringify(packageJSON),
  'frontend/package-lock.json': JSON.stringify(packageLock),
  'frontend/node_modules/pith-ui/package.json': JSON.stringify(installedPackage),
  'frontend/index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Pith Desk</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
  'frontend/src/style.css': '@import "pith-ui/styles.css";\n',
  'frontend/src/main.ts': "import type {MountState as ApplicationState} from 'pith-ui';\nexport const snapshot: ApplicationState | undefined = undefined;\n",
};

function inspect(files: Record<string, string> = {}, symlinks: string[] = []) {
  return checkUIConsumption({ files: { ...baselineFiles, ...files }, symlinks });
}
function source(text: string, path = 'frontend/src/feature.ts') {
  return inspect({ [path]: text });
}
function rejected(text: string, path = 'frontend/src/feature.ts') {
  const issues = source(text, path);
  assert.ok(issues.length > 0, `Expected UI consumption rejection for ${path}:\n${text}`);
}

const mountModule = `
  import {mount} from 'pith-ui';
  import type {ApplicationOptions} from './ui-types';
  import {createDeskComposition} from './ui-view';
  export function mountApplication(options: ApplicationOptions = {}) {
    const root = document.getElementById('app');
    if (!(root instanceof HTMLElement)) throw new Error('Application mount is missing.');
    const composition = createDeskComposition(options);
    const mounted = mount(root, composition.content, {appearance: options.appearance, viewport: 'window', onStateChange: options.onUIStateChange});
    return composition.connect(mounted);
  }
`;

const bootstrapModule = `
  type BootstrapMeta = 'desk-token' | 'desk-native-clipboard' | 'desk-native-file-drop' | 'desk-native-menus';
  export function readAppBootstrap(document: Document) {
    const consume = (name: BootstrapMeta): string => {
      const meta = document.querySelector<HTMLMetaElement>(\`meta[name="\${name}"]\`);
      const value = meta?.content ?? '';
      meta?.remove();
      return value;
    };
    const token = consume('desk-token');
    return {
      token: token === '__DESK_TOKEN__' ? '' : token,
      nativeClipboard: consume('desk-native-clipboard') === 'true',
      nativeFileDrop: consume('desk-native-file-drop') === 'true',
      nativeMenus: consume('desk-native-menus') === 'true',
      appearance: document.documentElement.dataset.appearance,
    };
  }
`;

const nativeModule = `
  interface NativeDrop { paths: string[]; x: number; y: number }
  function readNativeDrop(input: unknown): NativeDrop | undefined {
    if (!input || typeof input !== 'object') return;
    const value = input as Record<string, unknown>;
    if (!Array.isArray(value.paths) || !value.paths.every(path => typeof path === 'string')) return;
    if (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)) return;
    return { paths: value.paths, x: value.x, y: value.y };
  }
  export function installNativeIngress(onDrop: (value: NativeDrop) => void, onFocus: () => void) {
    const onNativeDrop = (event: Event) => {
      const detail = readNativeDrop((event as CustomEvent<unknown>).detail);
      if (detail) onDrop({ paths: detail.paths, x: detail.x, y: detail.y });
    };
    const onVisibility = () => { if (document.visibilityState === 'visible' && document.hasFocus()) onFocus(); };
    window.addEventListener('pith:file-drop', onNativeDrop);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pith:file-drop', onNativeDrop);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }
`;

test('only the named mount module may obtain app, check its HTMLElement type and pass it to createApplication', () => {
  assert.deepEqual(source(mountModule, 'frontend/src/ui-mount.ts'), []);
  rejected(mountModule, 'frontend/src/feature.ts');
});

test('the mount exception rejects altered lookup, missing type checks and mount leakage', () => {
  for (const text of [
    mountModule.replace("getElementById('app')", "getElementById('other')"),
    mountModule.replace("document.getElementById('app')", "document.querySelector('#app')"),
    mountModule.replace("if (!(root instanceof HTMLElement)) throw new Error('Application mount is missing.');", ''),
    mountModule.replace('return composition.connect(mounted);', 'return root;'),
    mountModule.replace('return composition.connect(mounted);', 'exportedRoot = root; return composition.connect(mounted);'),
    mountModule.replace('return composition.connect(mounted);', 'root.style.padding = "8px"; return composition.connect(mounted);'),
    mountModule.replace('return composition.connect(mounted);', 'root.replaceChildren(); return composition.connect(mounted);'),
    mountModule + "\ndocument.querySelector('dialog');",
    mountModule + "\ndocument.createElement('button');",
  ]) rejected(text, 'frontend/src/ui-mount.ts');
});

test('the mounting function cannot add rendering or node slots to the app options', () => {
  for (const options of ['{ ...options, renderHeader: () => "header" }', '{ ...options, children: root }', '{ ...options, style: { padding: 8 } }']) {
    rejected(mountModule.replace('createDeskComposition(options)', `createDeskComposition(${options})`), 'frontend/src/ui-mount.ts');
  }
});

test('the named bootstrap may read and remove exactly the four host meta values and read the initial appearance', () => {
  assert.deepEqual(source(bootstrapModule, 'frontend/src/ui-bootstrap.ts'), []);
  rejected(bootstrapModule, 'frontend/src/feature.ts');
});

test('the bootstrap exception is limited to the four consumed meta nodes and read-only appearance', () => {
  for (const text of [
    bootstrapModule.replace("consume('desk-token')", "consume('other-token')"),
    bootstrapModule.replace('meta?.remove();', 'meta?.remove(); meta?.setAttribute("class", "pui-extra");'),
    bootstrapModule.replace('meta?.remove();', 'meta?.remove(); if (meta) meta.innerHTML = "hello";'),
    bootstrapModule.replace('meta?.remove();', 'meta?.parentElement?.remove();'),
    bootstrapModule.replace('appearance: document.documentElement.dataset.appearance,', 'appearance: (document.documentElement.dataset.appearance = "dark"),'),
    bootstrapModule.replace('dataset.appearance', 'dataset.arbitrary'),
    bootstrapModule + "\ndocument.querySelector('dialog');",
    bootstrapModule + "\ndocument.documentElement.classList.add('dark');",
    bootstrapModule + "\ndocument.documentElement.style.colorScheme = 'dark';",
  ]) rejected(text, 'frontend/src/ui-bootstrap.ts');
});

test('brand configuration is semantic static-asset data and creates no consumer nodes', () => {
  assert.deepEqual(source(`
    export const brand = { src: '/brand/pith.svg', alt: 'Pith logo', name: 'Pith', qualifier: 'Desk' };
  `), []);
  rejected("const logo = document.createElement('img'); logo.src = '/brand/pith.svg';", 'frontend/src/ui-mount.ts');
  rejected("const logo = new Image(); logo.src = '/brand/pith.svg';");
});

test('only the finite native modules may register global events, read visibility/focus and forward validated drop data', () => {
  for (const path of ['frontend/src/ui-native.ts', 'frontend/src/native-menu.ts', 'frontend/src/app-lifecycle.ts']) {
    assert.deepEqual(source(nativeModule, path), [], path);
  }
  rejected(nativeModule, 'frontend/src/feature.ts');
});

test('a native module is not exempt from selector, observer, point lookup, node, style or anchor checks', () => {
  for (const suffix of [
    "document.querySelector('dialog[open]');",
    'document.elementFromPoint(1, 2);',
    'new MutationObserver(() => {});',
    "document.createElement('a');",
    "document.body.append('text');",
    'document.body.replaceChildren();',
    "document.body.style.padding = '8px';",
    "window.document.querySelector('.pui');",
    "const doc = document; doc['query' + 'Selector']('dialog');",
    "const root = document.body; root.classList.add('active');",
  ]) {
    for (const path of ['frontend/src/ui-native.ts', 'frontend/src/native-menu.ts', 'frontend/src/app-lifecycle.ts']) {
      rejected(nativeModule + '\n' + suffix, path);
    }
  }
});

test('native event detail cannot escape validation or forward a target node as a UI slot', () => {
  rejected(nativeModule.replace('readNativeDrop((event as CustomEvent<unknown>).detail)', '(event as CustomEvent<NativeDrop>).detail'), 'frontend/src/ui-native.ts');
  rejected(nativeModule.replace('onDrop({ paths: detail.paths, x: detail.x, y: detail.y })', 'onDrop({ paths: detail.paths, x: detail.x, y: detail.y, target: event.target })'), 'frontend/src/ui-native.ts');
});

test('the draft flush lifecycle retains its guarded saved-result callback protocol', () => {
  assert.deepEqual(source(`
    export function installAppLifecycle(flushDrafts: () => Promise<boolean>) {
      const onFlush = (event: Event) => {
        const callback = (event as CustomEvent<unknown>).detail;
        if (typeof callback !== 'function') return;
        event.preventDefault();
        void flushDrafts().then(callback, () => callback(false));
      };
      window.addEventListener('pith:flush-drafts', onFlush);
      return () => window.removeEventListener('pith:flush-drafts', onFlush);
    }
  `, 'frontend/src/app-lifecycle.ts'), []);
});

test('the native menu retains its guarded finite action protocol without querying UI nodes', () => {
  assert.deepEqual(source(`
    export function installNativeMenu(dispatch: (action: string) => void) {
      const onNative = (event: Event) => {
        const detail = (event as CustomEvent<unknown>).detail;
        if (!detail || typeof detail !== 'object' || !('action' in detail)) return;
        const action = detail.action;
        if (action === 'new-conversation' || action === 'choose-workspace' || action === 'export-conversation' || action === 'settings' || action === 'check-updates') dispatch(action);
      };
      window.addEventListener('pith:native-menu', onNative);
      return () => window.removeEventListener('pith:native-menu', onNative);
    }
  `, 'frontend/src/native-menu.ts'), []);
});

test('computed global capabilities and standalone global aliases cannot supply DOM access', () => {
  for (const text of [
    "const key = 'document'; globalThis[key].createElement('button');",
    "const global = globalThis; global.document.createElement('button');",
    "const key = 'document'; const { [key]: doc } = globalThis; doc.createElement('button');",
  ]) rejected(text);
});

test('a semantic application handle cannot recover style or internal nodes through a mounting alias', () => {
  for (const suffix of ['app.style.padding = "8px"', 'app.element', "app.part('messages')"]) {
    const issues = source(`import { mountApplication } from './ui-mount'; const app = mountApplication(options); ${suffix};`);
    assert.ok(issues.some(issue => issue.code === 'internal'), suffix);
  }
});

test('namespace and dynamic app factories cannot bypass the single mount adapter', () => {
  for (const text of [
    "import * as ui from 'pith-ui/app'; const app = ui.createApplication(undefined as any, {}); app.element;",
    "const ui = await import('pith-ui/app'); const create = ui.createApplication; create(undefined as any, {});",
  ]) rejected(text);
});

test('the published custom model defaults helper is pure data through named, alias and namespace imports', () => {
  for (const text of [
    "import {customModelDefaults} from 'pith-ui'; export const model = customModelDefaults();",
    "import {customModelDefaults as defaults} from 'pith-ui'; export const model = defaults();",
    "import * as ui from 'pith-ui'; export const model = ui.customModelDefaults();",
  ]) assert.deepEqual(source(text), []);
});

test('an application factory cannot impersonate the pure custom model defaults helper', () => {
  for (const text of [
    "import {createApplication as customModelDefaults} from 'pith-ui/app'; const model = customModelDefaults();",
    "import * as ui from 'pith-ui/app'; const customModelDefaults = ui.createApplication; customModelDefaults();",
    "const ui = await import('pith-ui/app'); const customModelDefaults = ui.createApplication; customModelDefaults();",
  ]) {
    const issues = source(text);
    assert.ok(issues.some(issue => issue.code === 'import'), text);
  }
});

test('a drop validator must reject invalid values rather than contain unreachable validation checks', () => {
  const ineffectiveGuard = nativeModule.replace(
    "if (!Array.isArray(value.paths) || !value.paths.every(path => typeof path === 'string')) return;",
    "if (false && (!Array.isArray(value.paths) || !value.paths.every(path => typeof path === 'string'))) return;",
  );
  rejected(ineffectiveGuard, 'frontend/src/ui-native.ts');
});

test('business file, blob, URL, networking and literal tool data remain outside the DOM prohibition', () => {
  assert.deepEqual(source(`
    export function upload(file: File, blob: Blob, buffer: ArrayBuffer) {
      const url = new URL('/api/upload', 'http://localhost');
      return fetch(url, { method: 'POST', body: blob });
    }
    export const nativeData = { paths: ['/workspace/file.txt'], x: 5, y: 10 };
  `), []);
});

test('only public component imports and CSS pass; the removed app entry is rejected',()=>{
  assert.deepEqual(source("import {createButton,type Control} from 'pith-ui'; import 'pith-ui/styles.css'; export const button=createButton({label:'Save'});"),[]);
  rejected("import {createApplication} from 'pith-ui/app';");
});

test('HTML-looking tool output, paths, CSS samples and business formatting remain data', () => {
  assert.deepEqual(source(`
    const toolOutput = '<section class="pui-message" style="color:red">literal output</section>';
    const command = 'document.createElement("button"); element.innerHTML = "hello"';
    const data = { element: 'hydrogen', node: 'history-node', className: 'model-class', style: 'body { color:red }' };
    const formatter = { render: (text: string) => '<b>' + text + '</b>' };
    const request = async (path: string, body: unknown) => ({ path, body });
    void request('/api/tool-result', { text: toolOutput, code: command, data, rendered: formatter.render(toolOutput) });
    export const help = 'pith-ui/dist/private.js is not a permitted module import';
  `), []);
});

for (const [label, text] of [
  ['private package path', "import { icon } from 'pith-ui/dist/dom.js';"],
  ['private app subpath', "import { internals } from 'pith-ui/app/internal';"],
  ['relative installed implementation', "import { icon } from '../node_modules/pith-ui/dist/dom.js';"],
  ['absolute sibling source', "import { createButton } from '/Users/yusp/work/pith-ui/src/index.ts';"],
  ['sibling source relative import', "import { createButton } from '../../../pith-ui/src/index.ts';"],
  ['CommonJS escape', "const ui = require('pith-ui');"],
  ['concatenated dynamic private import', "void import('pith-ui/' + 'dist/dom.js');"],
] as const) {
  test(`rejects ${label}`, () => rejected(text));
}

test('a local barrel cannot launder a private package import', () => {
  const issues = inspect({
    'frontend/src/ui-proxy.ts': "export { createButton as createApplication } from 'pith-ui/dist/primitives.js';",
    'frontend/src/feature.ts': "import { createApplication } from './ui-proxy'; export { createApplication };",
  });
  assert.ok(issues.some(issue => issue.file === 'frontend/src/ui-proxy.ts'));
});

for (const [label, text] of [
  ['element creation', "const node = document.createElement('button');"],
  ['namespace element creation', "const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');"],
  ['template creation', "const template = document.createElement('template');"],
  ['global document alias', "const doc = window.document; const node = doc.createElement('div');"],
  ['destructured document alias', "const { document: doc } = globalThis; doc.createElement('div');"],
  ['destructured DOM method alias', "const { createElement: make } = document; make.call(document, 'div');"],
  ['bound DOM method alias', "const make = document.createElement.bind(document); make('div');"],
  ['computed DOM method', "document['create' + 'Element']('div');"],
  ['internal selector', "document.querySelector('.pui-message');"],
  ['selector alias', "const query = document.querySelector.bind(document); query('[data-ui-part]');"],
  ['innerHTML assignment', "document.body.innerHTML = '<button>Save</button>';"],
  ['computed innerHTML assignment', "const body = document.body; body['inner' + 'HTML'] = '<button>Save</button>';"],
  ['outerHTML assignment', "document.body.outerHTML = '<body><button>Save</button></body>';"],
  ['insertAdjacentHTML', "document.body.insertAdjacentHTML('beforeend', '<button>Save</button>');"],
  ['DOMParser template', "new DOMParser().parseFromString('<button>Save</button>', 'text/html');"],
  ['contextual fragment', "document.createRange().createContextualFragment('<button>Save</button>');"],
  ['copied component implementation', "export function copiedButton(label: string) { const button = document.createElement('button'); button.className = 'pui-button'; button.textContent = label; return button; }"],
  ['JSX element', "export const view = <button className='pui-button'>Save</button>;"],
] as const) {
  test(`rejects ${label}`, () => rejected(text, label === 'JSX element' ? 'frontend/src/feature.tsx' : undefined));
}

for (const [label, text] of [
  ['inline style', "document.body.style.padding = '12px';"],
  ['style object mutation', "Object.assign(document.body.style, { display: 'grid', gap: '16px' });"],
  ['style property alias', "const { style } = document.body; style.setProperty('--pui-gap', '2px');"],
  ['className', "document.body.className = 'pui pui-custom';"],
  ['classList', "document.body.classList.add('pui-custom');"],
  ['class attribute', "document.body.setAttribute('class', 'pui-custom');"],
  ['style attribute', "document.body.setAttribute('style', 'padding: 12px');"],
  ['constructed stylesheet', "const sheet = new CSSStyleSheet(); sheet.replaceSync('.pui { gap: 2px }');"],
  ['adopted stylesheet', "document.adoptedStyleSheets = [];"],
] as const) {
  test(`rejects ${label}`, () => rejected(text));
}

test('only the library CSS import is allowed in the consumer stylesheet', () => {
  for (const css of ['.pui { padding: 4px; }', ':root { --pui-text-medium: 18px; }', '@import "./custom.css";', '@import "pith-ui/styles.css";\n.pui button { color:red }']) {
    assert.ok(inspect({ 'frontend/src/style.css': css }).length > 0, css);
  }
});

test('the HTML shell cannot become a second component, layout or style source', () => {
  for (const html of [
    '<div id="app"><button>Save</button></div>',
    '<style>.pui { gap: 2px }</style><div id="app"></div>',
    '<div id="app" class="grid" style="padding:8px"></div>',
    '<template id="dialog-template"><dialog>Settings</dialog></template><div id="app"></div>',
  ]) assert.ok(inspect({ 'frontend/index.html': html }).length > 0, html);
});

for (const [label, suffix] of [
  ['element handle', 'app.element'],
  ['computed element handle', "app['ele' + 'ment']"],
  ['part accessor', "app.part('messages')"],
  ['field accessor', "app.field('api-key')"],
  ['destructured internal handle', 'const { element } = app'],
  ['aliased part accessor', "const owned = app; owned.part('messages')"],
] as const) {
  test(`rejects ${label} from the application handle`, () => rejected(`import { createApplication } from 'pith-ui/app'; const app = createApplication(); ${suffix};`));
}

for (const [label, options] of [
  ['render callback', '{ render: () => "output" }'],
  ['named rendering callback', '{ renderHeader: () => "output" }'],
  ['nested rendering callback', '{ content: { render: () => "output" } }'],
  ['class option', '{ className: "pui-custom" }'],
  ['style option', '{ style: { padding: 8 } }'],
  ['HTML option', '{ html: "<button>Save</button>" }'],
  ['DOM children slot', '{ children: providedNode }'],
  ['DOM header slot', '{ header: providedNode }'],
] as const) {
  test(`rejects a free ${label} on application construction`, () => rejected(`import { createApplication } from 'pith-ui/app'; const app = createApplication(${options});`));
}

test('application options cannot launder rendering callbacks through aliases and spreads', () => {
  rejected(`import { createApplication as mount } from 'pith-ui/app'; const rendering = { renderHeader: () => 'header' }; const alias = rendering; mount({ ...alias });`);
});

test('public node slots and rendering callback types cannot be added in the consumer', () => {
  rejected('export interface ViewOptions { children: Node; renderHeader: () => HTMLElement }');
});

for (const dependency of ['^0.2.0', '~0.2.0', 'latest', 'file:../../pith-ui', 'file:../../pith-ui/artifacts/pith-ui.tgz', 'link:../../pith-ui', 'workspace:*', 'https://example.test/pith-ui.tgz', 'github:minifish-org/pith-ui']) {
  test(`rejects non-exact-registry dependency ${dependency}`, () => {
    assert.ok(inspect({ 'frontend/package.json': JSON.stringify({ ...packageJSON, dependencies: { 'pith-ui': dependency } }) }).length > 0);
  });
}

test('the lockfile must resolve the same exact package to the public npm registry', () => {
  for (const resolved of ['file:../../pith-ui/pith-ui-0.2.0.tgz', '../../pith-ui', 'https://example.test/pith-ui-0.2.0.tgz']) {
    const lock = structuredClone(packageLock); lock.packages['node_modules/pith-ui'].resolved = resolved;
    assert.ok(inspect({ 'frontend/package-lock.json': JSON.stringify(lock) }).length > 0);
  }
  const different = structuredClone(packageLock); different.packages['node_modules/pith-ui'].version = '0.1.4';
  assert.ok(inspect({ 'frontend/package-lock.json': JSON.stringify(different) }).length > 0);
});

test('installed package metadata must match the pinned version and expose only the approved component entries', () => {
  assert.ok(inspect({ 'frontend/node_modules/pith-ui/package.json': JSON.stringify({ ...installedPackage, version: '0.1.4' }) }).length > 0);
  const missingApp = structuredClone(installedPackage); (missingApp.exports as Record<string,unknown>)['./app']={types:'./dist/app/index.d.ts',import:'./dist/app/index.js'};
  assert.ok(inspect({ 'frontend/node_modules/pith-ui/package.json': JSON.stringify(missingApp) }).length > 0);
});

test('installed entry export targets cannot escape the built dist directory', () => {
  const escaped = structuredClone(installedPackage);
  escaped.exports['.'].import = './dist/../../src/app.js';
  assert.ok(inspect({ 'frontend/node_modules/pith-ui/package.json': JSON.stringify(escaped) }).length > 0);
});

test('a UI dependency or production source symlink cannot bypass installed-package checks', () => {
  for (const path of ['frontend/node_modules/pith-ui', 'frontend/src/borrowed-ui.ts']) {
    assert.ok(inspect({}, [path]).length > 0, path);
  }
});

test('the CLI reader never follows a linked frontend or installed dependency ancestor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pith-consumption-reader-'));
  try {
    const outside = path.join(root, 'outside');
    await mkdir(path.join(outside, 'src'), { recursive: true });
    await writeFile(path.join(outside, 'src', 'secret.ts'), 'export const secret = true;');
    await symlink(outside, path.join(root, 'frontend'));
    const frontend = await readConsumptionInput(root);
    assert.deepEqual(frontend.files, {});
    assert.ok(frontend.symlinks?.includes('frontend'));
    await rm(path.join(root, 'frontend'));
    await mkdir(path.join(root, 'frontend', 'src'), { recursive: true });
    await mkdir(path.join(outside, 'pith-ui'), { recursive: true });
    await writeFile(path.join(outside, 'pith-ui', 'package.json'), JSON.stringify(installedPackage));
    await symlink(outside, path.join(root, 'frontend', 'node_modules'));
    const dependency = await readConsumptionInput(root);
    assert.equal(dependency.files['frontend/node_modules/pith-ui/package.json'], undefined);
    assert.ok(dependency.symlinks?.includes('frontend/node_modules'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('TypeScript and Vite source aliases cannot redirect the UI entry to a sibling checkout', () => {
  assert.ok(inspect({ 'frontend/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { 'pith-ui/app': ['../../pith-ui/src/app.ts'] } } }) }).length > 0);
  assert.ok(inspect({ 'frontend/vite.config.ts': "export default { resolve: { alias: { 'pith-ui/app': '../../pith-ui/src/app.ts' } } };" }).length > 0);
  assert.ok(inspect({ 'frontend/package.json': JSON.stringify({ ...packageJSON, imports: { '#ui': '../../pith-ui/src/app.ts' } }) }).length > 0);
});

test('diagnostics identify the offending file, source line and a useful reason', () => {
  const issues = source("// business state\nimport { createButton } from 'pith-ui/dist/primitives.js';\n");
  const issue = issues.find(item => item.file === 'frontend/src/feature.ts');
  assert.ok(issue); assert.equal(issue.line, 2);
  assert.ok(typeof issue.message === 'string' && issue.message.trim().length > 0);
});


test('published constrained controls compose independently of the application entry', () => {
  assert.deepEqual(source(`
    import {createButton as action, createStack, createDialog, type Control} from 'pith-ui';
    import type {Application} from './ui-types';
    const button = action({label:'Save',intent:'primary',onAction:async()=>({ok:true})});
    const content = createStack({children:[button]});
    const dialog = createDialog({title:'Edit',content});
    export function attach(app:Application) {return app.attachDialog(dialog);}
    export type Item = Control;
  `), []);
  for (const text of [
    "import * as ui from 'pith-ui'; const button=ui.createButton({label:'Save'}); button.update({label:'Saving'});",
    "export {createButton} from 'pith-ui';",
    "export * from 'pith-ui';",
    "void import('pith-ui');",
    "type UI = typeof import('pith-ui');",
  ]) assert.deepEqual(source(text), []);
});

for (const [label, text] of [
  ['named handle', "import {createButton as action} from 'pith-ui'; const button=action({label:'Save'}); button.element;"],
  ['namespace alias', "import * as UI from 'pith-ui'; const ui=UI; const factory=ui.createButton; const button=factory({label:'Save'}); button['element'];"],
  ['typed handle', "import type {Control} from 'pith-ui'; function alter(button:Control) {button.classList.add('custom');}"],
  ['destructured handle', "import {createDialog} from 'pith-ui'; const {element:node}=createDialog({title:'Edit'});"],
  ['style option', "import {createStack} from 'pith-ui'; const options={children:[],style:{gap:3}}; createStack(options);"],
  ['density option', "import {createButton} from 'pith-ui'; createButton({label:'Save',density:'compact'});"],
  ['typography option', "import * as ui from 'pith-ui'; ui.createText({text:'Hello',fontSize:18});"],
] as const) test(`small controls reject ${label} escapes`, () => rejected(text));

test('small control imports require a package with the constrained 0.3 contract', () => {
  const old='0.2.2';
  const input={...baselineFiles,
    'frontend/package.json':JSON.stringify({...packageJSON,dependencies:{'pith-ui':old}}),
    'frontend/package-lock.json':JSON.stringify({...packageLock,packages:{'':{dependencies:{'pith-ui':old}},'node_modules/pith-ui':{version:old,resolved:`https://registry.npmjs.org/pith-ui/-/pith-ui-${old}.tgz`,integrity}}}),
    'frontend/node_modules/pith-ui/package.json':JSON.stringify({...installedPackage,version:old}),
    'frontend/src/feature.ts':"import {createButton} from 'pith-ui';",
  };
  assert.ok(checkUIConsumption({files:input}).length>0);
  const missing=structuredClone(installedPackage); delete (missing.exports as Record<string,unknown>)['.'];
  assert.ok(inspect({'frontend/node_modules/pith-ui/package.json':JSON.stringify(missing)}).length>0);
});

test('public regions compose opaque controls without introducing app interfaces',()=>{
  assert.deepEqual(source("import {createPane,createStack,createText} from 'pith-ui';const pane=createPane({header:createText({text:'Title'}),content:createStack({children:[]})});"),[]);
});

test('native file IO never permits selectors, visible controls or arbitrary markup',()=>{
  for(const text of ["document.querySelector('input')","const node=document.createElement('button')","const picker=document.createElement('input');picker.type='text';document.body.append(picker)","document.body.innerHTML='<input>'"] )rejected(text,'frontend/src/ui-native-io.ts');
});
