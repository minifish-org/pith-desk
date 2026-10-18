import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '../frontend/node_modules/typescript/lib/typescript.js';

export interface ConsumptionInput {
  readonly files: Readonly<Record<string, string>>;
  readonly symlinks?: readonly string[];
}
export interface ConsumptionIssue {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

const partsEntry = 'pith-ui';
const recipesEntry = 'pith-ui/recipes';
const canonicalDeskModule = 'frontend/src/ui-application';
const cssEntry = 'pith-ui/styles.css';
const nativeFiles = new Set(['frontend/src/ui-native.ts', 'frontend/src/native-menu.ts', 'frontend/src/app-lifecycle.ts']);
const metaNames = new Set(['desk-token', 'desk-native-clipboard', 'desk-native-file-drop', 'desk-native-menus']);
const nativeEvents = new Set(['focus', 'blur', 'visibilitychange', 'pagehide', 'beforeunload', 'keydown', 'pith:flush-drafts', 'pith:file-drop', 'pith:native-menu']);
const internalParts = new Set(['element', 'field', 'form', 'control', 'body', 'dialog', 'internals', 'style', 'className', 'classList', 'innerHTML', 'outerHTML', 'querySelector', 'querySelectorAll']);
const visualOptions = new Set(['class', 'className', 'classList', 'style', 'css', 'html', 'innerHTML', 'outerHTML', 'header', 'element', 'node']);
const domGlobals = new Set(['document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Document', 'DocumentFragment', 'DOMParser', 'DOMImplementation', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'CSSStyleSheet', 'CSSStyleDeclaration', 'Image', 'Option', 'customElements']);
const nativeTypes = new Set(['Event', 'CustomEvent', 'KeyboardEvent', 'BeforeUnloadEvent', 'EventListener', 'EventListenerOrEventListenerObject']);
const safeWindowData = new Set(['location', 'localStorage', 'sessionStorage', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'crypto']);

function unwrap(node: ts.Node): ts.Node {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}
function stringValue(node: ts.Node | undefined, bindings?: Map<string, ts.Expression>, seen = new Set<string>()): string | undefined {
  if (!node) return;
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = stringValue(node.left, bindings, seen), b = stringValue(node.right, bindings, seen);
    if (a !== undefined && b !== undefined) return a + b;
  }
  if (ts.isIdentifier(node) && bindings?.has(node.text) && !seen.has(node.text)) {
    return stringValue(bindings.get(node.text), bindings, new Set([...seen, node.text]));
  }
}
function property(node: ts.Node): { object: ts.Expression; key: string | undefined } | undefined {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, key: node.name.text };
  if (ts.isElementAccessExpression(node)) return { object: node.expression, key: stringValue(node.argumentExpression) };
}
function identifier(node: ts.Node | undefined, name: string): boolean { return !!node && ts.isIdentifier(unwrap(node)) && (unwrap(node) as ts.Identifier).text === name; }
function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function isRead(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent))) { node = parent; parent = parent.parent; }
  if (parent && ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
  return !(parent && (ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)));
}
function isName(node: ts.Identifier): boolean {
  const p = node.parent;
  return !!p && (ts.isPropertyAccessExpression(p) && p.name === node || ts.isPropertyAssignment(p) && p.name === node || ts.isMethodDeclaration(p) && p.name === node || ts.isPropertySignature(p) && p.name === node || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p) && p.propertyName === node);
}
function isDOMName(name: string): boolean {
  return domGlobals.has(name) || /^HTML\w*Element$|^SVG\w*Element$/.test(name);
}
function objectKeys(node: ts.ObjectLiteralExpression): string[] {
  return node.properties.map(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : '');
}

