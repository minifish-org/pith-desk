/** Internal compiled recipes. Applications own their resource data and writes. */
import {
  createButtonPart, createDialogPart, createFeedbackPart, createFieldLabelPart,
  createFooterPart, createFormPart, createInputPart, createLabelledFieldPart,
  createStackPart, createTextareaPart, createTextPart, mountParts,
  type DialogPart, type FormPart, type MountPartsOptions,
} from 'pith-ui';

export type ResourceKind = 'instructions' | 'skill' | 'template';
export type ResourceResult = {ok: true} | {ok: false; error: string};
export interface ResourceState {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly path?: string;
  readonly kind: ResourceKind;
  readonly name?: string;
  readonly content: string;
  readonly editable: boolean;
  readonly workspaceBusy: boolean;
  readonly error?: string;
  readonly disabled?: boolean;
  /** Current host/workspace availability gates saving without changing the draft's editing mode or Delete. */
  readonly saveDisabled?: boolean;
}
export interface ResourceDraft {name: string; content: string}
export interface ResourceTarget {readonly workspaceId: string; readonly kind: ResourceKind; readonly name: string; readonly path: string}
export interface ResourceCallbacks {
  onSubmit?(draft: ResourceDraft): ResourceResult | Promise<ResourceResult>;
  onDelete?(target: ResourceTarget): void | ResourceResult | Promise<void | ResourceResult>;
  onClose?(): void;
}
export interface ResourceEditorAssembly {
  read(): ResourceDraft;
  update(state: Readonly<ResourceState>): void;
  fail(message: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface ResourceEditorComposition extends ResourceEditorAssembly {readonly part: DialogPart; open(): void}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Feature dialog -> natural body -> path, optional notice, form fields and footer. */
export function composeResourceEditor(initial: Readonly<ResourceState>, callbacks: ResourceCallbacks = {}): ResourceEditorComposition {
  let state = initial, alive = true, opened = false, deletePending = false, deletion = 0;
  let saved: ResourceDraft = {name: initial.name ?? '', content: initial.content};
  let dialog: DialogPart, form: FormPart;
  const identity = JSON.stringify([initial.workspaceId, initial.workspacePath, initial.kind, initial.path]);
  const current = () => alive && dialog.isOpen();
  const path = createTextPart({role: 'path-paragraph', text: initial.path || initial.workspacePath});
  const notice = !initial.editable ? createTextPart({role: 'paragraph', text: initial.workspaceBusy
    ? 'Stop this workspace’s task before editing resources.'
    : 'Inherited instructions are read-only here. Add workspace instructions to specialize them.'}) : undefined;
  const name = !initial.path && initial.kind !== 'instructions' ? createInputPart({label: 'Name', value: initial.name ?? '',
    required: true, pattern: '[A-Za-z0-9]([A-Za-z0-9_]|-)*', placeholder: 'my-resource'}) : undefined;
  const namedField = name ? createLabelledFieldPart({label: 'Name', control: name}) : undefined;
  const content = createTextareaPart({purpose: 'markdown', value: initial.content, label: 'Markdown'});
  const contentLabel = createFieldLabelPart({label: 'Markdown', control: content});
  const feedback = createFeedbackPart({presentation: 'paragraph', message: initial.error ?? '', tone: 'error'});
  // Frame failures belong to a separate channel from the form's write feedback.
  const frameFeedback = createFeedbackPart({presentation: 'paragraph', message: '', tone: 'error'});
  const read = (): ResourceDraft => alive ? {name: name?.read() ?? '', content: content.read()} : {...saved};
  const fail = (message: string) => {if (current()) {state = {...state, error: message}; render(state);}};
  const remove = initial.path && initial.editable ? createButtonPart({label: 'Delete resource', variant: 'danger', onAction() {
    if (!current() || form.isPending() || deletePending || state.disabled || !state.editable || state.workspaceBusy || !callbacks.onDelete) return;
    const target = Object.freeze({workspaceId: state.workspaceId, kind: state.kind,
      name: state.name || state.path?.split('/').pop() || '', path: state.path || ''});
    const sequence = ++deletion; deletePending = true;
    const accept = (result: void | ResourceResult) => {if (current() && sequence === deletion && result && !result.ok) fail(result.error);};
    const rejected = (error: unknown) => {if (current() && sequence === deletion) fail(errorMessage(error));};
    const finished = () => {if (alive && sequence === deletion) deletePending = false;};
    // This operation intentionally does not make Delete look like a pending
    // save. The controller guards repeated deletion while Cancel stays usable.
    try {
      const result = callbacks.onDelete(target);
      if (result != null && typeof result === 'object' && 'then' in result) void Promise.resolve(result).then(accept).catch(rejected).finally(finished);
      else {accept(result); finished();}
    }
    catch (error) {rejected(error); finished();}
  }}) : undefined;
  const cancel = createButtonPart({label: initial.editable ? 'Cancel' : 'Close', variant: 'secondary', onAction() {close();}});
  const save = initial.editable ? createButtonPart({label: 'Save', variant: 'primary', type: 'submit'}) : undefined;
  const footer = createFooterPart({children: [remove, cancel, save].filter((part): part is NonNullable<typeof part> => !!part)});
  function render(next: Readonly<ResourceState>): void {
    if (!alive) return;
    state = next;
    const readOnly = !next.editable || next.workspaceBusy;
    const disabled = !!next.disabled || readOnly;
    const saveDisabled = disabled || !!next.saveDisabled;
    content.update({readOnly}); name?.update({readOnly});
    if (next.error !== undefined) feedback.update({message: next.error, tone: 'error'});
    save?.update({label: 'Save', variant: 'primary', disabled: saveDisabled, pending: form.isPending()});
    remove?.update({label: 'Delete resource', variant: 'danger', disabled, pending: form.isPending()});
    form.update({disabled: saveDisabled});
  }
  function release(): void {
    if (!alive) return;
    const notify = opened;
    saved = read(); alive = false; opened = false; deletion++;
    try {dialog.destroy();} finally {if (notify) callbacks.onClose?.();}
  }
  function close(): void {if (alive) {dialog.close(); release();}}
  form = createFormPart({children: [namedField, contentLabel, content, feedback, footer].filter((part): part is NonNullable<typeof part> => !!part),
    onPending() {if (alive) render(state);}, onError: fail,
    async onSubmit() {
      saved = read();
      if (!current() || !callbacks.onSubmit) return {ok: false, error: 'Saving is unavailable.'};
      const result = await callbacks.onSubmit(saved);
      if (current() && result.ok) close();
      return result;
    },
  });
  const body = createStackPart({children: [path, notice, form].filter((part): part is NonNullable<typeof part> => !!part)});
  const title = !initial.editable ? 'Workspace resource' : initial.path ? 'Edit workspace resource' : `Create ${initial.kind}`;
  dialog = createDialogPart({purpose: 'feature', title, children: [body, frameFeedback], onClose: release, onDispose: release});
  render(initial);
  return {
    part: dialog, read, fail, close, isOpen: current, destroy: close,
    open() {if (alive && !dialog.isOpen()) {dialog.open();opened = dialog.isOpen();}},
    update(next) {
      if (current() && JSON.stringify([next.workspaceId, next.workspacePath, next.kind, next.path]) === identity) render(next);
    },
  };
}

/** Standalone validation adapter. A real application mounts the composed part once. */
export function mountResourceEditor(mount: HTMLElement, initial: Readonly<ResourceState>, callbacks: ResourceCallbacks = {}, appearance: MountPartsOptions = {}): ResourceEditorAssembly {
  const editor = composeResourceEditor(initial,callbacks);
  mountParts(mount,editor.part,appearance);editor.open();return editor;
}

export interface ResourceLoadingState {readonly error?: string}
export interface ResourceLoadingAssembly {
  update(state: Readonly<ResourceLoadingState>): void;
  fail(message: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface ResourceLoadingComposition extends ResourceLoadingAssembly {readonly part: DialogPart; open(): void}

/** The two paragraph parts deliberately keep body status and frame errors apart. */
export function composeResourceLoading(initial: Readonly<ResourceLoadingState> & {readonly kind: ResourceKind; readonly path?: string}, callbacks: {onClose?(): void} = {}): ResourceLoadingComposition {
  let alive = true, opened = false;
  let dialog: DialogPart;
  const status = createFeedbackPart({presentation: 'paragraph', message: initial.error || 'Loading…', tone: initial.error ? 'error' : 'info'});
  const frameFeedback = createFeedbackPart({presentation: 'paragraph', message: '', tone: 'error'});
  const current = () => alive && dialog.isOpen();
  function release(): void {
    if (!alive) return;
    const notify = opened;alive = false;opened = false;
    try {dialog.destroy();} finally {if (notify) callbacks.onClose?.();}
  }
  function close(): void {if (alive) {dialog.close(); release();}}
  dialog = createDialogPart({purpose: 'feature', title: initial.path ? 'Edit workspace resource' : `Create ${initial.kind}`,
    children: [status, frameFeedback], onClose: release, onDispose: release});
  return {
    part: dialog,
    open() {if (alive && !dialog.isOpen()) {dialog.open();opened = dialog.isOpen();}},
    update(next) {if (current()) status.update({message: next.error || 'Loading…', tone: next.error ? 'error' : 'info'});},
    fail(message) {if (current()) frameFeedback.update({message, tone: 'error'});},
    close, isOpen: current, destroy: close,
  };
}

/** Standalone validation adapter; shared application owners use the builder. */
export function mountResourceLoading(mount: HTMLElement, initial: Readonly<ResourceLoadingState> & {readonly kind: ResourceKind; readonly path?: string}, callbacks: {onClose?(): void} = {}, appearance: MountPartsOptions = {}): ResourceLoadingAssembly {
  const loading = composeResourceLoading(initial,callbacks);
  mountParts(mount,loading.part,appearance);loading.open();return loading;
}
