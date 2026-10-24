// Editing a sent user message or a queued follow-up. Validation is repeated when
// the submission arrives so a stale dialog can never edit a changed conversation.
import {mutate} from './core.ts';
import {desk} from '@/stores/desk.ts';
import {emitAppEvent} from '@/lib/events.ts';

// The editor dialogs keep unsaved text outside the store so window lifecycle
// handlers can read it without making every keystroke part of the projection.
export const editorValues = new Map<string, string>();

export function unsentEditorText(slot: 'message' | 'queue'): string {
  const modal = desk().modals.find(entry => entry.kind === 'editor' && entry.slot === slot);
  if (!modal || modal.kind !== 'editor') return '';
  const original = slot === 'queue'
    ? desk().state.queuedMessages.find(entry => entry.id === modal.targetId)?.text || ''
    : desk().state.messages.find(entry => entry.id === modal.targetId)?.text || '';
  const value = editorValues.get(modal.id) ?? modal.value;
  return value !== original ? value : '';
}

export async function submitMessageEdit(modalId: string, messageId: string, text: string): Promise<boolean> {
  const state = desk().state;
  const modal = desk().modals.find(entry => entry.id === modalId);
  if (!modal || modal.kind !== 'editor') return false;
  const message = state.messages.find(entry => entry.id === messageId);
  const expected = modal.expectedLastMessageId || '';
  if (!message || message.role !== 'user' || modal.conversationId !== state.activeId || desk().activity.busy || state.running || expected !== (state.messages.at(-1)?.id || '') || (!text.trim() && !message.images?.length)) {
    desk().patchModal(modalId, {error: 'The conversation changed. Reopen the message to send this edit. Your text is kept here so you can copy it.'});
    return false;
  }
  const ok = await mutate('/api/edit-message', {id: state.activeId, messageId, expectedLastMessageId: expected, text});
  if (ok) {
    desk().closeModal(modalId);
    emitAppEvent('followLatest');
  } else desk().patchModal(modalId, {error: desk().activity.error});
  return ok;
}

export async function submitQueueEdit(modalId: string, text: string, targetId: string): Promise<boolean> {
  const modal = desk().modals.find(entry => entry.id === modalId);
  if (!modal || modal.kind !== 'editor') return false;
  const entry = desk().state.queuedMessages.find(message => message.id === targetId);
  if (!entry || modal.conversationId !== desk().state.activeId || (!text.trim() && !entry.imageCount) || desk().activity.busy) {
    desk().patchModal(modalId, {error: 'This message is no longer pending. Your draft is kept here so you can copy it.'});
    return false;
  }
  const ok = await mutate('/api/queue/edit', {id: desk().state.activeId, messageId: targetId, text});
  if (ok) desk().closeModal(modalId);
  else desk().patchModal(modalId, {error: desk().activity.error});
  return ok;
}