/** Pure policy check: no filesystem, environment, registry or application state reads. */
export function checkUIConsumption(input: ConsumptionInput): ConsumptionIssue[] {
  const issues: ConsumptionIssue[] = [];
  const files = Object.fromEntries(Object.entries(input.files).map(([file, source]) => [file.replaceAll('\\', '/'), source]));
  const emit = (file: string, code: string, message: string, source?: ts.SourceFile, node?: ts.Node, offset?: number) => {
    const pos = source?.getLineAndCharacterOfPosition(node ? node.getStart(source) : offset ?? 0);
    issues.push({ file, line: pos ? pos.line + 1 : 1, column: pos ? pos.character + 1 : 1, code, message });
  };
  const json = (file: string): any => {
    if (!(file in files)) { emit(file, 'package', 'Required package metadata is missing.'); return {}; }
    try { return JSON.parse(files[file]); } catch { emit(file, 'package', 'Package metadata must be valid JSON.'); return {}; }
  };
  const pkg = json('frontend/package.json');
  const lock = json('frontend/package-lock.json');
  const installed = json('frontend/node_modules/pith-ui/package.json');
  const version = pkg.dependencies?.['pith-ui'];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) emit('frontend/package.json', 'package', 'pith-ui must be pinned to one exact published npm version.');
  const locked = lock.packages?.['node_modules/pith-ui'];
  if (lock.packages?.['']?.dependencies?.['pith-ui'] !== version || locked?.version !== version || locked?.resolved !== `https://registry.npmjs.org/pith-ui/-/pith-ui-${version}.tgz` || locked?.link || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(locked?.integrity ?? '')) {
    emit('frontend/package-lock.json', 'package', 'The lock must pin the same registry tarball version and SHA-512 integrity; file, link and alternate tarballs are forbidden.');
  }
  if (installed.name !== 'pith-ui' || installed.version !== version) emit('frontend/node_modules/pith-ui/package.json', 'package', 'Installed pith-ui metadata must match the exact dependency.');
  const entry = installed.exports?.['.'];
  const builtTarget = (value: unknown, extension: string): boolean => {
    if (typeof value !== 'string' || !value.startsWith('./dist/') || !value.endsWith(extension) || /[\\?#%:]/.test(value)) return false;
    const normalized = path.posix.normalize(value);
    return normalized.startsWith('dist/') && normalized === value.slice(2) && !value.split('/').includes('..');
  };
  if (!entry || !builtTarget(entry.types, '.d.ts') || !builtTarget(entry.import, '.js') || installed.exports?.['./styles.css'] !== './dist/styles.css' || !builtTarget(installed.exports?.['./recipes']?.types, '.d.ts') || !builtTarget(installed.exports?.['./recipes']?.import, '.js') || Object.keys(installed.exports ?? {}).sort().join(',') !== '.,./recipes,./styles.css') {
    emit('frontend/node_modules/pith-ui/package.json', 'package', 'The installed package must expose the formal parts and recipes entries with ESM/declarations and pith-ui/styles.css.');
  }
  const inspectAlias = (file: string, value: unknown, key = ''): void => {
    if (typeof value === 'string' && (/(?:^|[\/])pith-ui(?:[\/]|$)/.test(value) || key === partsEntry || key.startsWith('pith-ui/'))) emit(file, 'alias', 'UI package aliases and sibling/source redirects are forbidden.');
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) inspectAlias(file, v, k);
  };
  inspectAlias('frontend/package.json', pkg.imports);
  inspectAlias('frontend/package.json', pkg.overrides);
  for (const symlink of input.symlinks ?? []) {
    const file = symlink.replaceAll('\\', '/');
    if (file === 'frontend' || file === 'frontend/src' || file.startsWith('frontend/src/') || file === 'frontend/node_modules' || file === 'frontend/node_modules/pith-ui' || file.startsWith('frontend/node_modules/pith-ui/')) emit(file, 'symlink', 'Production UI sources and the installed UI package must not be symlinked.');
  }

  for (const [file, text] of Object.entries(files)) {
    if (file.includes('/node_modules/')) continue;
    if (file.endsWith('.css')) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (css && !/^@import\s+(?:"pith-ui\/styles\.css"|'pith-ui\/styles\.css')\s*;?$/.test(css)) emit(file, 'css', 'Consumer CSS may only import pith-ui/styles.css; styles and overrides belong in the library.');
      continue;
    }
    if (file.endsWith('.html')) { checkHTML(file, text, (message, offset) => emit(file, 'html', message, ts.createSourceFile(file, text, ts.ScriptTarget.Latest), undefined, offset)); continue; }
    if (/tsconfig[^/]*\.json$/.test(file)) {
      const config = ts.parseConfigFileTextToJson(file, text);
      if (config.error) emit(file, 'alias', 'TypeScript configuration could not be parsed.');
      inspectAlias(file, config.config?.compilerOptions?.paths);
      inspectAlias(file, config.config?.extends);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const production = file.startsWith('frontend/src/');
    const configFile = /(?:^|\/)(?:vite|rollup|webpack|esbuild)\.config\.[cm]?[jt]s$/.test(file);
    if (!production && !configFile) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const fail = (node: ts.Node, code: string, message: string) => emit(file, code, message, source, node);
    for (const error of (source as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics) emit(file, 'syntax', ts.flattenDiagnosticMessageText(error.messageText, '\n'), source, undefined, error.start);
    const bindings = new Map<string, ts.Expression>();
    type FactoryKind = 'part' | 'mount' | 'desk' | 'entry' | 'composition';
    const factories = new Map<string, FactoryKind>();
    const namespaces = new Map<string, 'parts' | 'recipes' | 'desk'>();
    const assembly = file.replace(/\.[cm]?[jt]s$/, '') === canonicalDeskModule;
    const localModule = (specifier: string): string | undefined => specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.[cm]?[jt]s$/, '') : undefined;
    const partKind = (name: string): FactoryKind | undefined => name === 'mountParts' ? 'mount' : /^create[A-Z]\w*Part$/.test(name) ? 'part' : undefined;
    const appTypes = new Set<string>();
    const values = new Set<string>();
    const eventValues = new Set<string>();
    const allowed = new Set<ts.Node>();
    const validatorNames = new Set<string>();
    walk(source, node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
      if (ts.isImportDeclaration(node)) {
        const specifier = stringValue(node.moduleSpecifier) ?? '', local = localModule(specifier);
        const root = specifier === partsEntry, desk = local === canonicalDeskModule, entry = local === 'frontend/src/ui-mount';
        const composition = specifier === recipesEntry;
        const names = node.importClause?.namedBindings;
        if (names && ts.isNamespaceImport(names) && (root || composition || desk)) namespaces.set(names.name.text, root ? 'parts' : composition ? 'recipes' : 'desk');
        if (names && ts.isNamedImports(names)) for (const spec of names.elements) {
          const imported = (spec.propertyName ?? spec.name).text, typeOnly = spec.isTypeOnly || !!node.importClause?.isTypeOnly;
          if (typeOnly && (root || composition || local === 'frontend/src/ui-contract')) appTypes.add(spec.name.text);
          if (typeOnly) continue;
          if (root && !partKind(imported)) fail(spec, 'import', 'Runtime UI imports must be formal create*Part factories or mountParts; shared region helpers belong in pith-ui/recipes.');
          const kind = root ? partKind(imported) : desk && imported === 'mountDesk' ? 'desk' : entry && imported === 'mountApplication' ? 'entry' : composition && (/^compose[A-Z]/.test(imported) || imported === 'createDialogHost') ? 'composition' : undefined;
          if (kind) factories.set(spec.name.text, kind);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name && validDropValidator(node)) validatorNames.add(node.name.text);
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && nativeTypes.has(node.type.typeName.text)) eventValues.add(node.name.text);
    });
    const resolvesNamespace = (node: ts.Node, seen = new Set<string>()): 'parts' | 'recipes' | 'desk' | undefined => {
      node = unwrap(node);
      if (ts.isAwaitExpression(node)) return resolvesNamespace(node.expression, seen);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = stringValue(node.arguments[0], bindings);
        return target === partsEntry ? 'parts' : target === recipesEntry ? 'recipes' : target && localModule(target) === canonicalDeskModule ? 'desk' : undefined;
      }
      if (!ts.isIdentifier(node)) return;
      if (namespaces.has(node.text)) return namespaces.get(node.text);
      return !seen.has(node.text) && bindings.has(node.text) ? resolvesNamespace(bindings.get(node.text)!, new Set([...seen, node.text])) : undefined;
    };
    const factoryKind = (node: ts.Node, seen = new Set<string>()): FactoryKind | undefined => {
      node = unwrap(node);
      const p = property(node);
      if (p?.key) {
        const namespace = resolvesNamespace(p.object);
        if (namespace === 'parts') return partKind(p.key);
        if (namespace === 'recipes' && (/^compose[A-Z]/.test(p.key) || p.key === 'createDialogHost')) return 'composition';
        if (namespace === 'desk' && p.key === 'mountDesk') return 'desk';
      }
      if (!ts.isIdentifier(node)) return;
      if (factories.has(node.text)) return factories.get(node.text);
      if (seen.has(node.text) || !bindings.has(node.text)) return;
      return factoryKind(bindings.get(node.text)!, new Set([...seen, node.text]));
    };
    const resolvesFactory = (node: ts.Node): boolean => factoryKind(node) !== undefined;
    if (assembly) allowAssemblyMountParameters(source, allowed, node => factoryKind(node) === 'mount');
    if (file === 'frontend/src/ui-mount.ts') {
      if (!allowMount(source, allowed, node => factoryKind(node) === 'desk')) fail(source, 'mount', 'ui-mount.ts must only export mountApplication: obtain #app, check HTMLElement, then return the canonical local mountDesk(root, options).');
    }
    if (file === 'frontend/src/ui-bootstrap.ts') allowBootstrap(source, allowed);
    if (nativeFiles.has(file)) walk(source, node => {
      const p = property(node);
      if (!p) return;
      if (identifier(p.object, 'document') && p.key === 'visibilityState' && isRead(node)) allowed.add(p.object);
      if (identifier(p.object, 'document') && p.key === 'hasFocus' && ts.isCallExpression(node.parent) && node.parent.expression === node && !node.parent.arguments.length) allowed.add(p.object);
      if (['addEventListener', 'removeEventListener'].includes(p.key ?? '') && (identifier(p.object, 'document') || identifier(p.object, 'window')) && ts.isCallExpression(node.parent) && node.parent.expression === node && nativeEvents.has(stringValue(node.parent.arguments[0]) ?? '') && node.parent.arguments.length >= 2) allowed.add(p.object);
      if (p.key === 'detail' && allowNativeProtocol(node, source, file)) allowed.add(node);
    });
    const isApp = (node: ts.Node, seen = new Set<string>()): boolean => {
      node = unwrap(node);
      if (ts.isCallExpression(node)) return resolvesFactory(node.expression) || identifier(node.expression, 'mountApplication');
      if (ts.isIdentifier(node)) {
        if (values.has(node.text)) return true;
        if (seen.has(node.text) || !bindings.has(node.text)) return false;
        return isApp(bindings.get(node.text)!, new Set([...seen, node.text]));
      }
      const p = property(node); return !!p && isApp(p.object, seen);
    };
    const isComposition = (node: ts.Node, seen = new Set<string>()): boolean => {
      node = unwrap(node);
      if (ts.isCallExpression(node)) return factoryKind(node.expression) === 'composition';
      if (!ts.isIdentifier(node) || seen.has(node.text) || !bindings.has(node.text)) return false;
      return isComposition(bindings.get(node.text)!, new Set([...seen, node.text]));
    };
    walk(source, node => {
      if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name) && node.type) {
        walk(node.type, type => { if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && appTypes.has(type.typeName.text)) values.add(node.name.getText(source)); });
      }
    });
    const inspectOptions = (node: ts.Node, seen = new Set<string>()): void => {
      node = unwrap(node);
      if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text)) { inspectOptions(bindings.get(node.text)!, new Set([...seen, node.text])); return; }
      if (ts.isObjectLiteralExpression(node)) for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) { inspectOptions(prop.expression, seen); continue; }
        const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) ? prop.name.text : prop.name && ts.isComputedPropertyName(prop.name) ? stringValue(prop.name.expression, bindings) : undefined;
        if (key && (visualOptions.has(key) || /^render(?:$|[A-Z_])/.test(key))) fail(prop, 'options', 'Part options must contain literal content, semantic state, opaque parts and data callbacks, not render callbacks, DOM nodes, classes, HTML or styles.');
        if (ts.isPropertyAssignment(prop)) inspectOptions(prop.initializer, seen);
        else if (ts.isShorthandPropertyAssignment(prop)) inspectOptions(prop.name, seen);
      }
      if (ts.isArrayLiteralExpression(node)) for (const item of node.elements) inspectOptions(item, seen);
    };
    const modulePath = (node: ts.Node, expression: ts.Node): void => {
      const specifier = stringValue(expression, bindings);
      if (specifier === undefined) { fail(node, 'import', 'Dynamic module paths must be statically known; unresolved UI import aliases are forbidden.'); return; }
      if (specifier === partsEntry || specifier === recipesEntry || specifier === cssEntry) return;
      if (/(?:^|[\/])pith-ui(?:[\/]|$)/.test(specifier)) { fail(node, 'import', 'UI imports and types must use formal pith-ui parts, pith-ui/recipes or pith-ui/styles.css; legacy app, private and source imports are forbidden.'); return; }
      if (production && (!specifier.startsWith('.') || !path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).startsWith('frontend/src/'))) fail(node, 'import', 'Production modules may import only local frontend sources or the approved published UI entries.');
    };
    walk(source, node => {
      if (configFile) {
        if (ts.isStringLiteralLike(node) && /(?:^|[\/])pith-ui(?:[\/]|$)/.test(node.text)) fail(node, 'alias', 'Build configuration cannot alias or bundle a UI source checkout.');
        return;
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) modulePath(node, node.moduleSpecifier);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) modulePath(node, node.argument.literal);
      if (ts.isImportEqualsDeclaration(node)) fail(node, 'import', 'CommonJS and import-equals module indirection are forbidden in production UI consumers.');
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || identifier(node.expression, 'require'))) modulePath(node, node.arguments[0] ?? node);
      if (ts.isIdentifier(node) && node.text === 'require' && !isName(node)) fail(node, 'import', 'CommonJS loading and require aliases are forbidden.');
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) fail(node, 'dom', 'Consumer JSX and copied UI templates are forbidden.');
      if (ts.isIdentifier(node) && !isName(node) && !allowed.has(node)) {
        if (isDOMName(node.text)) fail(node, 'dom', `DOM capability ${node.text} belongs to pith-ui; only the precise host adapter expressions are permitted.`);
        if (nativeTypes.has(node.text) && !nativeFiles.has(file)) fail(node, 'dom', 'Browser event types belong to the finite native adapter modules.');
        if (node.text === 'window') {
          const p = property(node.parent);
          if (!p || p.object !== node || !safeWindowData.has(p.key ?? '')) fail(node, 'dom', 'Global window UI/event capabilities belong to the finite native adapter expressions.');
        }
        if (node.text === 'globalThis') {
          const p = property(node.parent);
          const key = ts.isElementAccessExpression(node.parent) ? stringValue(node.parent.argumentExpression, bindings) : p?.key;
          if (!p || p.object !== node || !safeWindowData.has(key ?? '')) fail(node, 'dom', 'Global object aliases cannot provide DOM capabilities.');
        }
      }
      const p = property(node);
      if (p) {
        if ((identifier(p.object, 'globalThis') || identifier(p.object, 'window')) && isDOMName(p.key ?? '')) fail(node, 'dom', 'Aliased global DOM capabilities are forbidden.');
        const opaqueControl = assembly && p.key === 'control' && isComposition(p.object) && !(ts.isCallExpression(node.parent) && node.parent.expression === node);
        if (p.key && (internalParts.has(p.key) && !opaqueControl || p.key === 'part' && (!assembly || ts.isCallExpression(node.parent) && node.parent.expression === node)) && isApp(p.object)) fail(node, 'internal', 'UI handles expose opaque parts, not native elements, selectors, styles or part accessors.');
        const eventObject = unwrap(p.object);
        const event = ts.isIdentifier(eventObject) && eventValues.has(eventObject.text);
        if ((p.key === 'target' || p.key === 'currentTarget') && event) {
          if (nativeFiles.has(file)) fail(node, 'native', 'Native adapters forward pure data and must not use event target nodes.');
        }
        if (p.key === 'detail' && event && nativeFiles.has(file) && !allowed.has(node)) {
          let parent: ts.Node = node.parent;
          while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) parent = parent.parent;
          if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression) || !validatorNames.has(parent.expression.text) || parent.arguments.length !== 1) fail(node, 'native', 'Native drop detail must pass through a local guard validating string paths and finite x/y before forwarding.');
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        if (isApp(node.initializer)) for (const entry of node.name.elements) {
          const name = entry.propertyName ?? entry.name;
          if (ts.isIdentifier(name) && (internalParts.has(name.text) || name.text === 'part' && !assembly)) fail(entry, 'internal', 'UI native internals cannot be recovered by destructuring.');
        }
        if (identifier(node.initializer, 'globalThis')) for (const entry of node.name.elements) {
          const name = entry.propertyName ?? entry.name;
          if (ts.isIdentifier(name) && isDOMName(name.text)) fail(entry, 'dom', 'Global DOM capabilities cannot be recovered by destructuring.');
        }
      }
      if (ts.isCallExpression(node)) {
        const kind = factoryKind(node.expression);
        if ((kind === 'mount' || kind === 'desk') && !allowed.has(node)) fail(node, 'mount', 'Native mounting is limited to the checked ui-mount adapter and opaque part assembly adapters.');
        if (kind === 'part' || kind === 'mount' || kind === 'desk' || kind === 'entry') for (const arg of node.arguments) inspectOptions(arg);
      }
    });
  }
  const unique = new Map(issues.map(issue => [`${issue.file}:${issue.line}:${issue.column}:${issue.code}:${issue.message}`, issue]));
  return [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
}

