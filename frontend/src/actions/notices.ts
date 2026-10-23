import {request} from './core.ts';
import {desk, type Notice} from '@/stores/desk.ts';
import {app} from '@/lib/runtime.ts';

const seen = new Set<string>();
const reading = new Set<string>();
let notices: Notice[] = [];
let noticeSignature = '';

export function foreground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function viewing(id: string): boolean {
  return foreground() && desk().state.activeId === id && desk().modals.length === 0;
}

function renderNotices(): void {
  const signature = JSON.stringify(notices);
  if (signature === noticeSignature) return;
  noticeSignature = signature;
  desk().setNotices([...notices]);
}

export function dismissNotice(runID: string): void {
  notices = notices.filter(notice => notice.runID !== runID);
  renderNotices();
}

export function observeNotices(initialized: boolean): void {
  const state = desk().state;
  for (const entry of state.conversations) {
    const runID = entry.completedRunId;
    if (!runID || seen.has(runID)) continue;
    seen.add(runID);
    if (initialized && entry.unread && foreground() && !viewing(entry.id)) {
      notices.push({
        id: entry.id,
        runID,
        title: entry.title || 'Untitled conversation',
        workspace: state.workspaces.find(workspace => workspace.id === entry.workspaceId)?.name || 'Workspace',
      });
    }
  }
  notices = notices.filter(notice => state.conversations.some(entry => entry.id === notice.id && entry.unread && entry.completedRunId === notice.runID)).slice(-3);
  renderNotices();
  acknowledgeViewed();
}

export function acknowledgeViewed(): void {
  const state = desk().state;
  const entry = state.conversations.find(item => viewing(item.id) && item.unread && item.completedRunId);
  if (!entry?.completedRunId || reading.has(entry.completedRunId)) return;
  const runID = entry.completedRunId;
  reading.add(runID);
  void request('/api/read', {id: entry.id, runId: runID}).then(() => {
    app().confirmRead(entry.id, runID);
    dismissNotice(runID);
  }).catch(() => {
    // Preserve unread on a failed acknowledgement. A later focus or state
    // change can retry; this must never interrupt the user's task.
  }).finally(() => reading.delete(runID));
}

export function clearNotices(): void {
  notices = [];
  renderNotices();
}
