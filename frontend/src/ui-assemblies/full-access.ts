/** Executable consumer composition, intentionally absent from package exports. */
import {
  createButtonPart, createDialogPart, createFeedbackPart, createFooterPart,
  createIconPart, createStackPart, createTextFlowPart, createTextPart,
  createWarningPart, mountParts,
  type DialogPart, type MountPartsOptions,
} from 'pith-ui';

export interface FullAccessState {title?: string; error?: string; disabled?: boolean}
export type FullAccessResult = {ok: true} | {ok: false; error: string};
export interface FullAccessCallbacks {onConfirm(): FullAccessResult | Promise<FullAccessResult>; onClose?(): void}
export interface FullAccessAssembly {update(state: Readonly<FullAccessState>): void; close(): void; isOpen(): boolean; destroy(): void}
export interface FullAccessComposition extends FullAccessAssembly {readonly part: DialogPart; open(): void}

/** Dialog -> literal description, Warning(icon + Stack(strong, paragraph)),
 * Note, Feedback, Footer(Cancel, warning confirmation). */
export function composeFullAccess(initial: Readonly<FullAccessState>, callbacks: FullAccessCallbacks): FullAccessComposition {
  let state = initial, alive = true, opened = false, revision = 0;
  let dialog: DialogPart;
  const segments = (value: FullAccessState) => [
    {text: 'Give Pith permission to run '},
    {text: 'all enabled tools, including external MCP connections,',emphasis: 'strong' as const},
    {text: ' without asking in '},
    {text: value.title || 'this conversation',emphasis: 'strong' as const},
    {text: '.'},
  ];
  const description = createTextFlowPart({role: 'description',segments: segments(initial)});
  const icon = createIconPart({name: 'shield'});
  const heading = createTextPart({role: 'strong',text: 'This is access to your computer account and connected services.'});
  const explanation = createTextPart({role: 'paragraph',text: 'Commands can read, change, or delete files outside the workspace and access the network. External tools can act on their connected services. There is no OS sandbox.'});
  const body = createStackPart({children: [heading,explanation]});
  const warning = createWarningPart({children: [icon,body]});
  const note = createTextPart({role: 'note',text: 'This applies only to the current conversation and stays enabled across app restarts until you revoke it. To revoke it, choose “Ask before changes” or “Allow workspace changes” in the composer. Workspace permission alone never grants external MCP tools access.'});
  const error = createFeedbackPart({message: initial.error ?? '',tone: 'error'});
  const cancel = createButtonPart({label: 'Cancel',variant: 'secondary',onAction: close});
  const confirm = createButtonPart({label: 'Enable full access',variant: 'warning',
    async onAction() {
      const submitted = revision; render({...state,error: ''});
      const result = await callbacks.onConfirm();
      if (alive && opened && submitted === revision && result.ok) close();
      return result;
    },
    onError(message) {if (alive && opened) render({...state,error: message});},
  });
  const footer = createFooterPart({children: [cancel,confirm]});
  const notify = () => {try {callbacks.onClose?.();} catch { /* This opening is already released. */ }};
  function render(next: Readonly<FullAccessState>): void {
    if (!alive || !opened) return;
    state = {...next,error: next.error ?? state.error};
    description.update({segments: segments(next)});
    error.update({message: state.error ?? '',tone: 'error'});
    confirm.update({label: 'Enable full access',variant: 'warning',disabled: !!next.disabled});
  }
  function disposed(): void {
    if (!alive) return;
    const wasOpen = opened; opened = false; alive = false; revision++;
    if (wasOpen) notify();
  }
  function close(): void {if (alive && opened) {dialog.close(); dialog.destroy();}}
  dialog = createDialogPart({purpose: 'warning',title: 'Enable full access?',eyebrow: 'CONVERSATION PERMISSIONS',closeLabel: 'Cancel full access',
    children: [description,warning,note,error,footer],onClose: close,onDispose: disposed});
  return {part: dialog,update: render,open() {if (alive && !opened) {dialog.open(); if (dialog.isOpen()) {opened = true; render(state);}}},
    close,isOpen: () => alive && opened && dialog.isOpen(),destroy() {if (alive) dialog.destroy();}};
}

/** Standalone demonstration adapter; the shared application owns one part tree. */
export function mountFullAccess(mount: HTMLElement, initial: Readonly<FullAccessState>, callbacks: FullAccessCallbacks, appearance: MountPartsOptions = {}): FullAccessAssembly {
  const assembly = composeFullAccess(initial,callbacks); mountParts(mount,assembly.part,appearance); assembly.open(); return assembly;
}