function splitOr(node: ts.Node): ts.Node[] {
  node = unwrap(node);
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? [...splitOr(node.left), ...splitOr(node.right)] : [node];
}
function returnsEarly(statement: ts.Statement): boolean {
  const body = ts.isBlock(statement) ? statement.statements : [statement];
  return body.length === 1 && ts.isReturnStatement(body[0]) && !body[0].expression;
}
function typeGuard(node: ts.Node, name: string, type: string): boolean {
  node = unwrap(node);
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && ts.isTypeOfExpression(node.left) && identifier(node.left.expression, name) && stringValue(node.right) === type;
}
function identifiersWithin(node: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  walk(node, item => { if (ts.isIdentifier(item) && item.text === name && !isName(item)) found.push(item); });
  return found;
}

// Preserve two existing host protocols without granting DOM authority to their files.
function allowNativeProtocol(detail: ts.Node, source: ts.SourceFile, file: string): boolean {
  let declaration: ts.Node = detail;
  while (ts.isParenthesizedExpression(declaration.parent) || ts.isAsExpression(declaration.parent)) declaration = declaration.parent;
  if (!ts.isVariableDeclaration(declaration.parent) || !ts.isIdentifier(declaration.parent.name)) return false;
  const variable = declaration.parent;
  let fn: ts.Node | undefined = variable;
  while (fn && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) fn = fn.parent;
  if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) || !fn.body || !ts.isBlock(fn.body)) return false;
  const name = ts.isFunctionDeclaration(fn) ? fn.name?.text : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined;
  if (!name) return false;
  const events: string[] = [];
  walk(source, item => {
    if (!ts.isCallExpression(item) || !identifier(item.arguments[1], name)) return;
    const p = property(item.expression);
    if (p?.key === 'addEventListener' && (identifier(p.object, 'window') || identifier(p.object, 'document'))) events.push(stringValue(item.arguments[0]) ?? '');
  });
  const declaredName = variable.name.getText(source);
  const index = fn.body.statements.findIndex(statement => statement.pos <= variable.pos && statement.end >= variable.end);
  const guard = fn.body.statements[index + 1];
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement || !returnsEarly(guard.thenStatement)) return false;
  if (file === 'frontend/src/app-lifecycle.ts' && events.length === 1 && events[0] === 'pith:flush-drafts' && typeGuard(guard.expression, declaredName, 'function')) {
    const refs = identifiersWithin(fn.body, declaredName).filter(node => node !== variable.name);
    if (refs.length !== 3) return false;
    let type = 0, fulfillment = 0, rejection = 0;
    for (const ref of refs) {
      if (ts.isTypeOfExpression(ref.parent)) type++;
      else if (ts.isCallExpression(ref.parent) && ref.parent.expression === ref && ref.parent.arguments.length === 1 && ref.parent.arguments[0].kind === ts.SyntaxKind.FalseKeyword) rejection++;
      else if (ts.isCallExpression(ref.parent) && property(ref.parent.expression)?.key === 'then' && ref.parent.arguments[0] === ref && ref.parent.arguments.length === 2) fulfillment++;
      else return false;
    }
    return type === 1 && fulfillment === 1 && rejection === 1;
  }
  if (file !== 'frontend/src/native-menu.ts' || events.length !== 1 || events[0] !== 'pith:native-menu') return false;
  const checks = splitOr(guard.expression);
  if (checks.length !== 3 || !ts.isPrefixUnaryExpression(checks[0]) || checks[0].operator !== ts.SyntaxKind.ExclamationToken || !identifier(checks[0].operand, declaredName) || !typeGuard(checks[1], declaredName, 'object')) return false;
  const missingAction = checks[2];
  if (!ts.isPrefixUnaryExpression(missingAction) || missingAction.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const hasAction = unwrap(missingAction.operand);
  if (!ts.isBinaryExpression(hasAction) || hasAction.operatorToken.kind !== ts.SyntaxKind.InKeyword || stringValue(hasAction.left) !== 'action' || !identifier(hasAction.right, declaredName)) return false;
  const actionStatement = fn.body.statements[index + 2], dispatch = fn.body.statements[index + 3];
  if (!actionStatement || !ts.isVariableStatement(actionStatement) || actionStatement.declarationList.declarations.length !== 1 || !dispatch || !ts.isIfStatement(dispatch) || dispatch.elseStatement) return false;
  const action = actionStatement.declarationList.declarations[0], member = action.initializer && property(action.initializer);
  if (!ts.isIdentifier(action.name) || member?.key !== 'action' || !identifier(member.object, declaredName)) return false;
  const actions = splitOr(dispatch.expression).map(condition => ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && identifier(condition.left, action.name.getText(source)) ? stringValue(condition.right) : undefined);
  if (actions.length !== 5 || new Set(actions).size !== 5 || !['new-conversation', 'choose-workspace', 'export-conversation', 'settings', 'check-updates'].every(value => actions.includes(value))) return false;
  const invocation = ts.isBlock(dispatch.thenStatement) && dispatch.thenStatement.statements.length === 1 ? dispatch.thenStatement.statements[0] : dispatch.thenStatement;
  if (!ts.isExpressionStatement(invocation) || !ts.isCallExpression(invocation.expression) || invocation.expression.arguments.length !== 1 || !identifier(invocation.expression.arguments[0], action.name.text)) return false;
  return identifiersWithin(fn.body, declaredName).filter(node => node !== variable.name).length === 4 && identifiersWithin(fn.body, action.name.text).filter(node => node !== action.name).length === 6;
}

