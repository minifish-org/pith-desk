import type { Application, MessageEditorSession } from 'pith-ui/app';
import type { ApiMutate } from './api.ts';
import type { Message } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';

export function createMessageEditor(api: { ui: Application; view: AppView; activity: UIActivity; mutate: ApiMutate; followLatest: () => void }) {
  let target: { id: string; messageId: string; expectedLastMessageId: string; imageCount: number } | null = null;
  let error = '';
  let editor: MessageEditorSession | undefined;
  function valid(): boolean {
    return !!target && target.id === api.view.state.activeId && target.expectedLastMessageId === api.view.state.messages.at(-1)?.id && api.view.state.messages.some(message => message.id === target!.messageId && message.role === 'user');
  }
  function render(): void {
    if (!target || !editor) return;
    if (!valid()) error = 'The conversation changed. Reopen the message to send this edit. Your text is kept here so you can copy it.';
    editor.update({ title: 'Edit message', value: editor.read(), submitLabel: 'Send again', error,
      disabled: api.activity.busy || api.view.state.running || !valid() || (!editor.read().trim() && !target.imageCount),
      inputDisabled: api.activity.busy,
      note: 'Send again to replace this message and its following replies.' + (target.imageCount ? ' ' + target.imageCount + ' attached image' + (target.imageCount === 1 ? '' : 's') + ' will be kept.' : ''),
    });
  }
  function open(message: Message): void {
    const id = api.view.state.activeId;
    if (!id || api.activity.busy || api.view.state.running || message.role !== 'user' || !api.view.state.messages.some(entry => entry.id === message.id)) return;
    editor?.destroy();
    const opened = { id, messageId: message.id, expectedLastMessageId: api.view.state.messages.at(-1)!.id, imageCount: message.images?.length || 0 };
    target = opened;
    error = '';
    editor = api.ui.workspace.openMessageEditor({ title: 'Edit message', value: message.text, submitLabel: 'Send again' }, {
      onInput: render,
      onClose() { if (target === opened) { target = null; editor = undefined; } },
      async onSubmit(text) {
        if (!target || api.activity.busy || api.view.state.running || !valid() || (!text.trim() && !target.imageCount)) return { ok: false, error };
        const submitted = target;
        const { imageCount: _imageCount, ...input } = submitted;
        error = '';
        const ok = await api.mutate('/api/edit-message', { ...input, text }, () => { if (target === submitted) editor?.close(); });
        if (ok) api.followLatest();
        else if (target === submitted) error = api.activity.error;
        return ok ? { ok: true } : { ok: false, error };
      },
    });
    render();
    editor.focus();
  }
  return { open, render, close: () => { target = null; editor?.close(); editor = undefined; }, destroy: () => { target = null; editor?.destroy(); editor = undefined; } };
}
