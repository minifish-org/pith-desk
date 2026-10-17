/** Internal executable shell/navigation recipe. Conversation, composer, files
 * and task bodies are composed separately as caller-owned small parts. */
import {
  createActionsPart, createActivityPart, createBrandMarkPart, createBrandPart, createBreadcrumbPart, createButtonPart,
  createConnectionIndicatorPart, createDrawerPart, createFramePart, createMainPart, createMenuPart, createRailFooterPart,
  createRailHeadingPart, createSearchFieldPart, createSideRailPart, createTextPart, createTopbarPart, createTopbarActionsPart, createTreeBranchPart,
  createTreeItemPart, createTreePart, mountParts,
  type ActivityPart, type BrandMarkOptions, type ButtonPart, type DialogPart, type FramePart, type MenuPartItem,
  type MountPartsOptions, type Part, type TextPart, type TreeBranchPart, type TreeItemPart,
} from 'pith-ui';

type HostResult = void | {ok: true} | {ok: false; error: string};
export interface FrameConversation {
  id: string; title?: string; active: boolean; status?: {kind: 'approval'|'running'|'unread'|'idle'};
  actions?: {rename?: boolean; history?: boolean; export?: boolean; delete?: boolean};
}
export interface FrameWorkspace {id: string; name: string; path: string; selected: boolean; children: readonly FrameConversation[]; canRemove?: boolean}
export interface FrameState {
  workspace?: string; conversation?: string; reconnecting?: boolean;
  navigation: {groups: readonly FrameWorkspace[]; empty: 'workspaces'|'search'|null; disabled?: boolean};
  compactDisabled?: boolean;
  availability?: {busy?: boolean; conversations?: readonly string[]; workspaces?: readonly string[]};
}
export interface FrameCallbacks {
  onAction?(action: 'workspace'|'resources'|'connections'|'settings'|'compact'): HostResult | Promise<HostResult>;
  onSelectConversation?(id: string): void; onNewConversation?(id: string): void;
  onWorkspaceAction?(action: 'remove', id: string): HostResult | Promise<HostResult>;
  onConversationAction?(action: 'rename'|'history'|'export'|'delete', id: string): HostResult | Promise<HostResult>;
  onSearch?(query: string): void; onError?(message: string): void;
  onModalChange?(open: boolean): void;onDispose?(): void;
}
export interface FrameContent {
  /** Already composed conversation/composer bodies, in their native main order. */
  main?: readonly Part[];
  dialogs?: readonly DialogPart[];
  /** Caller-composed live regions/notices, directly owned beside the main. */
  siblings?: readonly Part[];
  topbarActions?: readonly Part[];
  brand?: {name: string; qualifier?: string; mark?: BrandMarkOptions};
}
export interface FrameAssembly {
  update(state: Readonly<FrameState>): void; search(query: string): void;
  setSidebarOpen(open: boolean): void; isSidebarOpen(): boolean;
  closeNavigationMenu(): void; setAppearance(appearance: 'light'|'dark'|'system'): void; destroy(): void;
}
export interface FrameComposition extends Omit<FrameAssembly, 'setAppearance'> {readonly part: FramePart;replaceOverlays(parts: readonly DialogPart[]): void;replaceTopbarActions(parts: readonly Part[]): void}

