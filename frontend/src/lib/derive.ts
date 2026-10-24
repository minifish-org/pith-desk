import type {State} from '@/app-state.ts';
import type {Conversation, RunSummary, Workspace} from '@/contract.generated.ts';

// Pure projections of the host snapshot. These helpers never request, persist
// or mutate; actions and components use them so the same question always has
// one answer.

export type RunStatus = 'approval' | 'running' | 'unread' | 'idle';

export function activeConversation(state: State): Conversation | undefined {
  return state.conversations.find(entry => entry.id === state.activeId);
}

/** The workspace the active conversation belongs to, or the selected one when
 * no conversation is open. Returns `undefined` rather than guessing so callers
 * can decide whether a fallback workspace is appropriate. */
export function activeWorkspace(state: State, selectedId: string): Workspace | undefined {
  const id = activeConversation(state)?.workspaceId || selectedId;
  return state.workspaces.find(entry => entry.id === id);
}

/** The workspace shown by the shell and used for new conversations. */
export function selectedWorkspace(state: State, selectedId: string): Workspace | undefined {
  return activeWorkspace(state, selectedId) ?? state.workspaces[0];
}

export function conversationRunning(state: State, id: string | null): boolean {
  return state.runs.some(run => run.conversationId === id);
}

/** A run that overlaps this workspace, including one in a nested workspace.
 * The host allows one task per physical tree, so this is the run that currently
 * blocks changes here. */
export function blockingWorkspaceRun(state: State, id?: string): RunSummary | undefined {
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
