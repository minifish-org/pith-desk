import type {State} from '@/app-state.ts';
import type {Conversation, PermissionMode, RunSummary, Workspace} from '@/contract.generated.ts';

export type RunStatus = 'approval' | 'running' | 'unread' | 'idle';

export function selectedWorkspace(state: State, selectedId: string): Workspace | undefined {
  const conversation = state.conversations.find(entry => entry.id === state.activeId);
  return state.workspaces.find(entry => entry.id === (conversation?.workspaceId || selectedId)) ?? state.workspaces[0];
}

export function conversationRunning(state: State, id: string | null): boolean {
  return state.runs.some(run => run.conversationId === id);
}

export function workspaceRun(state: State, id?: string): RunSummary | undefined {
  const workspace = state.workspaces.find(entry => entry.id === id);
  if (!workspace) return undefined;
  const contains = (a: string, b: string) => a === b || b.startsWith(a.replace(/\/$/, '') + '/');
  return state.runs.find(run => {
    const other = state.workspaces.find(entry => entry.id === run.workspaceId);
    return !!other && (contains(workspace.path, other.path) || contains(other.path, workspace.path));
  });
}

export function runStatus(state: State, conversation: Conversation): RunStatus {
  const run = state.runs.find(entry => entry.conversationId === conversation.id);
  if (run?.needsApproval) return 'approval';
  if (run) return 'running';
  if (conversation.unread) return 'unread';
  return 'idle';
}

export function activePermissionMode(state: State): PermissionMode {
  const mode = state.conversations.find(entry => entry.id === state.activeId)?.permissionMode;
  return mode === 'workspace-write' || mode === 'full-access' ? mode : 'ask';
}

export const permissionDescription: Record<PermissionMode, string> = {
  ask: 'Pith can read workspace files. Changes, commands, and external connection tools require approval.',
  'workspace-write': 'Workspace file changes are allowed. Commands and external connection tools still require approval.',
  'full-access': 'Full access: all enabled tools, including external connections, run without asking. There is no OS sandbox.',
};

const activeRunPhases = new Set(['starting', 'working', 'tool', 'retrying', 'compacting']);

export function taskElapsed(state: State, receivedAt: number): number {
  const timing = state.runtime?.timing;
  if (!timing?.startedAt) return 0;
  // Anchor to the host's monotonic duration; app downtime never becomes run time.
  const live = state.running && activeRunPhases.has(state.runtime.phase) && !timing.partial;
  return Math.max(0, timing.elapsedMs + (live ? performance.now() - receivedAt : 0));
}

export type ComposerAction = 'send' | 'queue' | 'stop';

export function composerPlaceholder(state: State, loaded: boolean, workspace: Workspace | undefined, blocked: RunSummary | undefined): string {
  if (!loaded) return 'Connecting to Pith…';
  if (!state.settings.hasApiKey) return state.settings.hasConnections ? 'Choose a model beside the message box' : 'Connect a provider in Settings to get started';
  if (!workspace) return 'Choose a workspace to get started';
  if (state.running) return 'Send a message to queue it…';
  if (blocked) return 'Another task is running in this workspace. Open its conversation to queue a message.';
  return 'Ask Pith to help with your work…';
}
