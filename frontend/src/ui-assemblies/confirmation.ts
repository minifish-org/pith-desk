/** Internal compiled recipe: content and business ownership stay in the consumer. */
import {
  createActionsPart, createButtonPart, createDialogPart, createFeedbackPart,
  createFormPart, createTextFlowPart, createTextPart, mountParts,
  type DialogPart, type FormPart, type MountPartsOptions,
} from 'pith-ui';

export interface ConfirmationState {
  title: string;
  description?: string;
  message?: {before: string; subject?: string; after?: string};
  hint?: string;
  error?: string;
  confirmLabel?: string;
  disabled?: boolean;
  pending?: boolean;
  closeDisabled?: boolean;
}
export type ConfirmationResult = {ok: true} | {ok: false; error: string};
export interface ConfirmationCallbacks {onConfirm(): ConfirmationResult | Promise<ConfirmationResult>; onClose?(): void}
export interface ConfirmationAssembly {
  update(state: Readonly<ConfirmationState>): void;
  open(state?: Readonly<ConfirmationState>): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface ConfirmationComposition extends ConfirmationAssembly {readonly part: DialogPart}

/** Dialog -> Form -> description, hint, feedback, Actions(cancel + destructive submit). */
export function mountConfirmation(mount: HTMLElement, initial: Readonly<ConfirmationState>, callbacks: ConfirmationCallbacks, appearance: MountPartsOptions = {}): ConfirmationAssembly {
  const confirmation = composeConfirmation(initial,callbacks);
  try {mountParts(mount,confirmation.part,appearance);confirmation.open();return confirmation;}
  catch (error) {confirmation.destroy();throw error;}
}

/** Build only. The application attaches part to its shared frame before open. */
export function composeConfirmation(initial: Readonly<ConfirmationState>, callbacks: ConfirmationCallbacks): ConfirmationComposition {
  let state = initial, alive = true, opened = false, revision = 0;
  let dialog: DialogPart, form: FormPart;
  const content = (value: ConfirmationState['message']) => value ? [
    {text: value.before}, ...(value.subject ? [{text: value.subject, emphasis: 'strong' as const}] : []), {text: value.after ?? ''},
  ] : [];
  const message = createTextFlowPart({role: 'description', segments: content(initial.message)});
  const hint = createTextPart({role: 'hint', text: initial.hint ?? '', hidden: !initial.hint});
  const feedback = createFeedbackPart({presentation: 'notice', message: initial.error ?? '', tone: 'error'});
  const cancel = createButtonPart({purpose: 'prompt', label: 'Cancel', onAction() {if (!state.closeDisabled) close();}});
  const confirm = createButtonPart({purpose: 'prompt', label: initial.confirmLabel ?? 'Remove', variant: 'danger', type: 'submit'});
  const actions = createActionsPart({children: [cancel, confirm]});
  const notifyClose = () => {try {callbacks.onClose?.();} catch { /* The opening is already released. */ }};
  function render(next: Readonly<ConfirmationState>): void {
    if (!alive) return;
    state = next;
    dialog.update({title: next.title, description: next.description, closeDisabled: next.closeDisabled});
    message.update({segments: content(next.message)});
    hint.update({text: next.hint ?? '', hidden: !next.hint});
    feedback.update({message: next.error ?? '', tone: 'error'});
    cancel.update({label: 'Cancel', disabled: !!next.closeDisabled});
    confirm.update({label: next.confirmLabel ?? 'Remove', variant: 'danger', disabled: !!next.disabled, pending: !!next.pending || form.isPending()});
    form.update({disabled: !!next.disabled || !!next.pending || !opened});
  }
  function closed(): void {
    if (!alive || !opened) return;
    opened = false; revision++; form.reset(); render(state); notifyClose();
  }
  function close(): void {if (alive) {dialog.close(); closed();}}
  function dispose(): void {
    if (!alive) return;
    const notify = opened;alive = false;opened = false;revision++;form.invalidate();
    if (notify) notifyClose();
  }
  form = createFormPart({purpose: 'confirmation', children: [message, hint, feedback, actions], disabled: true,
    onPending() {if (alive) render(state);},
    onError(error) {if (alive && opened && dialog.isOpen()) render({...state, error});},
    async onSubmit() {
      const submitted = revision;
      const result = await callbacks.onConfirm();
      if (alive && opened && submitted === revision && dialog.isOpen() && result.ok) close();
      return result;
    },
  });
  dialog = createDialogPart({purpose: 'prompt', title: initial.title, description: initial.description, closeDisabled: initial.closeDisabled,
    children: [form], onClose: closed, onDispose: dispose});
  function open(next = state): void {
    if (!alive) return;
    revision++; form.reset(); opened = true; render({...next, error: ''}); dialog.open();
    if (!dialog.isOpen()) {opened = false;render(state);return;}
    cancel.focus();
  }
  return {
    part: dialog, update: render, open, close, isOpen: () => alive && opened && dialog.isOpen(),
    destroy() {
      if (!alive) return;
      dialog.destroy();
    },
  };
}
