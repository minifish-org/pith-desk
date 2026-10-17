/** Internal application-owned recipe. OAuth requests and login identity stay with the controller. */
import {
  createButtonPart,createDialogPart,createFeedbackPart,createFieldLabelPart,createFooterPart,
  createFormPart,createInlineGroupPart,createInputPart,createLinkPart,createSelectPart,
  createStackPart,createTextFlowPart,mountParts,
  type ChoicePart,type DialogPart,type FormPart,type MountPartsOptions,type Part,type ValuePart,
} from 'pith-ui';

export type Result = {ok: true} | {ok: false;error: string};
export interface ProviderLoginState {phase: string;message: string;url?: string;code?: string;prompt?: string;promptType?: string;options?: readonly {id: string;label: string}[] | null;error?: string;disabled?: boolean}
export interface ProviderLoginCallbacks {
  onAnswer?(answer: string): void | Result | Promise<void | Result>;
  onCancel?(): void | Result | Promise<void | Result>;
  onOpenExternal?(url: string): void | Result | Promise<void | Result>;
  onClose?(): void;
}
export interface ProviderLoginAssembly {update(state: Readonly<ProviderLoginState>): void;fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void}
export interface ProviderLoginComposition extends ProviderLoginAssembly {readonly part: DialogPart;open(): void}

/** Standalone internal example adapter. Applications attach the opaque part to their shared tree. */
export function mountProviderLogin(mount: HTMLElement,initial: Readonly<ProviderLoginState>,callbacks: ProviderLoginCallbacks = {},appearance: MountPartsOptions = {}): ProviderLoginAssembly {
  const login = composeProviderLogin(initial,callbacks);
  try {mountParts(mount,login.part,appearance);login.open();return login;}
  catch (error) {login.destroy();throw error;}
}

export function composeProviderLogin(initial: Readonly<ProviderLoginState>,callbacks: ProviderLoginCallbacks = {}): ProviderLoginComposition {
  let alive = true,state = initial,signature = '',localError = '',form: FormPart,dialog: DialogPart;
  let answer: ValuePart | ChoicePart | undefined;
  const status = createFeedbackPart({presentation: 'lead',message: initial.message,tone: initial.phase === 'error' ? 'error' : 'info'});
  const frameError = createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error'});
  const link = createLinkPart({presentation: 'paragraph',label: 'Open sign-in page in your browser ↗',href: initial.url,
    onOpen: callbacks.onOpenExternal,onError(message) {if (alive) frameError.update({message,tone: 'error'});}});
  const code = createTextFlowPart({segments: [{text: 'Verification code: '},{text: initial.code ?? '',emphasis: 'strong'}],hidden: !initial.code});
  const error = createFeedbackPart({message: initial.error ?? '',tone: 'error'});
  const release = () => {if (alive) {alive = false;form.invalidate();dialog.destroy();try {callbacks.onClose?.();} catch {}}};
  const close = () => {if (alive) {dialog.close();release();}};
  const submit = createButtonPart({label: 'Continue',variant: 'primary',type: 'submit'});
  const complete = createButtonPart({label: 'Close',variant: 'secondary',onAction: close});
  const cancel = createButtonPart({label: 'Cancel sign-in',variant: 'secondary',onAction() {try {return callbacks.onCancel?.();} finally {close();}}});
  const footer = createFooterPart({children: [complete,cancel]});
  function syncSubmit(): void {if (alive) submit.update({label: 'Continue',variant: 'primary',disabled: !!state.disabled,pending: form.isPending()});}
  form = createFormPart({purpose: 'answer',children: [submit],hidden: initial.phase !== 'prompt',disabled: !!initial.disabled || initial.phase !== 'prompt',onPending: syncSubmit,
    onError(message) {if (alive) {localError = message;error.update({message,tone: 'error'});}},
    onSubmit() {if (state.phase !== 'prompt' || !answer) return;localError = '';error.update({message: '',tone: 'error'});return callbacks.onAnswer?.(answer.read());},
  });
  const body = createStackPart({children: [status,link,code,form,error,footer]});
  dialog = createDialogPart({title: 'Provider sign-in',children: [body,frameError],onClose: release,onDispose: release});
  const update = (next: Readonly<ProviderLoginState>) => {
    if (!alive) return;
    state = next;const nextSignature = JSON.stringify([next.phase,next.prompt,next.promptType,next.options]);
    if (nextSignature !== signature) {
      signature = nextSignature;form.invalidate();localError = '';answer = undefined;
      const children: Part[] = [];
      if (next.phase === 'prompt') {
        answer = next.options?.length ? createSelectPart({label: next.prompt ?? '',options: next.options.map(option => ({value: option.id,label: option.label}))}) :
          createInputPart({label: next.prompt ?? '',kind: next.promptType === 'secret' ? 'password' : 'text',required: true,autocomplete: 'off'});
        children.push(createFieldLabelPart({label: next.prompt ?? '',control: answer}),createInlineGroupPart({children: [answer]}));
      }
      form.replace([...children,submit]);
    }
    status.update({message: next.message,tone: next.phase === 'error' ? 'error' : 'info'});
    link.update({label: 'Open sign-in page in your browser ↗',href: next.url});
    code.update({segments: [{text: 'Verification code: '},{text: next.code ?? '',emphasis: 'strong'}],hidden: !next.code});
    form.update({hidden: next.phase !== 'prompt',disabled: !!next.disabled || next.phase !== 'prompt'});
    error.update({message: next.error || localError,tone: 'error'});
    const finished = next.phase === 'complete' || next.phase === 'error';
    complete.update({label: 'Close',variant: 'secondary',hidden: !finished});cancel.update({label: 'Cancel sign-in',variant: 'secondary',hidden: finished});syncSubmit();
  };
  update(initial);
  return {part: dialog,open() {if (alive) dialog.open();},update,fail(message) {if (alive) frameError.update({message,tone: 'error'});},close,isOpen: () => alive && dialog.isOpen(),destroy: close};
}
