import {mutate, request, setError, copyText, download} from './core.ts';
import {closeModalId, desk, modalId, type Modal} from '@/stores/desk.ts';
import {activeConversation, blockingWorkspaceRun, conversationRunning, selectedWorkspace} from '@/lib/derive.ts';
import {permissionModeOf} from '@/lib/permissions.ts';
import {emitAppEvent} from '@/lib/events.ts';
import {saveBlob} from '@/lib/save.ts';
import {exportDiagnostics, openSettings} from './settings.ts';
import {openConnections} from './connections.ts';
import {openResources} from './resources.ts';
import {clearFilePreview, downloadConversationFile} from './files.ts';
import {acknowledgeViewed} from './notices.ts';
import type {PermissionMode, RunSummary} from '@/contract.generated.ts';

// Conversation and workspace lifecycle: open, create, rename, remove, export,
// permissions and the commands offered beside a conversation.

/** The workspace the shell currently presents. */
export function currentWorkspace(): ReturnType<typeof selectedWorkspace> {
  const state = desk().state;
  return selectedWorkspace(state, desk().selectedWorkspaceId);
}

/** The run that currently prevents changes in this workspace tree. */
export function blockedWorkspace(id?: string): RunSummary | undefined {
  return blockingWorkspaceRun(desk().state, id);
}

export function isConversationRunning(id: string | null): boolean {
  return conversationRunning(desk().state, id);
}

export async function selectConversation(id: string): Promise<void> {
  if (await mutate('/api/open', {id})) acknowledgeViewed();
}

export async function newConversation(workspaceId = currentWorkspace()?.id): Promise<void> {
  if (!workspaceId) {
    openWorkspace();
    return;
  }
  if (await mutate('/api/conversations', {workspaceId})) emitAppEvent('focusComposer');
}

export function openRename(id = desk().state.activeId): void {
  const conversation = desk().state.conversations.find(entry => entry.id === id);
  if (!conversation || isConversationRunning(id)) return;
  desk().openModal({kind: 'rename', id: modalId('rename'), conversationId: id, title: conversation.title || '', disabled: desk().activity.busy});
}

export async function submitRename(modalIdValue: string, id: string, title: string): Promise<boolean> {
  const modal = desk().modals.find(entry => entry.id === modalIdValue);
  if (!modal) return false;
  if (desk().activity.busy || isConversationRunning(id)) {
    desk().patchModal(modalIdValue, {error: 'This conversation is busy.'});
    return false;
  }
  const ok = await mutate('/api/rename', {id, title});
  if (ok) closeModalId(modalIdValue);
  else desk().patchModal(modalIdValue, {error: desk().activity.error});
  return ok;
}

export function openDeletion(kind: 'conversation' | 'workspace', id: string): void {
  const state = desk().state;
  const isBusy = () => (kind === 'workspace' ? !!blockingWorkspaceRun(state, id) : isConversationRunning(id)) || desk().activity.busy;
  if (isBusy()) return;
  const item = kind === 'workspace' ? state.workspaces.find(entry => entry.id === id) : state.conversations.find(entry => entry.id === id);
  if (!item) return;
  const count = state.conversations.filter(entry => entry.workspaceId === id).length;
  const name = 'name' in item ? item.name : item.title || 'Untitled conversation';
  const action = kind === 'workspace' ? 'Remove workspace' : 'Delete conversation';
  const description = kind === 'workspace'
    ? {before: 'Remove ', subject: name, after: ` from Pith Desk and permanently delete its ${count} ${count === 1 ? 'conversation' : 'conversations'}, including history, image attachments and run records?`}
    : {before: 'Permanently delete ', subject: name, after: ', including its history, image attachments and run records?'};
  const modal: Modal = {
    kind: 'confirm',
    id: modalId('confirm'),
    title: `${action}?`,
    action,
    description,
    hint: 'The folder and its files stay on your computer, including files created by Pith. Deleted conversation data cannot be recovered from Pith Desk.',
    disabled: isBusy(),
    error: '',
    async run() {
      const activeWorkspace = currentWorkspace()?.id, activeID = desk().state.activeId;
      const ok = await mutate(kind === 'workspace' ? '/api/remove-workspace' : '/api/delete-conversation', {id, ...(kind === 'workspace' ? {conversationCount: count} : {})});
      if (!ok) {
        desk().patchModal(modal.id, {error: desk().activity.error});
        return false;
      }
      if (kind === 'workspace' && desk().selectedWorkspaceId === id) desk().selectWorkspaceId('');
      if (activeID !== desk().state.activeId || activeWorkspace !== currentWorkspace()?.id) clearFilePreview();
      return true;
    },
  };
  desk().openModal(modal);
}

export async function exportConversation(id = desk().state.activeId): Promise<void> {
  const conversation = desk().state.conversations.find(entry => entry.id === id);
  if (!conversation || desk().activity.busy || isConversationRunning(id)) return;
  desk().setBusy(true);
  desk().setError('');
  try {
    const delivery = await request('/api/export', {id: conversation.id});
    if (delivery?.native === true) return;
    if (delivery?.native !== false) throw new Error('The local service returned an invalid export response.');
    await saveBlob(await download('/api/export', {id: conversation.id}), `${(conversation.title || 'Conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Conversation'}.md`);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    desk().setBusy(false);
  }
}

export function openWorkspace(): void {
  desk().openModal({kind: 'workspace', id: modalId('workspace'), error: ''});
}

