import {mutate, request, setError, copyText, download} from './core.ts';
import {closeModalId, desk, modalId, type Modal} from '@/stores/desk.ts';
import {selectedWorkspace, workspaceRun, conversationRunning} from '@/lib/derive.ts';
import {saveBlob} from '@/lib/save.ts';
import {openSettings} from './settings.ts';
import {openResources, loadArtifacts, clearFilePreview} from './files.ts';
import {acknowledgeViewed, dismissNotice} from './notices.ts';
import type {Conversation, RunSummary} from '@/contract.generated.ts';

export function selected(): ReturnType<typeof selectedWorkspace> {
  const state = desk().state;
  return selectedWorkspace(state, desk().selectedWorkspaceId);
}

export function blockedWorkspace(id?: string): RunSummary | undefined {
  return workspaceRun(desk().state, id);
}

export function isConversationRunning(id: string | null): boolean {
  return conversationRunning(desk().state, id);
}

export function closeNavigation(): void {
  desk().setNavigationOpen(false);
}

export async function selectConversation(id: string): Promise<void> {
  if (await mutate('/api/open', {id})) acknowledgeViewed();
  closeNavigation();
}

export async function newConversation(workspaceId = selected()?.id): Promise<void> {
  if (!workspaceId) {
    openWorkspace();
    return;
  }
  if (await mutate('/api/conversations', {workspaceId})) {
    closeNavigation();
    focusComposer();
  }
}

export function focusComposer(): void {
  window.dispatchEvent(new CustomEvent('pith:focus-composer'));
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
  const isBusy = () => (kind === 'workspace' ? !!workspaceRun(state, id) : isConversationRunning(id)) || desk().activity.busy;
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
      const activeWorkspace = selected()?.id, activeID = desk().state.activeId;
      const ok = await mutate(kind === 'workspace' ? '/api/remove-workspace' : '/api/delete-conversation', {id, ...(kind === 'workspace' ? {conversationCount: count} : {})});
      if (!ok) {
        desk().patchModal(modal.id, {error: desk().activity.error});
        return false;
      }
      if (kind === 'workspace') {
        if (desk().selectedWorkspaceId === id) desk().selectWorkspaceId('');
        clearWorkspaceFiles(id);
      }
      if (activeID !== desk().state.activeId || activeWorkspace !== selected()?.id) {
        clearFilePreview();
      }
      return true;
    },
  };
  desk().openModal(modal);
}

// Filled by the tools controller; declared narrowly to avoid a cycle.
let clearWorkspaceFiles: (id: string) => void = () => {};
export function registerWorkspaceRemoval(handler: (id: string) => void): void {
  clearWorkspaceFiles = handler;
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
    const result = await saveBlob(await download('/api/export', {id: conversation.id}), `${(conversation.title || 'Conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Conversation'}.md`);
    if (!result.ok) throw new Error(result.error);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    desk().setBusy(false);
  }
}

export function openWorkspace(): void {
  closeNavigation();
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
  closeNavigation();
}

export async function changePermission(value: string): Promise<void> {
  const mode = value;
  const id = desk().state.activeId;
  if (!id || desk().activity.busy || mode === activeMode()) return;
  if (mode === 'full-access') openFullAccess(id);
  else await mutate('/api/permissions', {id, mode: mode as 'ask' | 'workspace-write'});
}

export function activeMode(): 'ask' | 'workspace-write' | 'full-access' {
  const mode = desk().state.conversations.find(entry => entry.id === desk().state.activeId)?.permissionMode;
  return mode === 'workspace-write' || mode === 'full-access' ? mode : 'ask';
}

export function openFullAccess(id: string): void {
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
    if (await mutate('/api/branch', {id: desk().state.activeId, nodeId: branchKey})) focusComposer();
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

export async function submitEditor(modalValue: string, value: string, targetId: string): Promise<boolean> {
  const modal = desk().modals.find(entry => entry.id === modalValue);
  if (!modal || modal.kind !== 'editor') return false;
  if (modal.slot === 'queue') {
    const entry = desk().state.queuedMessages.find(message => message.id === targetId);
    if (!entry || modal.conversationId !== desk().state.activeId || (!value.trim() && !entry.imageCount) || desk().activity.busy) {
      desk().patchModal(modalValue, {error: 'This message is no longer pending. Your draft is kept here so you can copy it.'});
      return false;
    }
    const ok = await mutate('/api/queue/edit', {id: desk().state.activeId, messageId: targetId, text: value});
    if (ok) closeModalId(modalValue);
    else desk().patchModal(modalValue, {error: desk().activity.error});
    return ok;
  }
  return false;
}

export async function workspaceAction(action: 'workspace' | 'resources' | 'connections' | 'settings' | 'model' | 'compact' | 'continue' | 'diagnostics'): Promise<void> {
  const state = desk().state;
  if (action === 'settings') openSettings();
  else if (action === 'model') {
    const {openModels} = await import('./settings.ts');
    openModels();
  } else if (action === 'workspace') openWorkspace();
  else if (action === 'resources') openResources();
  else if (action === 'connections') {
    const {openConnections} = await import('./settings.ts');
    openConnections();
  } else if (action === 'diagnostics') {
    const {exportDiagnostics} = await import('./settings.ts');
    await exportDiagnostics();
  } else if (action === 'compact') {
    if (!desk().activity.busy && !state.running && state.activeId && state.messages.length) await mutate('/api/compact', {id: state.activeId});
  } else if (!state.running && state.activeId && state.failure?.canContinue) {
    await mutate('/api/continue', {id: state.activeId});
  }
}

export async function openConversationFile(id: string, path: string): Promise<void> {
  if (desk().activity.busy || isConversationRunning(id) || id !== desk().state.activeId) return;
  await import('./files.ts').then(module => module.downloadConversationFile(id, path));
}

export function currentConversation(): Conversation | undefined {
  const state = desk().state;
  return state.conversations.find(entry => entry.id === state.activeId);
}

export {loadArtifacts, dismissNotice};