/** Only the application coordinator receives a typed mount. Every
 * reference must forward it directly to the actual formal mountParts entry. */
function allowAssemblyMountParameters(source: ts.SourceFile, allowed: Set<ts.Node>, isMount: (node: ts.Node) => boolean): void {
  for (const fn of source.statements) {
    if (!ts.isFunctionDeclaration(fn) || !fn.name || !/^mount[A-Z]/.test(fn.name.text) || !fn.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || !fn.body) continue;
    const parameter = fn.parameters[0];
    if (!parameter || !ts.isIdentifier(parameter.name) || !parameter.type || !ts.isTypeReferenceNode(parameter.type) || !identifier(parameter.type.typeName, 'HTMLElement') || parameter.type.typeArguments?.length) continue;
    const references = identifiersWithin(fn.body, parameter.name.text);
    const calls: ts.CallExpression[] = [];
    const valid = references.every(reference => {
      let value: ts.Node = reference;
      while (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) || ts.isNonNullExpression(value.parent)) value = value.parent;
      const call = value.parent;
      if (!ts.isCallExpression(call) || call.arguments[0] !== value || !isMount(call.expression)) return false;
      calls.push(call); return true;
    });
    if (!valid) continue;
    allowed.add(parameter.type.typeName);
    for (const call of calls) allowed.add(call);
  }
}

