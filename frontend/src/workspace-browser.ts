import type {ApiRequest} from './api.ts';
import type {Workspace} from './contract.generated.ts';
import type {Application} from './ui-contract.ts';
import type {FileBrowserState,FileBrowserCallbacks} from 'pith-ui/recipes';

type BrowserState = FileBrowserState;
type BrowserCallbacks = FileBrowserCallbacks;
type Target = Parameters<NonNullable<BrowserCallbacks['onAction']>>[1];
type Action = Parameters<NonNullable<BrowserCallbacks['onAction']>>[0];
type Directory = BrowserState['directories'][number];
export interface FileBrowserPreferences {expanded: string[];scrollTop?: number}

export function createWorkspaceBrowser(api: {
  ui: Application;request: ApiRequest;workspace(): Workspace|undefined;
  view: {update(state: FileBrowserState): void};visible(): boolean;
  initial?: FileBrowserPreferences;changed?(state: FileBrowserPreferences): void;
  disabled(): boolean;referenceDisabled(): boolean;server: boolean;native: boolean;
  changedDraft(): void;clearPreview(): void;
  fileAction(action: Exclude<Action,'reference'>,target: Target): Promise<void>;
}) {
  let workspace: Workspace|undefined,epoch = 0,alive = true;
  const restore = new Set(api.initial?.expanded ?? []);
  const directories = new Map<string,Directory>(),reads = new Map<string,AbortController>();
  const changed = () => api.changed?.({expanded: [...new Set([...restore,...[...directories.values()].filter(value => value.path && value.expanded).map(value => value.path)])]});
  function retireReads(): void {epoch++;for (const read of reads.values()) read.abort();reads.clear();}
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  function paint(): void {
    if (!alive) return;
    api.view.update({workspaceId: workspace?.id ?? '',location: workspace ? `${api.server ? 'Server workspace' : 'Workspace'}: ${workspace.path}` : '',rootLabel: workspace?.name,directories: [...directories.values()],
      disabled: api.disabled(),referenceDisabled: api.referenceDisabled(),capabilities: {native: api.native,copyFile: api.native,copyPathLabel: api.server ? 'Copy server path' : 'Copy path'}});
  }
  async function load(path: string): Promise<void> {
    if (!alive || !workspace || api.disabled()) return;
    const id = workspace.id,generation = epoch;
    reads.get(path)?.abort();const controller = new AbortController();reads.set(path,controller);
    directories.set(path,{path,expanded: directories.get(path)?.expanded ?? true,entries: directories.get(path)?.entries ?? [],loading: true});
    paint();
    const current = () => alive && generation === epoch && workspace?.id === id && reads.get(path) === controller;
    try {
      const response = await api.request('/api/workspace-files',{query: {workspaceId: id,path},signal: controller.signal});
      if (!current()) return;
      const result = {...response,entries: response.entries ?? []};
      directories.set(path,{...result,path,expanded: directories.get(path)?.expanded ?? true});
      // Retire cached descendants removed or replaced since the last refresh.
      const children = new Set(result.entries.filter(entry => entry.directory).map(entry => entry.path));
      const prefix = path ? path+'/' : '';
      for (const child of directories.keys()) if (child !== path && child.startsWith(prefix)) {
        const immediate = prefix+child.slice(prefix.length).split('/')[0];
        if (!children.has(immediate)) {reads.get(child)?.abort();reads.delete(child);directories.delete(child);}
      }
      if (!path && restore.size) {
        const expanded = [...restore];restore.clear();
        for (const path of expanded) {directories.set(path,{path,expanded: true,entries: [],loading: true});void load(path);}
      }
    } catch (error) {
      if (!current()) return;
      directories.set(path,{path,expanded: directories.get(path)?.expanded ?? true,entries: [],error: message(error)});
    } finally {if (current()) {reads.delete(path);paint();}}
  }
  function sync(): void {
    if (!alive) return;
    const next = api.workspace();
    if (next?.id !== workspace?.id) {
      const replacing = !!workspace;
      retireReads();workspace = next;if (replacing) restore.clear();directories.clear();api.clearPreview();
    }
    if (workspace && api.visible() && !directories.has('') && !api.disabled()) void load('');
    paint();
  }
  async function refresh(): Promise<void> {
    if (!alive || api.disabled()) return;
    retireReads();api.clearPreview();const generation = epoch;
    // Refresh root before descendants, so deleted directories cannot be revived.
    const expanded = [...directories.values()].filter(entry => entry.path && entry.expanded).map(entry => entry.path).sort((a,b) => a.length-b.length);
    await load('');
    for (const path of expanded) {
      if (!alive || generation !== epoch) return;
      if (directories.get(path)?.expanded) await load(path);
    }
  }
  async function action(action: Action,target: Target): Promise<void> {
    if (!alive || api.disabled() || target.workspaceId !== workspace?.id || target.workspaceId !== api.workspace()?.id) return;
    if (action === 'reference') {
      if (api.referenceDisabled()) return;
      api.ui.files.closeToolsOverlay();api.ui.workspace.insertReferences([target.path]);api.changedDraft();api.ui.workspace.focusComposer();
    } else await api.fileAction(action,target);
  }
  return {sync,refresh,action,
    toggle(target: Target,expanded: boolean): void {
      if (!alive || api.disabled() || target.workspaceId !== workspace?.id) return;
      const directory = directories.get(target.path);
      if (directory) {directories.set(target.path,{...directory,expanded});paint();}
      if (!expanded) restore.delete(target.path);else restore.add(target.path);
      changed();
      if (expanded && (!directory || directory.error || directory.loading && !reads.has(target.path))) void load(target.path);
    },
    destroy(): void {if (!alive) return;alive = false;retireReads();directories.clear();},
  };
}
