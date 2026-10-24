import {create} from 'zustand';

export type ToolKind = 'files' | 'terminal' | 'preview';
export interface FileViewState {expanded: string[]; scrollTop?: number}
export interface ToolTab {id: string; kind: ToolKind; label: string; files?: FileViewState}
export interface ToolLayout {tabs: ToolTab[]; activeId: string; next: {files: number; terminal: number}}
export interface WebPreviewState {address: string; current: string; pending: boolean; error: string; opened: boolean}

interface WorkspaceTools {layout: ToolLayout; closing: string}
interface WorkspaceToolsStore {
  workspaces: Record<string, WorkspaceTools>;
  previews: Record<string, WebPreviewState>;
  setWorkspace(id: string, tools: WorkspaceTools): void;
  removeWorkspace(id: string): void;
  setPreview(id: string, preview: WebPreviewState | null): void;
}

export const emptyToolLayout: ToolLayout = {tabs: [], activeId: '', next: {files: 2, terminal: 1}};
export const emptyWebPreview: WebPreviewState = {address: '', current: '', pending: false, error: '', opened: false};

// Tool views outlive their rail/drawer. Each workspace keeps its own layout so
// an asynchronous close cannot replace the workspace currently on screen.
export const useWorkspaceTools = create<WorkspaceToolsStore>(set => ({
  workspaces: {},
  // Addresses and native-page state live only in memory, outside saved layouts.
  previews: {},
  setWorkspace: (id, tools) => set(previous => ({workspaces: {...previous.workspaces, [id]: tools}})),
  removeWorkspace: id => set(previous => {
    const workspaces = {...previous.workspaces};
    delete workspaces[id];
    return {workspaces};
  }),
  setPreview: (id, preview) => set(previous => {
    const previews = {...previous.previews};
    if (preview) previews[id] = preview;
    else delete previews[id];
    return {previews};
  }),
}));
