import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkUIConsumption, readConsumptionInput } from './ui-consumption.ts';

const version = '0.6.0';
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
  'frontend/src/main.ts': "import type { ApplicationState } from './ui-contract';\nexport const snapshot: ApplicationState | undefined = undefined;\n",
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
  import { mountDesk } from './ui-assemblies/desk';
  import type { ApplicationOptions } from './ui-contract';
  export function mountApplication(options: ApplicationOptions) {
    const root = document.getElementById('app');
    if (!(root instanceof HTMLElement)) throw new Error('Application mount is missing.');
    return mountDesk(root, options);
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

test('only the named mount module may obtain app, check its HTMLElement type and pass it to the canonical local mountDesk', () => {
  assert.deepEqual(source(mountModule, 'frontend/src/ui-mount.ts'), []);
  rejected(mountModule, 'frontend/src/feature.ts');
});

test('the mount exception rejects altered lookup, missing type checks and mount leakage', () => {
  for (const text of [
    mountModule.replace("getElementById('app')", "getElementById('other')"),
    mountModule.replace("document.getElementById('app')", "document.querySelector('#app')"),
    mountModule.replace("if (!(root instanceof HTMLElement)) throw new Error('Application mount is missing.');", ''),
    mountModule.replace('return mountDesk(root, options);', 'return root;'),
    mountModule.replace('return mountDesk(root, options);', 'exportedRoot = root; return mountDesk(root, options);'),
    mountModule.replace('return mountDesk(root, options);', 'root.style.padding = "8px"; return mountDesk(root, options);'),
    mountModule.replace('return mountDesk(root, options);', 'root.replaceChildren(); return mountDesk(root, options);'),
    mountModule + "\ndocument.querySelector('dialog');",
    mountModule + "\ndocument.createElement('button');",
  ]) rejected(text, 'frontend/src/ui-mount.ts');
});

test('the mounting function cannot add rendering or node slots to the app options', () => {
  for (const options of ['{ ...options, renderHeader: () => "header" }', '{ ...options, children: root }', '{ ...options, style: { padding: 8 } }']) {
    rejected(mountModule.replace('mountDesk(root, options)', `mountDesk(root, ${options})`), 'frontend/src/ui-mount.ts');
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

test('the local custom model defaults helper is pure data through named, alias and namespace imports', () => {
  for (const text of [
    "import {customModelDefaults} from './ui-assemblies/custom-connection'; export const model = customModelDefaults();",
    "import {customModelDefaults as defaults} from './ui-assemblies/custom-connection'; export const model = defaults();",
    "import * as ui from './ui-assemblies/custom-connection'; export const model = ui.customModelDefaults();",
  ]) assert.deepEqual(source(text), []);
});

test('an application factory cannot impersonate the pure custom model defaults helper', () => {
  for (const text of [
    "import {mountParts as customModelDefaults} from 'pith-ui'; const model = customModelDefaults();",
    "import * as ui from 'pith-ui'; const customModelDefaults = ui.mountParts; customModelDefaults();",
    "const ui = await import('pith-ui'); const customModelDefaults = ui.mountParts; customModelDefaults();",
  ]) {
    const issues = source(text);
    assert.ok(issues.some(issue => issue.code === 'mount'), text);
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

test('formal parts imports, local application types and the single library stylesheet pass', () => {
  assert.deepEqual(inspect({ 'frontend/src/feature.ts': `
    import { createButtonPart as createUI } from 'pith-ui';
    import type { ApplicationState } from './ui-contract';
    import 'pith-ui/styles.css';
    export type State = ApplicationState;
    export { createUI };
  ` }), []);
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
  ['root named import', "import { createButton } from 'pith-ui';"],
  ['legacy app type import', "import type { ApplicationState } from 'pith-ui/app';"],
  ['legacy app namespace alias', "import * as approvedUI from 'pith-ui/app';"],
  ['legacy app re-export', "export { createApplication } from 'pith-ui/app';"],
  ['legacy app star re-export', "export * from 'pith-ui/app';"],
  ['legacy app dynamic import', "void import('pith-ui/app');"],
  ['legacy app import type query', "type UI = typeof import('pith-ui/app');"],
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

test('a local barrel cannot launder a root package import', () => {
  const issues = inspect({
    'frontend/src/ui-proxy.ts': "export { createApplication } from 'pith-ui/app';",
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
  test(`rejects ${label} from the application handle`, () => rejected(`import { createFramePart } from 'pith-ui'; const app = createFramePart({}); ${suffix};`));
}

for (const [label, options] of [
  ['render callback', '{ render: () => "output" }'],
  ['named rendering callback', '{ renderHeader: () => "output" }'],
  ['nested rendering callback', '{ content: { render: () => "output" } }'],
  ['class option', '{ className: "pui-custom" }'],
  ['style option', '{ style: { padding: 8 } }'],
  ['HTML option', '{ html: "<button>Save</button>" }'],
  ['DOM children slot', '{ children: [] as Node[] }'],
  ['DOM header slot', '{ header: providedNode }'],
] as const) {
  test(`rejects a free ${label} on part construction`, () => rejected(`import { createFramePart } from 'pith-ui'; const app = createFramePart(${options});`));
}

test('application options cannot launder rendering callbacks through aliases and spreads', () => {
  rejected(`import { createFramePart as mount } from 'pith-ui'; const rendering = { renderHeader: () => 'header' }; const alias = rendering; mount({ ...alias });`);
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

test('installed package metadata must match the pinned version and expose only the formal parts and stylesheet entries', () => {
  assert.ok(inspect({ 'frontend/node_modules/pith-ui/package.json': JSON.stringify({ ...installedPackage, version: '0.1.4' }) }).length > 0);
  const missingRoot = structuredClone(installedPackage); delete (missingRoot.exports as Record<string, unknown>)['.'];
  assert.ok(inspect({ 'frontend/node_modules/pith-ui/package.json': JSON.stringify(missingRoot) }).length > 0);
  const legacy = {...installedPackage,exports:{...installedPackage.exports,'./app':{types:'./dist/app/index.d.ts',import:'./dist/app/index.js'}}};
  assert.ok(inspect({ 'frontend/node_modules/pith-ui/package.json': JSON.stringify(legacy) }).length > 0);
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
  const issues = source("// business state\nimport { createButton } from 'pith-ui';\n");
  const issue = issues.find(item => item.file === 'frontend/src/feature.ts');
  assert.ok(issue); assert.equal(issue.line, 2);
  assert.ok(typeof issue.message === 'string' && issue.message.trim().length > 0);
});

test('opaque parts and child composition are permitted without native access', () => {
  const text = `
    import {createButtonPart,createStackPart,mountParts,type Part} from 'pith-ui';
    import {composePermissionControl} from './permission-control.js';
    import {composeTextEditor} from './text-edit.js';
    export function mountExample(mount: HTMLElement) {
      const permission = composePermissionControl({mode:'ask',description:''});
      const editor = composeTextEditor({value:''});
      const child = createButtonPart({label:'Save',onAction() {}});
      const children: Part[] = [child,editor.part,permission.control];
      const group = createStackPart({children});
      return mountParts(mount,group);
    }
  `;
  assert.deepEqual(source(text,'frontend/src/ui-assemblies/example.ts'),[]);
  rejected(text,'frontend/src/feature.ts');
});

test('formal factories are recognized through named, namespace and dynamic aliases', () => {
  for (const text of [
    `import {createStackPart as stack,mountParts as mount} from 'pith-ui'; export function mountExample(root:HTMLElement) {return mount(root,stack({children:[]}));}`,
    `import * as parts from 'pith-ui'; export function mountExample(root:HTMLElement) {return parts.mountParts(root,parts.createStackPart({children:[]}));}`,
    `const parts=await import('pith-ui'); const stack=parts.createStackPart,mount=parts.mountParts; export function mountExample(root:HTMLElement) {return mount(root,stack({children:[]}));}`,
  ]) assert.deepEqual(source(text,'frontend/src/ui-assemblies/example.ts'),[]);
});

test('a composition directory does not permit DOM operations or additional native parameters', () => {
  for(const text of [
    `export function mountExample(root:HTMLElement) {return root;}`,
    `export function mountExample(root:HTMLElement) {return {root};}`,
    `export function mountExample(root:HTMLElement) {const alias=root;return alias;}`,
    `import {mountParts,createStackPart} from 'pith-ui'; export function mountExample(root:HTMLElement) {root.style.padding='8px';return mountParts(root,createStackPart({children:[]}));}`,
    `import {mountParts,createStackPart} from 'pith-ui'; export function mountExample(root:HTMLElement,other:HTMLElement) {return mountParts(root,createStackPart({children:[]}));}`,
    `export function composeExample(root:HTMLElement) {return {part:root};}`,
    `const node=document.createElement('button');`,
    `const html=<button>Save</button>;`,
  ]) rejected(text,'frontend/src/ui-assemblies/example.tsx');
});

test('a same-named local mountParts function cannot gain native mount authority', () => {
  rejected(`function mountParts(root:unknown,part:unknown) {} export function mountExample(root:HTMLElement) {return mountParts(root,{});}`,'frontend/src/ui-assemblies/example.ts');
});

test('the native mount exception requires the canonical local desk module', () => {
  for(const path of ['./other-desk','./ui-assemblies/desk-copy','pith-ui/app']) {
    rejected(mountModule.replace("'./ui-assemblies/desk'",JSON.stringify(path)),'frontend/src/ui-mount.ts');
  }
  assert.deepEqual(source(mountModule.replace("'./ui-assemblies/desk'","'./ui-assemblies/desk.js'"),'frontend/src/ui-mount.ts'),[]);
});

test('opaque references cannot recover native internals or part accessor methods', () => {
  for(const tail of ['editor.element','editor.part.element','editor.part.style','editor.part.querySelector("button")','editor.part("message")','permission.control.element','permission.control()']) {
    rejected(`import {composeTextEditor} from './text-edit'; import {composePermissionControl} from './permission-control'; const editor=composeTextEditor({value:''});const permission=composePermissionControl({mode:'ask'});${tail};`,'frontend/src/ui-assemblies/example.ts');
  }
  rejected(`import {createInputPart} from 'pith-ui'; const input=createInputPart({value:''});input.control;`,'frontend/src/ui-assemblies/example.ts');
});

test('part construction still checks aliased, nested and spread style or rendering escapes', () => {
  for(const expression of [
    `const free={style:{padding:8}};const alias=free;stack({...alias});`,
    `const free={renderHeader:()=>'<h1>Header</h1>'};stack({children:[],...free});`,
    `const content={css:'padding:8px'};stack({children:[],content});`,
    `const key='class'+'Name';stack({[key]:'custom'});`,
  ]) rejected(`import {createStackPart as stack} from 'pith-ui';${expression}`,'frontend/src/ui-assemblies/example.ts');
});

test('part factory calls outside the composition directory do not gain native mounting authority', () => {
  for(const text of [
    `import {mountParts as attach} from 'pith-ui';attach(undefined as any,part);`,
    `import * as ui from 'pith-ui';const attach=ui.mountParts;attach(undefined as any,part);`,
    `const ui=await import('pith-ui');ui.mountParts(undefined as any,part);`,
  ]) assert.ok(source(text).some(issue=>issue.code==='mount'),text);
});