function allowMount(source: ts.SourceFile, allowed: Set<ts.Node>, factory: (node: ts.Node) => boolean): boolean {
  const declarations = source.statements.filter(node => !ts.isImportDeclaration(node));
  if (declarations.length !== 1 || !ts.isFunctionDeclaration(declarations[0])) return false;
  const fn = declarations[0];
  if (fn.name?.text !== 'mountApplication' || !fn.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name) || !fn.body || fn.body.statements.length !== 3) return false;
  const [decl, guard, result] = fn.body.statements;
  if (!ts.isVariableStatement(decl) || decl.declarationList.declarations.length !== 1) return false;
  const root = decl.declarationList.declarations[0];
  if (!ts.isIdentifier(root.name) || !root.initializer || !ts.isCallExpression(root.initializer)) return false;
  const getter = root.initializer, p = property(getter.expression);
  if (!p || !identifier(p.object, 'document') || p.key !== 'getElementById' || getter.arguments.length !== 1 || stringValue(getter.arguments[0]) !== 'app') return false;
  if (!ts.isIfStatement(guard) || guard.elseStatement) return false;
  const condition = unwrap(guard.expression);
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const instance = unwrap(condition.operand);
  if (!ts.isBinaryExpression(instance) || instance.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword || !identifier(instance.left, root.name.text) || !identifier(instance.right, 'HTMLElement')) return false;
  const rejected = ts.isBlock(guard.thenStatement) ? guard.thenStatement.statements : [guard.thenStatement];
  if (rejected.length !== 1 || !ts.isThrowStatement(rejected[0])) return false;
  if (!ts.isReturnStatement(result) || !result.expression || !ts.isCallExpression(result.expression)) return false;
  const call = result.expression;
  if (!factory(call.expression) || call.arguments.length !== 2 || !identifier(call.arguments[0], root.name.text) || !identifier(call.arguments[1], fn.parameters[0].name.text)) return false;
  allowed.add(p.object); allowed.add(instance.right); allowed.add(call);
  return true;
}

