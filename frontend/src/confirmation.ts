import { dialogHeading, escape } from './ui.ts';

export type Confirmation = {
  title: string; action: string; description: string; hint?: string;
  scope?: { conversationId?: string; workspaceId?: string; global?: boolean };
  unavailable: () => boolean; run: () => Promise<boolean>; error: () => string;
};

// All permanent removals share one cancel-first, scoped confirmation flow.
export function createConfirmation(dialog: HTMLDialogElement) {
  let generation = 0;
  dialog.addEventListener('close', () => { generation++; });
  return (options: Confirmation): void => {
    const seq = ++generation, scope = options.scope || {};
    dialog.innerHTML = `${dialogHeading(options.title, 'delete-title', dialog.id, 'PERMANENT REMOVAL')}<p class="modal-description">${options.description}</p>${options.hint ? `<p class="field-hint">${escape(options.hint)}</p>` : ''}<form id="delete-form"><div id="delete-error" class="form-error" role="alert"></div><div class="modal-footer"><button id="cancel-delete" type="button" class="secondary-button" data-close="${dialog.id}">Cancel</button><button type="submit" class="danger-button" data-idle-action ${scope.global ? 'data-global-idle' : ''} ${scope.workspaceId ? `data-idle-workspace="${escape(scope.workspaceId)}"` : ''} ${scope.conversationId ? `data-idle-conversation="${escape(scope.conversationId)}"` : ''}>${escape(options.action)}</button></div></form>`;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('#cancel-delete')!.focus();
    dialog.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = options.unavailable();
    dialog.querySelector('form')!.onsubmit = async (event) => {
      event.preventDefault();
      if (options.unavailable()) return;
      const ok = await options.run();
      if (seq !== generation || !dialog.open) return;
      if (ok) dialog.close();
      else dialog.querySelector('#delete-error')!.textContent = options.error();
    };
  };
}
