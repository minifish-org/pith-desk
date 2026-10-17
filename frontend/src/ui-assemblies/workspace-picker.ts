/** Internal executable composition. Workspace IDs, folder selection and writes
 * remain application data and callbacks, never a package scene interface. */
import {
  createButtonPart,createDialogPart,createFeedbackPart,createFieldLabelPart,createFooterPart,createFormPart,createInputPart,
  createLabelledDividerPart,createOptionActionPart,createOptionGroupPart,createSeparatedGroupPart,createTextPart,mountParts,
  type DialogPart,type FormPart,type MountPartsOptions,type OptionActionPart,
} from 'pith-ui';

export interface PickerWorkspace {id: string;name: string;path: string}
export interface WorkspacePickerState {workspaces: readonly PickerWorkspace[];error?: string;disabled?: boolean}
export type WorkspacePickerResult = {ok: true}|{ok: false;error: string};
export interface WorkspacePickerCallbacks {
  onSubmit?(path: string): WorkspacePickerResult|Promise<WorkspacePickerResult>;
  onPick?(): Promise<{path?: string;error?: string}>;
  onSelect?(id: string): void;
  onClose?(): void;
}
export interface WorkspacePickerAssembly {
  read(): {path: string};update(state: Readonly<WorkspacePickerState>): void;reset(path?: string): void;focus(): void;
  fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void;
}
export interface WorkspacePickerComposition extends WorkspacePickerAssembly {readonly part: DialogPart;open(): void}

/** Dialog -> description, option group, separated picker/divider/path form. */
export function composeWorkspacePicker(initial: Readonly<WorkspacePickerState>,callbacks: WorkspacePickerCallbacks = {}): WorkspacePickerComposition {
  let current = initial,alive = true,opened = false,picking = false,revision = 0,saved = '';
  let dialog: DialogPart,form: FormPart;
  const rows = new Map<string,{part: OptionActionPart;data: PickerWorkspace}>();
  const description = createTextPart({role: 'description',text: 'Choose a local folder. Conversations belong to a workspace, so Pith knows where to read and create files.'});
  const options = createOptionGroupPart({children: []});
  const input = createInputPart({purpose: 'path',label: 'Absolute folder path',name: 'path',placeholder: '/Users/you/Documents/my-work',required: true,autocomplete: 'off'});
  const label = createFieldLabelPart({label: 'Absolute folder path',control: input,screenReaderOnly: true});
  const hint = createTextPart({role: 'hint',text: 'Use an existing folder on this computer. Pith will work inside it.'});
  const feedback = createFeedbackPart({message: initial.error ?? '',tone: 'error'});
  const cancel = createButtonPart({label: 'Cancel',variant: 'secondary',onAction() {close();}});
  const submit = createButtonPart({label: 'Add workspace',variant: 'primary',type: 'submit'});
  const picker = createButtonPart({label: 'Choose a folder…',variant: 'picker',icon: 'folder',onAction: callbacks.onPick ? pick : undefined});
  const setError = (message: string) => {if (alive) {current = {...current,error: message};sync();}};
  const read = () => ({path: alive ? input.read() : saved});
  function sync(): void {
    if (!alive) return;const disabled = !!current.disabled,pending = picking || form.isPending();
    submit.update({label: 'Add workspace',variant: 'primary',disabled,pending});picker.update({label: 'Choose a folder…',variant: 'picker',icon: 'folder',disabled,pending});
    for (const row of rows.values()) row.part.update({label: row.data.name,description: row.data.path,icon: 'folder',disabled: disabled || pending});
    feedback.update({message: current.error ?? '',tone: 'error'});form.update({disabled: disabled || picking});
  }
  function pick(): void {
    if (!alive || current.disabled || picking || form.isPending() || !callbacks.onPick) return;
    const target = revision;picking = true;current = {...current,error: ''};sync();
    const currentTarget = () => alive && revision === target;
    const finish = () => {if (currentTarget()) {picking = false;sync();}};
    const failed = (error: unknown) => {if (currentTarget()) {setError(`${error instanceof Error ? error.message : String(error)} You can enter the path below.`);input.focus();}};
    try {
      void callbacks.onPick().then(result => {
        if (!currentTarget()) return;
        // Release picker availability before attempting the separate submit.
        // The current host restriction can now refuse that write independently.
        picking = false;sync();
        if (result.error) {setError(result.error);input.focus();}
        else if (result.path) {input.reset(result.path);form.submit();}
      }).catch(failed).finally(finish);
    } catch (error) {try {failed(error);} finally {finish();}}
  }
  function release(): void {
    if (!alive) return;const notify = opened;saved = input.read();alive = false;opened = false;revision++;picking = false;form.invalidate();rows.clear();dialog.destroy();
    if (notify) {try {callbacks.onClose?.();} catch {}}
  }
  function close(): void {if (alive) {dialog.close();release();}}
  form = createFormPart({children: [label,input,hint,feedback,createFooterPart({children: [cancel,submit]})],onPending: sync,onError: setError,
    onSubmit: callbacks.onSubmit ? () => {
      const path = input.read().trim();if (!path || !alive) return;
      const target = revision;current = {...current,error: ''};sync();
      const accept = (result: WorkspacePickerResult) => {if (alive && revision === target && result.ok) close();return result;};
      const result = callbacks.onSubmit!(path);return result && typeof result === 'object' && 'then' in result ? Promise.resolve(result).then(accept) : accept(result);
    } : undefined,
  });
  const supplement = createSeparatedGroupPart({children: [picker,createLabelledDividerPart({label: 'or enter a folder path'}),form]});
  dialog = createDialogPart({title: 'Workspaces',eyebrow: 'A PLACE TO WORK',children: [description,options,supplement],onClose: release,onDispose: release});
  function update(state: Readonly<WorkspacePickerState>): void {
    if (!alive) return;current = {...state,error: state.error ?? current.error};const keep = new Set(state.workspaces.map(entry => entry.id));
    for (const [key,row] of rows) if (!keep.has(key)) {row.part.destroy();rows.delete(key);}
    const children: OptionActionPart[] = [];
    for (const entry of state.workspaces) {
      let row = rows.get(entry.id);
      if (!row) {const part = createOptionActionPart({label: entry.name,description: entry.path,icon: 'folder',onAction() {if (alive && !current.disabled && !picking && !form.isPending()) callbacks.onSelect?.(entry.id);}});row = {part,data: entry};rows.set(entry.id,row);}
      row.data = entry;children.push(row.part);
    }
    options.replace(children);sync();
  }
  update(initial);
  return {part: dialog,read,update,close,isOpen: () => alive && dialog.isOpen(),
    open() {if (alive) {dialog.open();opened = dialog.isOpen();if (opened) input.focus();}},
    focus() {if (alive) input.focus();},
    fail(message) {if (alive && dialog.isOpen()) feedback.update({message,tone: 'error'});},
    reset(path = '') {if (alive) {revision++;picking = false;form.invalidate();picker.invalidate();input.reset(path);current = {...current,error: ''};sync();}},
    destroy() {dialog.destroy();},
  };
}

/** Standalone internal adapter; integrated consumers mount the outer frame. */
export function mountWorkspacePicker(mount: HTMLElement,initial: Readonly<WorkspacePickerState>,callbacks: WorkspacePickerCallbacks = {},appearance: MountPartsOptions = {}): WorkspacePickerAssembly {
  const picker = composeWorkspacePicker(initial,callbacks);
  try {mountParts(mount,picker.part,appearance);picker.open();return picker;}
  catch (error) {picker.destroy();throw error;}
}