function allowBootstrap(source: ts.SourceFile, allowed: Set<ts.Node>): void {
  for (const fn of source.statements) {
    if (!ts.isFunctionDeclaration(fn) || fn.name?.text !== 'readAppBootstrap' || !fn.body) continue;
    const documentParameter = fn.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === 'document');
    const candidates: ts.VariableDeclaration[] = [];
    walk(fn.body, node => { if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)) candidates.push(node); });
    for (const candidate of candidates) {
      const helper = candidate.initializer as ts.ArrowFunction;
      if (!ts.isIdentifier(candidate.name) || helper.parameters.length !== 1 || !ts.isIdentifier(helper.parameters[0].name) || !ts.isBlock(helper.body) || helper.body.statements.length !== 4) continue;
      const [metaStatement, valueStatement, removeStatement, returnStatement] = helper.body.statements;
      if (!ts.isVariableStatement(metaStatement) || !ts.isVariableStatement(valueStatement) || metaStatement.declarationList.declarations.length !== 1 || valueStatement.declarationList.declarations.length !== 1) continue;
      const meta = metaStatement.declarationList.declarations[0], value = valueStatement.declarationList.declarations[0];
      if (!ts.isIdentifier(meta.name) || !meta.initializer || !ts.isCallExpression(meta.initializer) || !ts.isIdentifier(value.name) || !value.initializer) continue;
      const query = meta.initializer, selector = query.arguments[0], queryProperty = property(query.expression);
      if (!queryProperty || !identifier(queryProperty.object, 'document') || queryProperty.key !== 'querySelector' || query.arguments.length !== 1 || !ts.isTemplateExpression(selector) || selector.head.text !== 'meta[name="' || selector.templateSpans.length !== 1 || !identifier(selector.templateSpans[0].expression, helper.parameters[0].name.text) || selector.templateSpans[0].literal.text !== '"]') continue;
      const valueExpression = unwrap(value.initializer);
      if (!ts.isBinaryExpression(valueExpression) || valueExpression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken || stringValue(valueExpression.right) !== '') continue;
      const content = property(valueExpression.left);
      if (!content || !identifier(content.object, meta.name.text) || content.key !== 'content') continue;
      if (!ts.isExpressionStatement(removeStatement) || !ts.isCallExpression(removeStatement.expression) || removeStatement.expression.arguments.length) continue;
      const remove = property(removeStatement.expression.expression);
      if (!remove || !identifier(remove.object, meta.name.text) || remove.key !== 'remove' || !ts.isReturnStatement(returnStatement) || !identifier(returnStatement.expression, value.name.text)) continue;
      const references: ts.Identifier[] = [];
      walk(source, node => { if (ts.isIdentifier(node) && node.text === candidate.name.getText(source) && node !== candidate.name && !isName(node)) references.push(node); });
      const consumed = references.map(node => ts.isCallExpression(node.parent) && node.parent.expression === node && node.parent.arguments.length === 1 ? stringValue(node.parent.arguments[0]) : undefined);
      if (consumed.length !== 4 || new Set(consumed).size !== 4 || consumed.some(name => !name || !metaNames.has(name))) continue;
      allowed.add(queryProperty.object);
      if (documentParameter) allowed.add(documentParameter.name);
      if (documentParameter?.type) walk(documentParameter.type, node => allowed.add(node));
      for (const type of query.typeArguments ?? []) walk(type, node => { if (ts.isIdentifier(node) && node.text === 'HTMLMetaElement') allowed.add(node); });
    }
    walk(fn.body, node => {
      const appearance = property(node);
      if (appearance?.key !== 'appearance' || !isRead(node)) return;
      const dataset = property(appearance.object), element = dataset && property(dataset.object);
      if (dataset?.key === 'dataset' && element?.key === 'documentElement' && identifier(element.object, 'document')) allowed.add(element.object);
    });
  }
}

