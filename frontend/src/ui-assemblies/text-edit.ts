/** Internal compiled recipe: the application owns this controller, not the package API. */
import {
  createActionsPart, createButtonPart, createDialogPart, createFeedbackPart,
  createFieldGroupPart, createFieldLabelPart, createFormPart, createTextareaPart,
  createTextPart, mountParts,
  type DialogPart, type FormPart, type MountPartsOptions,
} from 'pith-ui';

export interface TextEditorState {
  title: string;
  description?: string;
  note?: string;
  error?: string;
  submitLabel?: string;
  disabled?: boolean;
  pending?: boolean;
  inputDisabled?: boolean;
  closeDisabled?: boolean;
}
export interface TextEditorInput {value: string; title?: string; description?: string; note?: string}
export type TextEditorResult = {ok: true} | {ok: false; error: string};
export interface TextEditorCallbacks {
  purpose?: 'message' | 'queue-message';
  onInput?(value: string): void;
  onSubmit?(value: string): TextEditorResult | Promise<TextEditorResult>;
  onClose?(): void;
}
export interface TextEditorAssembly {
  read(): string;
  update(state: Readonly<TextEditorState>): void;
  reset(value: string): void;
  open(input: Readonly<TextEditorInput>): void;
  close(): void;
  focus(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface TextEditorComposition extends TextEditorAssembly {readonly part: DialogPart}

/** Dialog -> Form -> FieldGroup(label + textarea), note, feedback, Actions(cancel + submit). */
export function mountTextEditor(mount: HTMLElement, initial: Readonly<TextEditorState> & {value: string}, callbacks: TextEditorCallbacks = {}, appearance: MountPartsOptions = {}): TextEditorAssembly {
  const editor = composeTextEditor(initial,callbacks);
  try {mountParts(mount,editor.part,appearance);editor.open({value: initial.value});return editor;}
  catch (error) {editor.destroy();throw error;}
}

/** Build only. The application attaches part to its shared frame before open. */
export function composeTextEditor(initial: Readonly<TextEditorState> & {value: string}, callbacks: TextEditorCallbacks = {}): TextEditorComposition {
  const {value, ...initialState} = initial;
  let state: Readonly<TextEditorState> = initialState;
  let alive = true, opened = false, revision = 0, saved = value;
  let dialog: DialogPart, form: FormPart;
  const purpose = callbacks.purpose ?? 'message';
  const input = createTextareaPart({purpose, value, label: purpose === 'queue-message' ? 'Pending message' : 'Message',
    onInput: callbacks.onInput});
  const label = createFieldLabelPart({label: purpose === 'queue-message' ? 'Pending message' : 'Message', control: input});
  const field = createFieldGroupPart({children: [label, input]});
  const note = createTextPart({role: 'muted-paragraph', text: initial.note ?? '', hidden: !initial.note});
  const feedback = createFeedbackPart({presentation: 'notice', message: initial.error ?? '', tone: 'error'});
  const cancel = createButtonPart({purpose: 'prompt', label: 'Cancel', onAction() {if (!state.closeDisabled) close();}});
  const submit = createButtonPart({purpose: 'prompt', label: initial.submitLabel ?? 'Save', variant: 'primary', type: 'submit'});
  const actions = createActionsPart({children: [cancel, submit]});
  const read = () => alive ? input.read() : saved;
  const notifyClose = () => {try {callbacks.onClose?.();} catch { /* The owned opening has already closed. */ }};
  // Form reset retires its operation. Restore the owned draft immediately so
  // cancellation never turns an unsaved edit into the construction-time value.
  const invalidate = () => {const draft = input.read(); revision++; form.reset(); input.reset(draft);};
  function render(next: Readonly<TextEditorState>): void {
    if (!alive) return;
    state = next;
    dialog.update({title: next.title, description: next.description, closeDisabled: next.closeDisabled});
    note.update({text: next.note ?? '', hidden: !next.note});
    feedback.update({message: next.error ?? '', tone: 'error'});
    cancel.update({label: 'Cancel', disabled: !!next.closeDisabled});
    submit.update({label: next.submitLabel ?? initial.submitLabel ?? 'Save', variant: 'primary', disabled: !!next.disabled, pending: !!next.pending || form.isPending()});
    input.update({disabled: !!next.inputDisabled});
    form.update({disabled: !!next.disabled || !!next.pending || !opened});
  }
  function closed(): void {
    if (!alive || !opened) return;
    opened = false; saved = input.read(); invalidate(); render(state); notifyClose();
  }
  function close(): void {if (alive) {dialog.close(); closed();}}
  function dispose(): void {
    if (!alive) return;
    const notify = opened;saved = input.read();alive = false;opened = false;revision++;form.invalidate();
    if (notify) notifyClose();
  }
  form = createFormPart({purpose: 'text-entry', children: [field, note, feedback, actions], disabled: true,
    onPending() {if (alive) render(state);},
    onError(error) {if (alive && opened && dialog.isOpen()) render({...state, error});},
    onSubmit: callbacks.onSubmit ? async () => {
      const submitted = revision;
      const result = await callbacks.onSubmit!(input.read());
      if (alive && opened && submitted === revision && dialog.isOpen() && result.ok) close();
      return result;
    } : undefined,
  });
  dialog = createDialogPart({purpose: 'prompt', title: initial.title, description: initial.description, closeDisabled: initial.closeDisabled,
    children: [form], onClose: closed, onDispose: dispose});
  function open(target: Readonly<TextEditorInput>): void {
    if (!alive) return;
    invalidate();
    state = {...state, title: target.title ?? initial.title, description: target.description ?? initial.description,
      note: target.note ?? initial.note, error: ''};
    input.reset(target.value); opened = true; render(state); dialog.open();
    if (!dialog.isOpen()) {opened = false;render(state);return;}
    input.focus();
  }
  return {
    part: dialog, read, update: render, open, close,
    reset(next) {if (alive) {invalidate(); input.reset(next); render({...state, error: ''});}},
    focus() {if (alive) input.focus();},
    isOpen: () => alive && opened && dialog.isOpen(),
    destroy() {
      if (!alive) return;
      dialog.destroy();
    },
  };
}