export async function addWorkspace(path: string, modal: string): Promise<boolean> {
  if (desk().activity.busy) {
    desk().patchModal(modal, {error: 'Another operation is in progress.'});
    return false;
  }
  let addedWorkspaceId = '';
  const ok = await mutate('/api/workspaces', {path}, response => {
    if (!response?.workspace?.id) throw new Error('The local service did not return the added workspace.');
    addedWorkspaceId = response.workspace.id;
  });
  if (ok) {
    desk().selectWorkspaceId(addedWorkspaceId);
    closeModalId(modal);
    void newConversation(addedWorkspaceId);
    return true;
  }
  desk().patchModal(modal, {error: desk().activity.error});
  return false;
}

export async function pickWorkspace(): Promise<string | null> {
  try {
    const result = await request('/api/pick-workspace', {});
    return result?.path || null;
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function selectWorkspace(id: string): Promise<void> {
  const state = desk().state;
  if (!state.workspaces.some(entry => entry.id === id)) return;
  desk().selectWorkspaceId(id);
  const latest = state.conversations.filter(entry => entry.workspaceId === id).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (latest) await mutate('/api/open', {id: latest.id});
  else await newConversation(id);
}

export async function changePermission(mode: PermissionMode): Promise<void> {
  const id = desk().state.activeId;
  if (!id || desk().activity.busy || mode === permissionModeOf(activeConversation(desk().state))) return;
  if (mode === 'full-access') openFullAccess(id);
  else await mutate('/api/permissions', {id, mode});
}

function openFullAccess(id: string): void {
  const conversation = desk().state.conversations.find(entry => entry.id === id);
  desk().openModal({kind: 'full-access', id: modalId('full-access'), conversationId: id, title: conversation?.title || 'this conversation', disabled: desk().activity.busy});
}

export async function confirmFullAccess(modalValue: string, id: string): Promise<boolean> {
  if (id !== desk().state.activeId || desk().activity.busy) {
    desk().patchModal(modalValue, {error: 'The active conversation changed. Choose its permissions again.'});
    return false;
  }
  const ok = await mutate('/api/permissions', {id, mode: 'full-access'});
  if (ok) closeModalId(modalValue);
  else desk().patchModal(modalValue, {error: desk().activity.error});
  return ok;
}

export async function approve(id: string, action: 'deny' | 'always' | 'allow'): Promise<void> {
  const approval = desk().state.pendingApproval;
  if (!approval) return;
  if (id !== approval.id) {
    setError('This tool request has changed. Review the current request before allowing it.');
    return;
  }
  const alwaysAllow = action === 'always';
  if (alwaysAllow && approval.toolName !== 'write_file' && approval.toolName !== 'edit_file') return;
  await mutate('/api/approval', {id, allow: action !== 'deny', ...(alwaysAllow ? {alwaysAllow: true} : {})});
}

export async function messageAction(action: 'copy' | 'edit' | 'branch', messageId: string, branchKey?: string): Promise<void> {
  const message = desk().state.messages.find(entry => entry.id === messageId);
  if (!message) return;
  if (action === 'copy' && (message.role === 'assistant' || message.role === 'user') && message.text && message.status !== 'streaming') await copyText(message.text);
  if (action === 'edit' && message.role === 'user') {
    const state = desk().state;
    desk().openModal({
      kind: 'editor', id: modalId('editor'), slot: 'message', targetId: message.id,
      title: 'Edit message', submitLabel: 'Send again', value: message.text, error: '', disabled: desk().activity.busy,
      conversationId: state.activeId, expectedLastMessageId: state.messages.at(-1)?.id || '',
      note: 'Send again to replace this message and its following replies.' + (message.images?.length ? ` ${message.images.length} attached image${message.images.length === 1 ? '' : 's'} will be kept.` : ''),
    });
  }
  if (action === 'branch' && branchKey && message.role === 'assistant' && branchKey === message.branchNodeId) {
    if (await mutate('/api/branch', {id: desk().state.activeId, nodeId: branchKey})) emitAppEvent('focusComposer');
  }
}

export async function queueAction(action: 'edit' | 'delete' | 'steer', id: string): Promise<void> {
  if (desk().activity.busy || !desk().state.activeId) return;
  const entry = desk().state.queuedMessages.find(message => message.id === id);
  if (!entry) return;
  if (action === 'edit') {
    desk().openModal({
      kind: 'editor', id: modalId('editor'), slot: 'queue', targetId: entry.id, title: 'Edit pending message', submitLabel: 'Save message',
      value: entry.text, note: entry.imageCount ? `${entry.imageCount} attached image${entry.imageCount === 1 ? '' : 's'} will be kept.` : '', error: '',
      disabled: desk().activity.busy, conversationId: desk().state.activeId,
    });
    return;
  }
  await mutate(`/api/queue/${action}`, {id: desk().state.activeId, messageId: entry.id});
}

export async function workspaceAction(action: 'workspace' | 'resources' | 'connections' | 'settings' | 'compact' | 'continue' | 'diagnostics'): Promise<void> {
  const state = desk().state;
  if (action === 'settings') openSettings();
  else if (action === 'workspace') openWorkspace();
  else if (action === 'resources') openResources();
  else if (action === 'connections') openConnections();
  else if (action === 'diagnostics') await exportDiagnostics();
  else if (action === 'compact') {
    if (!desk().activity.busy && !state.running && state.activeId && state.messages.length) await mutate('/api/compact', {id: state.activeId});
  } else if (!state.running && state.activeId && state.failure?.canContinue) {
    await mutate('/api/continue', {id: state.activeId});
  }
}

export async function openConversationFile(id: string, path: string): Promise<void> {
  if (desk().activity.busy || isConversationRunning(id) || id !== desk().state.activeId) return;
  await downloadConversationFile(id, path);
}
