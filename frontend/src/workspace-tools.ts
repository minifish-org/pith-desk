import type {ApiRequest} from './api.ts';
import type {Info,Workspace} from './contract.generated.ts';
import type {Application} from './ui-contract.ts';
import {createWorkspaceBrowser,type FileBrowserPreferences} from './workspace-browser.ts';
import {createWorkspaceTerminal} from './terminal.ts';
import {createWebPreview} from './web-preview.ts';

type Kind = 'files'|'terminal'|'preview';
interface Tab {id: string;kind: Kind;label: string;files?: FileBrowserPreferences}
interface Layout {tabs: Tab[];activeId: string;next: {files: number;terminal: number}}
const prefix = 'pith-desk.tools.v1.';
type StorageLike = Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const emptyFiles = (): FileBrowserPreferences => ({expanded: []});
// getRandomValues also works on plain-HTTP Server origins, where randomUUID
// is unavailable. IDs identify tabs; they do not grant terminal access.
const newToolID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),byte => byte.toString(16).padStart(2,'0')).join('');

/** Only layout and file-view preferences are saved. Terminal input, output,
 * history and process environments never enter browser storage or Agent state. */
export function readToolLayout(storage: StorageLike|undefined,workspace: string,newID: () => string = newToolID): Layout {
  try {
    const raw = storage?.getItem(prefix+workspace);
    if (raw && raw.length < 2*1024*1024) {
      const value = JSON.parse(raw) as Layout;
      if (Array.isArray(value.tabs) && value.tabs.length <= 32 && new Set(value.tabs.map(tab => tab.id)).size === value.tabs.length &&
        value.tabs.every(tab => typeof tab.id === 'string' && tab.id.length > 0 && tab.id.length <= 128 && ['files','terminal','preview'].includes(tab.kind) && typeof tab.label === 'string' && tab.label.length <= 80 &&
          (!tab.files || Array.isArray(tab.files.expanded) && tab.files.expanded.length <= 256 && tab.files.expanded.every(path => typeof path === 'string' && path.length <= 4096) && (tab.files.scrollTop === undefined || Number.isFinite(tab.files.scrollTop) && tab.files.scrollTop >= 0 && tab.files.scrollTop <= 10_000_000))) && value.tabs.filter(tab=>tab.kind==='preview').length<=1 &&
        typeof value.activeId === 'string' && value.next && (['files','terminal'] as const).every(key => Number.isSafeInteger(value.next[key]) && value.next[key] > 0)) {
        if (!value.tabs.some(tab => tab.id === value.activeId)) value.activeId = value.tabs[0]?.id ?? '';
        return {tabs: value.tabs.map(tab => ({id: tab.id,kind: tab.kind,label: tab.kind === 'preview' ? 'Web' : tab.label,...(tab.kind === 'files' ? {files: {expanded: tab.files?.expanded ?? [],scrollTop: tab.files?.scrollTop}} : {})})),activeId: value.activeId,next: {files: value.next.files,terminal: value.next.terminal}};
      }
    }
  } catch {}
  const id = newID();return {tabs: [{id,kind: 'files',label: 'Files',files: emptyFiles()}],activeId: id,next: {files: 2,terminal: 1}};
}

