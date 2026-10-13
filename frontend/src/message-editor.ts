import type { ApiMutate } from './api.ts';
import type { Message } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { dialogHeading } from './ui.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export function createMessageEditor(api: { view: AppView; activity: UIActivity; mutate: ApiMutate; showDialog: (id: string) => void; followLatest: () => void }) {
  let target: { id: string; messageId: string; expectedLastMessageId: string; imageCount: number } | null = null;
  function valid(): boolean {
    return !!target && target.id === api.view.state.activeId && target.expectedLastMessageId === api.view.state.messages.at(-1)?.id && api.view.state.messages.some(message => message.id === target!.messageId && message.role === 'user');
  }
  function render(): void {
    if (!target) return;
    const text = $<HTMLTextAreaElement>('message-edit-text');
    $<HTMLButtonElement>('message-edit-send').disabled = api.activity.busy || api.view.state.running || !valid() || (!text.value.trim() && !target.imageCount);
    text.disabled = api.activity.busy;
    if (!valid()) $('message-edit-error').textContent = 'The conversation changed. Reopen the message to send this edit. Your text is kept here so you can copy it.';
  }
  function open(message: Message): void {
    const id = api.view.state.activeId;
    if (!id || api.activity.busy || api.view.state.running || message.role !== 'user' || !api.view.state.messages.some(entry => entry.id === message.id)) return;
    target = { id, messageId: message.id, expectedLastMessageId: api.view.state.messages.at(-1)!.id, imageCount: message.images?.length || 0 };
    $('message-edit-content').innerHTML = `${dialogHeading('Edit message', 'message-edit-title', 'message-edit-dialog')}<form id="message-edit-form"><label class="field-label" for="message-edit-text">Message</label><textarea id="message-edit-text" class="queue-edit-text" rows="5"></textarea><p class="settings-note">Send again to replace this message and its following replies.${target.imageCount ? ` ${target.imageCount} attached image${target.imageCount === 1 ? '' : 's'} will be kept.` : ''}</p><p id="message-edit-error" class="form-error" role="alert"></p><div class="queue-edit-actions"><button type="button" class="secondary-button" data-close="message-edit-dialog">Cancel</button><button id="message-edit-send" type="submit" class="primary-button">Send again</button></div></form>`;
    const text = $<HTMLTextAreaElement>('message-edit-text');
    text.value = message.text;
    text.addEventListener('input', render);
    $('message-edit-form').addEventListener('submit', async event => {
      event.preventDefault();
      render();
      if (!target || $<HTMLButtonElement>('message-edit-send').disabled) return;
      const { imageCount, ...input } = target;
      $('message-edit-error').textContent = '';
      if (await api.mutate('/api/edit-message', { ...input, text: text.value }, () => $<HTMLDialogElement>('message-edit-dialog').close())) {
        api.followLatest();
      } else {
        $('message-edit-error').textContent = api.activity.error;
      }
    });
    render();
    api.showDialog('message-edit-dialog');
    text.focus();
  }
  return { open, render, close: () => { target = null; } };
}
