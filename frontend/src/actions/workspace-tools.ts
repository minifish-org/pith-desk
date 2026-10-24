import {request} from './core.ts';
import {useWorkspaceTools, type FileViewState, type ToolKind, type ToolLayout, type ToolTab} from '@/stores/workspace-tools.ts';

const storagePrefix = 'pith-desk.tools.v1.';
const newID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

function readLayout(workspaceId: string): ToolLayout {
  try {
    const raw = localStorage.getItem(storagePrefix + workspaceId);
    if (raw && raw.length < 2 * 1024 * 1024) {
      const value = JSON.parse(raw) as ToolLayout;
      if (Array.isArray(value.tabs) && value.tabs.length <= 32) {
        const tabs = value.tabs
          .filter(tab => tab && typeof tab.id === 'string' && ['files', 'terminal', 'preview'].includes(tab.kind))
          .map(tab => ({
            id: tab.id, kind: tab.kind, label: tab.label,
            ...(tab.kind === 'files' ? {files: {expanded: Array.isArray(tab.files?.expanded) ? tab.files.expanded.filter(path => typeof path === 'string').slice(0, 256) : [], scrollTop: tab.files?.scrollTop}} : {}),
          }));
        // A saved empty layout is intentional: closing every tab is remembered.
        const activeId = tabs.some(tab => tab.id === value.activeId) ? value.activeId : tabs[0]?.id || '';
        return {tabs, activeId, next: {files: value.next?.files || 2, terminal: value.next?.terminal || 1}};
      }
    }
  } catch { /* Fall through to a fresh layout. */ }
  const id = newID();
  return {tabs: [{id, kind: 'files', label: 'Files', files: {expanded: []}}], activeId: id, next: {files: 2, terminal: 1}};
}

export function loadWorkspaceTools(workspaceId: string): void {
  const store = useWorkspaceTools.getState();
  if (workspaceId && !store.workspaces[workspaceId]) store.setWorkspace(workspaceId, {layout: readLayout(workspaceId), closing: ''});
}

function saveLayout(workspaceId: string, layout: ToolLayout): void {
  const store = useWorkspaceTools.getState();
  const current = store.workspaces[workspaceId];
  if (!current) return;
  store.setWorkspace(workspaceId, {...current, layout});
  try {localStorage.setItem(storagePrefix + workspaceId, JSON.stringify(layout));} catch { /* Layout is a preference. */ }
}

export function createToolTab(workspaceId: string, kind: ToolKind): void {
  const layout = useWorkspaceTools.getState().workspaces[workspaceId]?.layout;
  if (!layout || layout.tabs.length >= 32) return;
  const next = {...layout.next};
  const number = kind === 'preview' ? 1 : next[kind]++;
  const label = kind === 'files' ? (number === 1 ? 'Files' : `Files ${number}`) : kind === 'terminal' ? (number === 1 ? 'Terminal' : `Terminal ${number}`) : 'Web';
  const tab: ToolTab = {id: newID(), kind, label, ...(kind === 'files' ? {files: {expanded: []}} : {})};
  saveLayout(workspaceId, {...layout, tabs: [...layout.tabs, tab], activeId: tab.id, next});
}

export function selectToolTab(workspaceId: string, id: string): void {
  const layout = useWorkspaceTools.getState().workspaces[workspaceId]?.layout;
  if (layout?.tabs.some(tab => tab.id === id)) saveLayout(workspaceId, {...layout, activeId: id});
}

export function updateFileView(workspaceId: string, id: string, patch: Partial<FileViewState>): void {
  const layout = useWorkspaceTools.getState().workspaces[workspaceId]?.layout;
  if (!layout?.tabs.some(tab => tab.id === id && tab.kind === 'files')) return;
  const tabs = layout.tabs.map(tab => tab.id === id ? {...tab, files: {expanded: [], ...tab.files, ...patch}} : tab);
  saveLayout(workspaceId, {...layout, tabs});
}

export async function closeToolTab(workspaceId: string, id: string): Promise<void> {
  const store = useWorkspaceTools.getState();
  const tools = store.workspaces[workspaceId];
  const entry = tools?.layout.tabs.find(tab => tab.id === id);
  if (!entry || tools.closing) return;
  store.setWorkspace(workspaceId, {...tools, closing: id});
  try {
    if (entry.kind === 'terminal') {
      // Explicitly closing a tab ends its shell. Hiding/unmounting the view
      // leaves the process running. A failed close still removes the local tab.
      try {await request('/api/terminal/close', {workspaceId, id});} catch { /* The tab closes anyway. */ }
    }
    // Resolve against the latest layout of the original workspace after the
    // request, preserving tabs and selection changed while it was pending.
    const layout = useWorkspaceTools.getState().workspaces[workspaceId].layout;
    const index = layout.tabs.findIndex(tab => tab.id === id);
    const tabs = layout.tabs.filter(tab => tab.id !== id);
    const activeId = layout.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id || '' : layout.activeId;
    saveLayout(workspaceId, {...layout, tabs, activeId});
  } finally {
    const current = useWorkspaceTools.getState().workspaces[workspaceId];
    useWorkspaceTools.getState().setWorkspace(workspaceId, {...current, closing: ''});
  }
}
