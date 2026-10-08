interface Conversation {
  id: string;
  title: string;
  workspaceId: string;
  completedRunId?: string;
  unread?: boolean;
}
interface CompletionState {
  activeId: string | null;
  conversations: Conversation[];
  workspaces: { id: string; name: string }[];
  runs: { conversationId: string; needsApproval: boolean }[];
}
interface Notice { id: string; runID: string; title: string; workspace: string }

export function createCompletionUI(deps: {
  state: () => CompletionState;
  request: <T>(path: string, payload?: unknown) => Promise<T>;
  renderHistory: () => void;
  escape: (value: unknown) => string;
  icon: (name: string) => string;
}) {
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
    document.getElementById('completion-notices')!.innerHTML = notices.map((notice) => `<article class="completion-notice"><span class="completion-check" aria-hidden="true">${deps.icon('check')}</span><div class="completion-content"><strong>Task completed</strong><p>${deps.escape(notice.workspace)} · ${deps.escape(notice.title)}</p><button class="text-button" type="button" data-conversation="${deps.escape(notice.id)}">Open conversation</button></div><button class="quiet-icon completion-dismiss" type="button" data-dismiss-completion="${deps.escape(notice.runID)}" aria-label="Dismiss completion notification">${deps.icon('close')}</button></article>`).join('');
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
      const current = deps.state().conversations.find((current) => current.id === entry.id);
      if (current?.completedRunId === runID) current.unread = false;
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
    if (run?.needsApproval) return '<span class="history-status needs-approval" role="img" aria-label="Waiting for approval" title="Waiting for approval"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></svg></span>';
    if (run) return '<span class="history-status" role="img" aria-label="Running" title="Running"><i class="history-spinner" aria-hidden="true"></i></span>';
    if (entry.unread) return '<span class="history-status" role="img" aria-label="Completed, unread" title="Completed, unread"><i class="history-unread" aria-hidden="true"></i></span>';
    return '<span class="history-status" aria-hidden="true"></span>';
  }

  return { observe, acknowledgeViewed, dismiss, historyStatus };
}