export function composeFrame(initial: Readonly<FrameState>, callbacks: FrameCallbacks = {}, content: FrameContent = {}): FrameComposition {
  let state = initial, alive = true, query = '', activeConversation = '', workspace = initial.workspace ?? 'No workspace', conversation = initial.conversation ?? 'New conversation';
  const expanded = new Map<string, boolean>();
  type Branch = {part: TreeBranchPart; data: FrameWorkspace; more: ButtonPart; create: ButtonPart; empty?: TextPart};
  type Row = {part: TreeItemPart; data: FrameConversation; more: ButtonPart; status?: ActivityPart};
  const branches = new Map<string, Branch>(), rows = new Map<string, Row>();
  let menuTarget: {kind: 'workspace'|'conversation'; id: string} | undefined;
  let emptyWorkspace: ButtonPart | undefined, emptySearch: TextPart | undefined;
  const fail = (error: unknown) => {if (alive) callbacks.onError?.(error instanceof Error ? error.message : String(error));};
  const run = (callback: (() => HostResult | Promise<HostResult>) | undefined) => {
    if (!alive || !callback) return;
    try {const value = callback();if (value != null && typeof value === 'object' && 'then' in value) void Promise.resolve(value).then(result => {if (alive && result && !result.ok) fail(result.error);}).catch(fail);else if (value && !value.ok) fail(value.error);}
    catch (error) {fail(error);}
  };
  const brand = content.brand ?? {name: 'Pith', qualifier: 'Desk', mark: {symbol: 'pith' as const, alt: ''}};
  const brandPart = createBrandPart({name: brand.name, qualifier: brand.qualifier, ...(brand.mark ? {mark: createBrandMarkPart(brand.mark)} : {})});
  const manage = createButtonPart({variant: 'quiet-icon', icon: 'plus', label: 'Manage workspaces', onAction() {run(() => callbacks.onAction?.('workspace'));}});
  const heading = createRailHeadingPart({label: 'WORKSPACES', actions: [manage]});
  const searchField = createSearchFieldPart({label: 'Search conversation titles', placeholder: 'Search conversations', onInput: search});
  const navigation = createTreePart({label: 'Workspaces and conversations', children: []});
  const utilities = ([['resources', 'file', 'Workspace resources'], ['connections', 'plug', 'Connections'], ['settings', 'settings', 'Settings']] as const)
    .map(([action, icon, label]) => createButtonPart({variant: 'navigation', icon, label, onAction() {run(() => callbacks.onAction?.(action));}}));
  const connection = createConnectionIndicatorPart({message: 'Reconnecting…', hidden: !initial.reconnecting});
  const footer = createRailFooterPart({children: [...utilities, connection]});
  const rail = createSideRailPart({children: [brandPart, heading, searchField, navigation, footer]});
  const trigger = createButtonPart({variant: 'drawer-trigger', icon: 'menu', label: 'Open sidebar'});
  const breadcrumb = createBreadcrumbPart({ancestor: workspace, current: conversation});
  const compact = createButtonPart({variant: 'toolbar-action', icon: 'compress', label: 'Compact', accessibleLabel: 'Compress context', title: 'Compress context by summarizing older messages', disabled: initial.compactDisabled ?? true, onAction() {return callbacks.onAction?.('compact');}, onError: fail});
  const topbarActions = createTopbarActionsPart({children: [compact,...content.topbarActions ?? []]});
  const topbar = createTopbarPart({children: [trigger, breadcrumb,topbarActions]});
  const main = createMainPart({children: [topbar, ...content.main ?? []]}), part = createFramePart({children: [],onDispose: retire,onModalChange: callbacks.onModalChange});
  const drawer = createDrawerPart({scope: part, panel: rail, content: main, trigger});
  const menu = createMenuPart({label: 'Conversation actions', items: [], onToggle(open) {if (!open) menuTarget = undefined; syncMenuButtons();}, onError: fail});
  part.replace([rail, menu, drawer, main, ...content.siblings ?? [], ...content.dialogs ?? []]);

  function syncMenuButtons(): void {
    if (!alive) return;
    for (const branch of branches.values()) {
      branch.more.update({variant: 'quiet-icon', icon: 'more', label: 'Actions for workspace ' + branch.data.name, menuExpanded: menuTarget?.kind === 'workspace' && menuTarget.id === branch.data.id, disabled: !!state.navigation.disabled});
      branch.create.update({variant: 'quiet-icon', icon: 'compose', label: 'New conversation in ' + branch.data.name, title: 'New conversation', disabled: !!state.navigation.disabled});
    }
    for (const row of rows.values()) row.more.update({variant: 'quiet-icon', icon: 'more', label: 'Actions for ' + (row.data.title || 'Untitled conversation'), menuExpanded: menuTarget?.kind === 'conversation' && menuTarget.id === row.data.id, disabled: !!state.navigation.disabled});
  }
  function closeNavigationMenu(): void {menu.close(); menuTarget = undefined; syncMenuButtons();}
  function itemsFor(target: NonNullable<typeof menuTarget>): MenuPartItem[] {
    const disabled = !!state.navigation.disabled || !!state.availability?.busy;
    if (target.kind === 'workspace') {
      const group = state.navigation.groups.find(group => group.id === target.id);
      return [{key: 'remove', label: 'Remove workspace', intent: 'danger', disabled: disabled || !!state.availability?.workspaces?.includes(target.id) || group?.canRemove === false,
        onAction() {closeNavigationMenu(); run(() => callbacks.onWorkspaceAction?.('remove', target.id));}}];
    }
    const entry = state.navigation.groups.flatMap(group => group.children).find(entry => entry.id === target.id);
    return ([['rename', 'Rename'], ['history', 'Conversation branches'], ['export', 'Export Markdown'], ['delete', 'Delete conversation']] as const)
      .filter(([action]) => action !== 'history' || !!entry?.active)
      .map(([action, label]) => ({key: action, label, intent: action === 'delete' ? 'danger' : 'neutral', disabled: disabled || !!state.availability?.conversations?.includes(target.id) || entry?.actions?.[action] === false,
        onAction() {closeNavigationMenu(); run(() => callbacks.onConversationAction?.(action, target.id));}}));
  }
  function showMenu(target: NonNullable<typeof menuTarget>, source: ButtonPart): void {
    if (menuTarget?.kind === target.kind && menuTarget.id === target.id) {closeNavigationMenu(); return;}
    closeNavigationMenu(); menuTarget = target; menu.update({label: target.kind === 'conversation' ? 'Conversation actions' : 'Workspace actions', items: itemsFor(target)}); menu.open(source); syncMenuButtons();
  }
  function makeBranch(data: FrameWorkspace): Branch {
    let branch: Branch;
    const more = createButtonPart({variant: 'quiet-icon', icon: 'more', label: 'Actions for workspace ' + data.name, menuExpanded: false, onAction() {showMenu({kind: 'workspace', id: data.id}, more);}});
    const create = createButtonPart({variant: 'quiet-icon', icon: 'compose', label: 'New conversation in ' + data.name, title: 'New conversation', onAction() {closeNavigationMenu(); callbacks.onNewConversation?.(data.id);}});
    const tree = createTreeBranchPart({label: data.name, path: data.path, selected: data.selected, expanded: expanded.get(data.id) ?? data.selected, actions: [more, create], children: [], onToggle(open) {expanded.set(data.id, open);}});
    branch = {part: tree, data, more, create}; return branch;
  }
  function makeRow(data: FrameConversation): Row {
    let row: Row;
    const more = createButtonPart({variant: 'quiet-icon', icon: 'more', label: 'Actions for ' + (data.title || 'Untitled conversation'), menuExpanded: false, onAction() {showMenu({kind: 'conversation', id: data.id}, more);}});
    const status = data.status ? createActivityPart(data.status) : undefined;
    const tree = createTreeItemPart({label: data.title || 'Untitled conversation', current: data.active, actions: [more], status, onSelect() {closeNavigationMenu(); drawer.setOpen(false); callbacks.onSelectConversation?.(row.data.id);}});
    row = {part: tree, data, more, status}; return row;
  }
  function renderNavigation(): void {
    if (!alive) return;
    const searched = query.trim().toLocaleLowerCase();
    const groups = state.navigation.groups.map(group => ({...group, children: group.children.filter(entry => !searched || (entry.title || '').toLocaleLowerCase().includes(searched))})).filter(group => !searched || group.children.length);
    const wantedGroups = new Set(groups.map(group => group.id)), wantedRows = new Set(groups.flatMap(group => group.children.map(entry => JSON.stringify([group.id, entry.id]))));
    for (const [key, row] of rows) if (!wantedRows.has(key)) {row.part.destroy(); rows.delete(key);}
    for (const [key, group] of branches) if (!wantedGroups.has(key)) {group.part.destroy(); branches.delete(key);}
    const children: Part[] = [];
    for (const group of groups) {
      let branch = branches.get(group.id); if (!branch) {branch = makeBranch(group); branches.set(group.id, branch);} branch.data = group;
      branch.part.update({label: group.name, path: group.path, selected: group.selected}); branch.part.setExpanded(searched ? true : expanded.get(group.id) ?? group.selected);
      const leaves: Part[] = [];
      for (const entry of group.children) {
        const key = JSON.stringify([group.id, entry.id]); let row = rows.get(key); if (!row) {row = makeRow(entry); rows.set(key, row);} row.data = entry;
        row.part.update({label: entry.title || 'Untitled conversation', current: entry.active, disabled: !!state.navigation.disabled});
        if (entry.status) {if (!row.status) {row.status = createActivityPart(entry.status); row.part.setStatus(row.status);} else row.status.update(entry.status);}
        else if (row.status) {row.part.setStatus(); row.status = undefined;} leaves.push(row.part);
      }
      if (!leaves.length) {branch.empty ??= createTextPart({role: 'paragraph', text: 'No conversations yet'}); leaves.push(branch.empty);} else branch.empty = undefined;
      branch.part.replace(leaves); children.push(branch.part);
    }
    const empty = searched && !groups.length ? 'search' : state.navigation.empty;
    if (empty === 'workspaces') {emptyWorkspace ??= createButtonPart({variant: 'navigation-item', icon: 'folder', label: 'Add a workspace', disabled: !!state.navigation.disabled, onAction() {run(() => callbacks.onAction?.('workspace'));}}); emptyWorkspace.update({variant: 'navigation-item', icon: 'folder', label: 'Add a workspace', disabled: !!state.navigation.disabled}); children.push(emptyWorkspace);} else emptyWorkspace = undefined;
    if (empty === 'search') {emptySearch ??= createTextPart({role: 'paragraph', text: 'No matching conversations.'}); children.push(emptySearch);} else emptySearch = undefined;
    navigation.replace(children); syncMenuButtons();
    if (menuTarget) menu.update({label: menuTarget.kind === 'conversation' ? 'Conversation actions' : 'Workspace actions', items: itemsFor(menuTarget)});
  }
  function search(value: string): void {if (!alive) return; query = value; renderNavigation(); callbacks.onSearch?.(value);}
  function update(next: Readonly<FrameState>): void {
    if (!alive) return; state = next;
    if (next.workspace !== undefined) workspace = next.workspace; if (next.conversation !== undefined) conversation = next.conversation;
    breadcrumb.update({ancestor: workspace, current: conversation}); connection.update({message: 'Reconnecting…', hidden: !next.reconnecting});
    compact.update({variant: 'toolbar-action', icon: 'compress', label: 'Compact', accessibleLabel: 'Compress context', title: 'Compress context by summarizing older messages', disabled: next.compactDisabled ?? true});
    const active = next.navigation.groups.flatMap(group => group.children.filter(entry => entry.active).map(entry => ({workspace: group.id, conversation: entry.id})))[0];
    if (active && active.conversation !== activeConversation) expanded.set(active.workspace, true); activeConversation = active?.conversation ?? '';
    const ids = new Set(next.navigation.groups.map(group => group.id)); for (const id of expanded.keys()) if (!ids.has(id)) expanded.delete(id);
    if (menuTarget && !next.navigation.groups.some(group => menuTarget!.kind === 'workspace' ? group.id === menuTarget!.id : group.children.some(entry => entry.id === menuTarget!.id))) closeNavigationMenu();
    renderNavigation();
  }
  update(initial);
  function retire(): void {
    if (!alive) return;alive = false;menuTarget = undefined;branches.clear();rows.clear();expanded.clear();emptyWorkspace = undefined;emptySearch = undefined;callbacks.onDispose?.();
  }
  return {part, update, search, closeNavigationMenu, setSidebarOpen: drawer.setOpen, isSidebarOpen: drawer.isOpen,
    replaceOverlays(parts) {if (alive) part.replace([rail,menu,drawer,main,...content.siblings ?? [],...parts]);},
    replaceTopbarActions(parts) {if (alive) topbarActions.replace([compact,...parts]);},
    destroy() {part.destroy();}};
}

/** Standalone demo boundary. Integrated applications call composeFrame and
 * mount its part once, with all composed dialog parts in the same child tree. */
export function mountFrame(mount: HTMLElement, state: Readonly<FrameState>, callbacks: FrameCallbacks = {}, appearance: MountPartsOptions = {}, content: FrameContent = {}): FrameAssembly {
  const frame = composeFrame(state, callbacks, content);
  try {const mounted = mountParts(mount, frame.part, appearance); return {...frame, setAppearance: mounted.setAppearance};}
  catch (error) {frame.destroy(); throw error;}
}