export function createWorkspaceToolsController(api: {
  ui: Application;request: ApiRequest;workspace(): Workspace|undefined;workspaces(): readonly Workspace[];
  disabled(): boolean;filesDisabled(): boolean;referenceDisabled(): boolean;server: boolean;native: boolean;
  changedDraft(): void;clearPreview(): void;
  fileAction: Parameters<typeof createWorkspaceBrowser>[0]['fileAction'];copy(text: string): unknown;
  protocols(): string[];checkAccess?(): Promise<void>;
  storage?: StorageLike;newID?(): string;
}) {
  let alive = true,current = '',storage = api.storage;
  if (!storage) {try {storage = window.localStorage;} catch {}}
  type Entry = {tab: Tab;pending: boolean;detail: string;destroy(): void;sync(): void;close?(): Promise<boolean>;start?(): Promise<void>;closeMenu?(): void};
  type Group = {workspace: Workspace;layout: Layout;entries: Map<string,Entry>;loaded: boolean;loading: boolean;location: string;alive: boolean};
  const groups = new Map<string,Group>();
  const newID = api.newID ?? newToolID;
  const selected = (group: Group,id: string) => alive && current === group.workspace.id && api.workspace()?.id === group.workspace.id && group.layout.activeId === id;
  const visible = (group: Group,id: string) => selected(group,id) && api.ui.files.areToolsOpen();
  const persist = (group: Group) => {try {storage?.setItem(prefix+group.workspace.id,JSON.stringify(group.layout));} catch {}};
  function paint(): void {
    if (!alive) return;
    const group = groups.get(current);
    api.ui.tools.update({tabs: group?.layout.tabs.map(tab => ({id: tab.id,kind: tab.kind,label: tab.label,detail: tab.kind === 'files' ? `${group.location}\n${group.workspace.path}` : group.entries.get(tab.id)?.detail,pending: group.entries.get(tab.id)?.pending})) ?? [],
      activeId: group?.layout.activeId ?? '',location: api.server ? 'Server' : 'Local',detail: group ? `${group.location}\n${group.workspace.path}` : '',disabled: api.disabled() || !group,webPreview:true});
  }
  function make(group: Group,tab: Tab,initialInfo?: Info): Entry {
    let entry: Entry;
    if (tab.kind === 'files') {
      let controller: ReturnType<typeof createWorkspaceBrowser>;
      const view = api.ui.tools.createFiles(tab.id,{onRefresh: () => {void controller.refresh();},onToggle: (target,expanded) => controller.toggle(target,expanded),onAction: (action,target) => selected(group,tab.id) ? controller.action(action,target) : undefined,
        onReadingPosition(top) {if (tab.files) {tab.files.scrollTop = top;persist(group);}}});
      if (tab.files?.scrollTop) view.restorePosition(tab.files.scrollTop);
      controller = createWorkspaceBrowser({ui: api.ui,view,request: api.request,workspace: () => group.workspace,visible: () => visible(group,tab.id),initial: tab.files,
        disabled: api.filesDisabled,referenceDisabled: api.referenceDisabled,server: api.server,native: api.native,clearPreview: api.clearPreview,fileAction: api.fileAction,changedDraft: api.changedDraft,
        changed(state) {tab.files = {...tab.files,...state};persist(group);}});
      entry = {tab,pending: false,detail: group.workspace.path,sync: controller.sync,closeMenu: view.closeMenu,destroy() {controller.destroy();view.destroy();}};
    } else if(tab.kind==='terminal') {
      let controller: ReturnType<typeof createWorkspaceTerminal>;
      const view = api.ui.tools.createTerminal(tab.id,{onInput(data) {if (selected(group,tab.id)) controller.input(data);},onResize(size) {if (visible(group,tab.id)) controller.resize(size);},onCopy(text) {return Promise.resolve(api.copy(text)).then(() => {});}});
      controller = createWorkspaceTerminal({view,request: api.request,id: tab.id,workspace: () => group.workspace,visible: () => visible(group,tab.id),disabled: api.disabled,
        initialInfo,initialLocation: group.location,protocols: api.protocols,checkAccess: api.checkAccess,
        changed({info,location,pending}) {
          if (!entry || !group.alive) return;
          const detail = `${location}\nInitial directory: ${info?.directory ?? group.workspace.path}${info ? '\nShell: '+info.shell : ''}`;
          if (entry.detail !== detail || entry.pending !== pending) {entry.detail = detail;entry.pending = pending;paint();}
        }});
      entry = {tab,pending: false,detail: `${group.location}\nInitial directory: ${group.workspace.path}`,sync: controller.sync,close: controller.close,start: controller.start,destroy() {controller.destroy();view.destroy();}};
    } else {
      let controller:ReturnType<typeof createWebPreview>;
      const view=api.ui.tools.createPreview(tab.id,{onNavigate:address=>{void controller.navigate(address);},onRefresh:()=>{void controller.refresh();}});
      controller=createWebPreview({view,request:api.request,workspaceId:group.workspace.id,active:()=>visible(group,tab.id),disabled:api.disabled});
      entry={tab,pending:false,detail:group.workspace.path,sync:controller.sync,destroy() {controller.destroy();view.destroy();}};
    }
    group.entries.set(tab.id,entry);return entry;
  }
  async function inventory(group: Group): Promise<void> {
    if (group.loading || group.loaded || !group.alive || api.disabled()) return;group.loading = true;
    try {
      const result = await api.request('/api/terminal',{query: {workspaceId: group.workspace.id}});
      if (!alive || !group.alive) return;group.location = result.location;
      for (const info of result.sessions ?? []) if (info.workspaceId === group.workspace.id && !group.entries.has(info.id)) {
        const number = group.layout.next.terminal++,tab: Tab = {id: info.id,kind: 'terminal',label: number === 1 ? 'Terminal' : 'Terminal '+number};
        group.layout.tabs.push(tab);make(group,tab,info);
      }
      group.loaded = true;persist(group);paint();for (const entry of group.entries.values()) entry.sync();
    } catch { /* A visible terminal's own lookup reports connection errors. */ }
    finally {group.loading = false;}
  }
  function sync(): void {
    if (!alive) return;
    const valid = new Set(api.workspaces().map(workspace => workspace.id));
    for (const [id,group] of groups) if (!valid.has(id)) {group.alive = false;for (const entry of group.entries.values()) entry.destroy();groups.delete(id);try {storage?.removeItem(prefix+id);} catch {}}
    const workspace = api.workspace();
    if (current !== workspace?.id) {api.ui.tools.closeMenu();api.clearPreview();for (const group of groups.values()) for (const entry of group.entries.values()) entry.closeMenu?.();current = workspace?.id ?? '';}
    if (workspace && !groups.has(workspace.id)) {
      const group: Group = {workspace,layout: readToolLayout(storage,workspace.id,newID),entries: new Map(),loaded: false,loading: false,location: api.server ? 'Server' : 'Local computer',alive: true};
      groups.set(workspace.id,group);for (const tab of group.layout.tabs) make(group,tab);persist(group);
    }
    paint();
    for(const other of groups.values()) if(other.workspace.id!==current)for(const entry of other.entries.values())entry.sync();
    const group = groups.get(current);
    if (group) {for (const entry of group.entries.values()) entry.sync();if (api.ui.files.areToolsOpen()) void inventory(group);}
  }
  function select(id: string): void {
    if (!alive || api.disabled()) return;const group = groups.get(current);if (!group?.entries.has(id)) return;
    api.clearPreview();for (const entry of group.entries.values()) entry.closeMenu?.();group.layout.activeId = id;persist(group);paint();for (const entry of group.entries.values()) entry.sync();
  }
  function create(kind: Kind): void {
    const group = groups.get(current);if (!alive || api.disabled() || !group || group.layout.tabs.length >= 32) return;
    if(kind==='preview') {
      const existing=group.layout.tabs.find(tab=>tab.kind==='preview');if(existing){select(existing.id);return;}
      const tab:Tab={id:newID(),kind,label:'Web'};group.layout.tabs.push(tab);make(group,tab);select(tab.id);return;
    }
    const number = group.layout.next[kind]++,tab: Tab = {id: newID(),kind,label: (kind === 'files' ? 'Files' : 'Terminal')+(number === 1 ? '' : ' '+number),...(kind === 'files' ? {files: emptyFiles()} : {})};
    group.layout.tabs.push(tab);const entry = make(group,tab);select(tab.id);if (kind === 'terminal') void entry.start?.();
  }
  async function close(id: string): Promise<void> {
    const group = groups.get(current),entry = group?.entries.get(id);
    if (!alive || api.disabled() || !group || !entry || entry.pending) return;
    entry.pending = true;paint();
    try {
      if (entry.close && !await entry.close()) return;
      if (!alive || !group.alive) return;
      const index = group.layout.tabs.findIndex(tab => tab.id === id);
      group.layout.tabs.splice(index,1);group.entries.delete(id);entry.destroy();
      if (group.layout.activeId === id) group.layout.activeId = group.layout.tabs[Math.min(index,group.layout.tabs.length-1)]?.id ?? '';
      persist(group);paint();for (const next of group.entries.values()) next.sync();
    } finally {entry.pending = false;paint();}
  }
  return {sync,select,create,close,destroy() {if (!alive) return;alive = false;for (const group of groups.values()) {group.alive = false;for (const entry of group.entries.values()) entry.destroy();}groups.clear();}};
}
