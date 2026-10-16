import { createConfirmDialog } from 'pith-ui';

export type Confirmation = {
  title: string; action: string; description: string; hint?: string;
  scope?: { conversationId?: string; workspaceId?: string; global?: boolean };
  unavailable: () => boolean; run: () => Promise<boolean>; error: () => string;
};

// Existing descriptions contain trusted <strong> labels. Only that formatting is
// transferred to DOM; arbitrary tags and all attributes are discarded.
function descriptionContent(description: string): HTMLElement {
  const content = document.createElement('span');
  const source = document.createElement('template'); source.innerHTML = description;
  for (const node of source.content.childNodes) {
    if (node instanceof HTMLElement && node.tagName === 'STRONG') {
      const strong = document.createElement('strong'); strong.textContent = node.textContent; content.append(strong);
    } else content.append(document.createTextNode(node.textContent ?? ''));
  }
  return content;
}

// Business availability and request ownership remain with the application.
export function createConfirmation(dialog: HTMLDialogElement) {
  let current: Confirmation | null = null;
  const confirmation = createConfirmDialog({
    dialog, title: 'Confirm removal', ids: { form: 'delete-form', error: 'delete-error', title: 'delete-title', cancel: 'cancel-delete' },
    unavailable: () => !current || current.unavailable(),
    async onConfirm() {
      const request = current;
      if (!request || request.unavailable()) return { ok: false, error: 'This action is no longer available.' };
      const ok = await request.run();
      return ok ? { ok: true } : { ok: false, error: request.error() };
    },
  });
  const open = (options: Confirmation): void => {
    current = options;
    confirmation.open({ title: options.title, eyebrow: 'PERMANENT REMOVAL', message: descriptionContent(options.description), hint: options.hint, confirmLabel: options.action });
  };
  return Object.assign(open, { render() {confirmation.refreshAvailability();}, destroy() { current = null; confirmation.destroy(); } });
}
