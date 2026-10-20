import type { Conversation } from './contract.generated';
import type { State } from './app-state';
import type { ApiRequest } from './api';
import type { Application, NavigationStatus } from './ui-contract.ts';
type CompletionState = Pick<State, 'activeId' | 'conversations' | 'workspaces' | 'runs'>;
interface Notice { id: string; runID: string; title: string; workspace: string }

export function createCompletionUI(deps: {
  ui: Application;
  state: () => CompletionState;
  request: ApiRequest;
  confirmRead: (id: string, runID: string) => void;
  renderHistory: () => void;
  foreground: () => boolean;
}) {
  const seen = new Set<string>();
  const reading = new Set<string>();
  let notices: Notice[] = [];
  let noticeSignature = '';
  let destroyed = false;
  const foreground = deps.foreground;
  const viewing = (id: string) => foreground() && deps.state().activeId === id && !deps.ui.read().hasModal;

  function renderNotices(): void {
    const signature = JSON.stringify(notices);
    if (signature === noticeSignature) return;
    noticeSignature = signature;
    deps.ui.workspace.updateNotices(notices);
  }

  function dismiss(runID: string): void {
    notices = notices.filter((notice) => notice.runID !== runID);
    renderNotices();
  }

  function acknowledgeViewed(): void {
    if (destroyed) return;
    const entry = deps.state().conversations.find((entry) => viewing(entry.id) && entry.unread && entry.completedRunId);
    if (!entry?.completedRunId || reading.has(entry.completedRunId)) return;
    const runID = entry.completedRunId;
    reading.add(runID);
    void deps.request('/api/read', { id: entry.id, runId: runID }).then(() => {
      deps.confirmRead(entry.id, runID);
      dismiss(runID);
      deps.renderHistory();
    }).catch(() => {
      // Preserve unread on a failed acknowledgement. A later focus or state
      // change can retry; this must never interrupt the user's task.
    }).finally(() => reading.delete(runID));
  }

  function observe(initialized: boolean): void {
    if (destroyed) return;
    const state = deps.state();
    for (const entry of state.conversations) {
      const runID = entry.completedRunId;
      if (!runID || seen.has(runID)) continue;
      seen.add(runID);
      if (initialized && entry.unread && foreground() && !viewing(entry.id)) {
        notices.push({ id: entry.id, runID, title: entry.title || 'Untitled conversation', workspace: state.workspaces.find((workspace) => workspace.id === entry.workspaceId)?.name || 'Workspace' });
      }
    }
    notices = notices.filter((notice) => state.conversations.some((entry) => entry.id === notice.id && entry.unread && entry.completedRunId === notice.runID)).slice(-3);
    renderNotices();
    acknowledgeViewed();
  }

  function historyStatus(entry: Conversation): NavigationStatus {
    const run = deps.state().runs.find((run) => run.conversationId === entry.id);
    return {kind: run?.needsApproval ? 'approval' : run ? 'running' : entry.unread ? 'unread' : 'idle'};
  }

  return { observe, acknowledgeViewed, dismiss, historyStatus, destroy() {destroyed = true;notices = [];renderNotices();} };
}