function validDropValidator(fn: ts.FunctionDeclaration): boolean {
  if (!fn.body || fn.parameters.length !== 1 || fn.parameters[0].type?.kind !== ts.SyntaxKind.UnknownKeyword) return false;
  const statements = fn.body.statements;
  if (statements.length !== 5 || !ts.isIfStatement(statements[0]) || !ts.isVariableStatement(statements[1]) || !ts.isIfStatement(statements[2]) || !ts.isIfStatement(statements[3]) || !ts.isReturnStatement(statements[4])) return false;
  for (const index of [0, 2, 3]) {
    const guard = statements[index] as ts.IfStatement;
    const body = ts.isBlock(guard.thenStatement) ? guard.thenStatement.statements : [guard.thenStatement];
    if (guard.elseStatement || body.length !== 1 || !ts.isReturnStatement(body[0]) || body[0].expression) return false;
  }
  if (!ts.isIdentifier(fn.parameters[0].name)) return false;
  const input = fn.parameters[0].name.text;
  const objectChecks = splitOr((statements[0] as ts.IfStatement).expression);
  if (objectChecks.length !== 2 || !negated(objectChecks[0], value => identifier(value, input)) || !typeGuard(objectChecks[1], input, 'object')) return false;
  const variables = statements[1].declarationList.declarations;
  if (variables.length !== 1 || !ts.isIdentifier(variables[0].name) || !variables[0].initializer || !identifier(variables[0].initializer, input)) return false;
  const record = variables[0].name.text;
  const member = (node: ts.Node, key: string): boolean => { const p = property(unwrap(node)); return p?.key === key && identifier(p.object, record); };
  const guardedCall = (node: ts.Node, owner: string, method: string, key: string): boolean => negated(node, expression => {
    if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return false;
    const methodProperty = property(expression.expression);
    return methodProperty?.key === method && identifier(methodProperty.object, owner) && member(expression.arguments[0], key);
  });
  const pathChecks = splitOr((statements[2] as ts.IfStatement).expression);
  if (pathChecks.length !== 2 || !guardedCall(pathChecks[0], 'Array', 'isArray', 'paths') || !negated(pathChecks[1], expression => {
    if (!ts.isCallExpression(expression) || expression.arguments.length !== 1 || property(expression.expression)?.key !== 'every' || !member(property(expression.expression)!.object, 'paths')) return false;
    const predicate = expression.arguments[0];
    if (!ts.isArrowFunction(predicate) || predicate.parameters.length !== 1 || !ts.isIdentifier(predicate.parameters[0].name)) return false;
    const comparison = unwrap(predicate.body);
    return ts.isBinaryExpression(comparison) && comparison.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isTypeOfExpression(comparison.left) && identifier(comparison.left.expression, predicate.parameters[0].name.text) && stringValue(comparison.right) === 'string';
  })) return false;
  const coordinateChecks = splitOr((statements[3] as ts.IfStatement).expression);
  if (coordinateChecks.length !== 4) return false;
  for (const [index, key] of ['x', 'y'].entries()) {
    const type = coordinateChecks[index * 2];
    if (!ts.isBinaryExpression(type) || type.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken || !ts.isTypeOfExpression(type.left) || !member(type.left.expression, key) || stringValue(type.right) !== 'number' || !guardedCall(coordinateChecks[index * 2 + 1], 'Number', 'isFinite', key)) return false;
  }
  const returned = statements[4].expression;
  return !!returned && ts.isObjectLiteralExpression(returned) && objectKeys(returned).join(',') === 'paths,x,y' && returned.properties.every((prop, index) => ts.isPropertyAssignment(prop) && member(prop.initializer, ['paths', 'x', 'y'][index]));
}

function negated(node: ts.Node, predicate: (node: ts.Expression) => boolean): boolean {
  node = unwrap(node);
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && predicate(unwrap(node.operand) as ts.Expression);
}

