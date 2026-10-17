/** Internal executable assembly. This function is not a package scene API. */
import {
  createButtonPart, createDialogPart, createFeedbackPart, createFieldLabelPart,
  createFooterPart, createFormPart, createInputPart, mountParts,
  type DialogPart, type FormPart, type MountPartsOptions,
} from 'pith-ui';

export interface RenameState {id: string; title: string; error?: string; disabled?: boolean}
export interface RenameDraft {id: string; title: string}
export type RenameResult = {ok: true} | {ok: false; error: string};
export interface RenameCallbacks {onSubmit?(draft: RenameDraft): RenameResult | Promise<RenameResult>; onClose?(): void}
export interface RenameAssembly {
  read(): RenameDraft;
  update(state: Readonly<RenameState>): void;
  reset(state: Readonly<RenameState>): void;
  focus(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface RenameComposition extends RenameAssembly {readonly part: DialogPart; open(): void}

/** Dialog -> Form -> Label, Input, Feedback, Footer(Cancel, Save title). */
export function composeRename(initial: Readonly<RenameState>, callbacks: RenameCallbacks = {}): RenameComposition {
  let state = initial, targetId = initial.id, alive = true, opened = false, revision = 0;
  let cached: RenameDraft = {id: targetId,title: initial.title};
  let dialog: DialogPart, form: FormPart;
  const input = createInputPart({name: 'title',value: initial.title,required: true,autocomplete: 'off'});
  const label = createFieldLabelPart({label: 'Title',control: input});
  const error = createFeedbackPart({message: initial.error ?? '',tone: 'error'});
  const cancel = createButtonPart({label: 'Cancel',variant: 'secondary',onAction: close});
  const save = createButtonPart({label: 'Save title',variant: 'primary',type: 'submit'});
  const footer = createFooterPart({children: [cancel,save]});
  const read = (): RenameDraft => alive ? {id: targetId,title: input.read()} : {...cached};
  const notify = () => {try {callbacks.onClose?.();} catch { /* Ownership is already released. */ }};
  function render(next: Readonly<RenameState>): void {
    if (!alive || !opened) return;
    state = {...next,error: next.error ?? state.error};
    error.update({message: state.error ?? '',tone: 'error'});
    save.update({label: 'Save title',variant: 'primary',disabled: !!state.disabled,pending: form.isPending()});
    form.update({disabled: !!state.disabled});
  }
  function disposed(): void {
    if (!alive) return;
    const wasOpen = opened; cached = read(); alive = false; opened = false; revision++;
    form.invalidate();
    if (wasOpen) notify();
  }
  function close(): void {if (alive && opened) {dialog.close(); dialog.destroy();}}
  form = createFormPart({children: [label,input,error,footer],disabled: !!initial.disabled,
    onPending() {if (alive && opened) render(state);},
    onError(message) {if (alive && opened) render({...state,error: message});},
    async onSubmit() {
      const title = input.read().trim(); if (!title || !callbacks.onSubmit) return;
      const submitted = revision,draft = Object.freeze({id: targetId,title});
      render({...state,error: ''});
      const result = await callbacks.onSubmit(draft);
      if (alive && opened && submitted === revision && result.ok) close();
      return result;
    },
  });
  dialog = createDialogPart({title: 'Rename conversation',eyebrow: 'CONVERSATION',children: [form],onClose: close,onDispose: disposed});
  return {
    part: dialog,read,update: render,
    open() {if (alive && !opened) {dialog.open(); if (dialog.isOpen()) {opened = true; render(state); input.selectAll();}}},
    reset(next) {
      if (!alive || !opened) return;
      revision++; form.invalidate(); targetId = next.id; state = next; input.reset(next.title); render(next);
    },
    focus() {if (alive && opened) input.selectAll();},
    close,isOpen: () => alive && opened && dialog.isOpen(),
    destroy() {if (alive) dialog.destroy();},
  };
}

/** Standalone demonstration adapter; shared applications own the composed Part. */
export function mountRename(mount: HTMLElement, initial: Readonly<RenameState>, callbacks: RenameCallbacks = {}, appearance: MountPartsOptions = {}): RenameAssembly {
  const assembly = composeRename(initial,callbacks); mountParts(mount,assembly.part,appearance); assembly.open(); return assembly;
}
