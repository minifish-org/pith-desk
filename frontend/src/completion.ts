import type { Conversation } from './contract.generated';
import type { State } from './app-state';
import type { ApiRequest } from './api';
import { createCompletionNotices, historyStatusMarkup } from 'pith-ui';
type CompletionState = Pick<State, 'activeId' | 'conversations' | 'workspaces' | 'runs'>;
interface Notice { id: string; runID: string; title: string; workspace: string }

export function createCompletionUI(deps: {
  state: () => CompletionState;
  request: ApiRequest;
  confirmRead: (id: string, runID: string) => void;
  renderHistory: () => void;
  escape: (value: unknown) => string;
  icon: (name: string) => string;
}) {
  const panel = createCompletionNotices({ container: document.getElementById('completion-notices')! });
  const seen = new Set<string>();
  const reading = new Set<string>();
  let notices: Notice[] = [];
  let noticeSignature = '';
  const foreground = () => document.visibilityState === 'visible' && document.hasFocus();
  const viewing = (id: string) => foreground() && deps.state().activeId === id && !document.querySelector('dialog[open]');

  function renderNotices(): void {
    const signature = JSON.stringify(notices);
    if (signature === noticeSignature) return;
    noticeSignature = signature;
    panel.update(notices);
  }

  function dismiss(runID: string): void {
    notices = notices.filter((notice) => notice.runID !== runID);
    renderNotices();
  }

  function acknowledgeViewed(): void {
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

  function historyStatus(entry: Conversation): string {
    const run = deps.state().runs.find((run) => run.conversationId === entry.id);
    return historyStatusMarkup(run?.needsApproval ? 'approval' : run ? 'running' : entry.unread ? 'unread' : 'idle');
  }

  return { observe, acknowledgeViewed, dismiss, historyStatus, destroy: panel.destroy };
}