function checkHTML(file: string, text: string, fail: (message: string, offset: number) => void): void {
  if (file !== 'frontend/index.html') { fail('Consumer HTML templates are forbidden outside the minimal application shell.', 0); return; }
  // Tokenize actual HTML, keeping quoted > characters and comments out of tag parsing.
  const tokens = text.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g);
  const stack: string[] = [];
  let mounts = 0;
  for (const token of tokens) {
    const value = token[0], offset = token.index!;
    if (value.startsWith('<!--') || /^<!doctype\s+html\s*>$/i.test(value)) continue;
    if (!value.startsWith('<')) { if (value.trim() && stack.at(-1) !== 'title') fail('The application shell cannot contain UI text or inline scripts.', offset); continue; }
    const parsed = /^<(\/?)([\w-]+)([\s\S]*?)\/?>$/.exec(value);
    if (!parsed) { fail('Malformed application HTML shell.', offset); continue; }
    const tag = parsed[2].toLowerCase();
    if (parsed[1]) { if (stack.pop() !== tag) fail('Application shell tags must be balanced.', offset); continue; }
    const attrs = new Map<string, string>();
    const attrText = parsed[3].replace(/\/$/, '');
    const attrPattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of attrText.matchAll(attrPattern)) attrs.set(match[1].toLowerCase(), match[2] ?? match[3]);
    if (attrText.replace(attrPattern, '').trim()) fail('Only explicit quoted shell attributes are allowed.', offset);
    const parent = stack.at(-1);
    const allowedAttrs: Record<string, string[]> = { html: ['lang', 'data-appearance'], head: [], body: [], title: [], meta: ['charset', 'name', 'content'], link: ['rel', 'type', 'href'], div: ['id'], script: ['type', 'src'] };
    if (!(tag in allowedAttrs) || [...attrs.keys()].some(name => !allowedAttrs[tag]?.includes(name))) fail('Consumer HTML may not define components, classes, styles or templates.', offset);
    if (tag === 'html' && stack.length || tag === 'head' && parent !== 'html' || tag === 'body' && parent !== 'html' || ['meta', 'link', 'title'].includes(tag) && parent !== 'head') fail('Only the minimal head and application body are allowed.', offset);
    if (tag === 'div') { mounts++; if (parent !== 'body' || attrs.size !== 1 || attrs.get('id') !== 'app') fail('The only body element is the empty #app mount.', offset); }
    if (tag === 'script' && (parent !== 'body' || attrs.size !== 2 || attrs.get('type') !== 'module' || attrs.get('src') !== '/src/main.ts')) fail('The only shell script is the external main module.', offset);
    if (tag === 'meta' && attrs.has('name') && !new Set(['viewport', 'theme-color', ...metaNames]).has(attrs.get('name')!)) fail('Only the specified application bootstrap metadata is allowed.', offset);
    if (tag === 'link' && (attrs.get('rel') !== 'icon' || !/^\/(?:[\w.-]+\/)*[\w.-]+\.(?:png|svg|ico)$/.test(attrs.get('href') ?? ''))) fail('Only a static application icon link belongs in the shell.', offset);
    if (parent === 'div' || parent === 'script' || parent === 'title') fail('The mount and script cannot contain nested UI.', offset);
    if (!['meta', 'link'].includes(tag)) stack.push(tag);
  }
  if (mounts !== 1 || stack.length) fail('The shell must contain one empty #app mount and balanced tags.', 0);
}

/** Read only the production boundary and package metadata; never follow symlinks. */
export async function readConsumptionInput(root: string): Promise<ConsumptionInput> {
  const files: Record<string, string> = {};
  const symlinks: string[] = [];
  const collect = async (relative: string, recursive: boolean): Promise<void> => {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) { symlinks.push(relative); return; }
    if (stat.isDirectory()) {
      if (recursive) for (const name of (await readdir(absolute)).sort()) await collect(path.posix.join(relative, name), true);
    } else if (stat.isFile()) files[relative] = await readFile(absolute, 'utf8');
  };
  // Do not traverse a linked frontend ancestor, even to collect diagnostics.
  try {
    if ((await lstat(path.join(root, 'frontend'))).isSymbolicLink()) return { files, symlinks: ['frontend'] };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await collect('frontend/src', true);
  for (const file of ['frontend/index.html', 'frontend/package.json', 'frontend/package-lock.json']) await collect(file, false);
  for (const directory of ['', 'frontend']) for (const name of await readdir(path.join(root, directory))) {
    if (/^(?:tsconfig[^/]*\.json|(?:vite|rollup|webpack|esbuild)\.config\.[cm]?[jt]s)$/.test(name)) await collect(path.posix.join(directory, name), false);
  }
  // Check each ancestor before opening installed metadata, including nested package symlinks.
  for (const directory of ['frontend', 'frontend/node_modules', 'frontend/node_modules/pith-ui']) {
    try { if ((await lstat(path.join(root, directory))).isSymbolicLink()) symlinks.push(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!symlinks.some(name => ['frontend', 'frontend/node_modules', 'frontend/node_modules/pith-ui'].includes(name))) {
    await collect('frontend/node_modules/pith-ui/package.json', false);
    const findLinks = async (relative: string): Promise<void> => {
      let stat;
      try { stat = await lstat(path.join(root, relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (stat.isSymbolicLink()) { symlinks.push(relative); return; }
      if (stat.isDirectory()) for (const name of await readdir(path.join(root, relative))) await findLinks(path.posix.join(relative, name));
    };
    await findLinks('frontend/node_modules/pith-ui');
  }
  return { files, symlinks };
}

const entryFile = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (entryFile === import.meta.url) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const input = await readConsumptionInput(root);
  const issues = checkUIConsumption(input);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ issues, files: Object.keys(input.files).length, counts: issues.reduce<Record<string, number>>((counts, issue) => { counts[issue.code] = (counts[issue.code] ?? 0) + 1; return counts; }, {}) }, null, 2));
  else {
    for (const issue of issues) console.error(`${issue.file}:${issue.line}:${issue.column} [${issue.code}] ${issue.message}`);
    console.log(`UI consumption: ${issues.length ? `${issues.length} violation(s)` : 'passed'} across ${Object.keys(input.files).length} production boundary files.`);
  }
  if (issues.length) process.exitCode = 1;
}
