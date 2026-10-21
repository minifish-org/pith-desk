import type {ApiRequest} from './api.ts';
import type {Workspace} from './contract.generated.ts';
import type {Application,ApplicationOptions} from './ui-contract.ts';

type BrowserState = Parameters<Application['files']['updateWorkspace']>[0];
type BrowserCallbacks = NonNullable<ApplicationOptions['fileBrowser']>;
type Target = Parameters<NonNullable<BrowserCallbacks['onAction']>>[1];
type Action = Parameters<NonNullable<BrowserCallbacks['onAction']>>[0];
type Directory = BrowserState['directories'][number];

export function createWorkspaceBrowser(api: {
  ui: Application;request: ApiRequest;workspace(): Workspace|undefined;
  disabled(): boolean;referenceDisabled(): boolean;server: boolean;native: boolean;
  changedDraft(): void;clearPreview(): void;
  fileAction(action: Exclude<Action,'reference'>,target: Target): Promise<void>;
}) {
  let workspace: Workspace|undefined,epoch = 0,alive = true,query = '',search: BrowserState['search'],timer: ReturnType<typeof setTimeout>|undefined;
  const directories = new Map<string,Directory>(),reads = new Map<string,AbortController>();
  function retireReads(): void {epoch++;clearTimeout(timer);for (const read of reads.values()) read.abort();reads.clear();}
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  function paint(): void {
    if (!alive) return;
    api.ui.files.updateWorkspace({workspaceId: workspace?.id ?? '',location: workspace ? `${api.server ? 'Server workspace' : 'Workspace'}: ${workspace.path}` : '',query,directories: [...directories.values()],search,
      disabled: api.disabled(),referenceDisabled: api.referenceDisabled(),capabilities: {native: api.native,copyFile: api.native,copyPathLabel: api.server ? 'Copy server path' : 'Copy path'}});
  }
  async function load(path: string,isSearch = false): Promise<void> {
    if (!alive || !workspace || api.disabled()) return;
    const id = workspace.id,generation = epoch,key = isSearch ? ':search' : path,needle = query;
    reads.get(key)?.abort();const controller = new AbortController();reads.set(key,controller);
    if (isSearch) search = {entries: [],loading: true};
    else directories.set(path,{path,expanded: directories.get(path)?.expanded ?? true,entries: directories.get(path)?.entries ?? [],loading: true});
    paint();
    const current = () => alive && generation === epoch && workspace?.id === id && reads.get(key) === controller && (!isSearch || needle === query);
    try {
      const response = await api.request('/api/workspace-files',{query: {workspaceId: id,path,query: isSearch ? needle : ''},signal: controller.signal});
      if (!current()) return;
      const result = {...response,entries: response.entries ?? []};
      if (isSearch) search = result;
      else {
        directories.set(path,{...result,path,expanded: directories.get(path)?.expanded ?? true});
        // Retire cached descendants removed or replaced since the last refresh.
        const children = new Set(result.entries.filter(entry => entry.directory).map(entry => entry.path));
        const prefix = path ? path+'/' : '';
        for (const child of directories.keys()) if (child !== path && child.startsWith(prefix)) {
          const immediate = prefix+child.slice(prefix.length).split('/')[0];
          if (!children.has(immediate)) {reads.get(child)?.abort();reads.delete(child);directories.delete(child);}
        }
      }
    } catch (error) {
      if (!current()) return;
      if (isSearch) search = {entries: [],error: message(error)};
      else directories.set(path,{path,expanded: directories.get(path)?.expanded ?? true,entries: [],error: message(error)});
    } finally {if (current()) {reads.delete(key);paint();}}
  }
  function sync(): void {
    if (!alive) return;
    const next = api.workspace();
    if (next?.id !== workspace?.id) {
      retireReads();workspace = next;query = '';search = undefined;directories.clear();api.clearPreview();
    }
    if (workspace && api.ui.files.areToolsOpen() && !directories.has('') && !api.disabled()) void load('');
    paint();
  }
  function find(value: string): void {
    if (!alive || api.disabled()) return;
    query = value;clearTimeout(timer);reads.get(':search')?.abort();reads.delete(':search');
    search = query.trim() ? {entries: [],loading: true} : undefined;paint();
    if (query.trim()) timer = setTimeout(() => {timer = undefined;void load('',true);},250);
  }
  async function refresh(): Promise<void> {
    if (!alive || api.disabled()) return;
    retireReads();api.clearPreview();const generation = epoch;
    if (query.trim()) {await load('',true);return;}
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
  return {sync,find,refresh,action,
    toggle(target: Target,expanded: boolean): void {
      if (!alive || api.disabled() || target.workspaceId !== workspace?.id) return;
      const directory = directories.get(target.path);
      if (directory) {directories.set(target.path,{...directory,expanded});paint();}
      if (expanded && (!directory || directory.error || directory.loading && !reads.has(target.path))) void load(target.path);
    },
    destroy(): void {if (!alive) return;alive = false;retireReads();directories.clear();},
  };
}
