import {create} from 'zustand';

export type ToolKind = 'files' | 'terminal' | 'preview';
export interface FileViewState {expanded: string[]; scrollTop?: number}
export interface ToolTab {id: string; kind: ToolKind; label: string; files?: FileViewState}
export interface ToolLayout {tabs: ToolTab[]; activeId: string; next: {files: number; terminal: number}}

interface WorkspaceTools {layout: ToolLayout; closing: string}
interface WorkspaceToolsStore {
  workspaces: Record<string, WorkspaceTools>;
  setWorkspace(id: string, tools: WorkspaceTools): void;
}

export const emptyToolLayout: ToolLayout = {tabs: [], activeId: '', next: {files: 2, terminal: 1}};

// Tool views outlive their rail/drawer. Each workspace keeps its own layout so
// an asynchronous close cannot replace the workspace currently on screen.
export const useWorkspaceTools = create<WorkspaceToolsStore>(set => ({
  workspaces: {},
  setWorkspace: (id, tools) => set(previous => ({workspaces: {...previous.workspaces, [id]: tools}})),
}));
