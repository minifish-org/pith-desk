/** Internal executable blueprint. Draft, action and permission policy belong to Desk. */
import {createButtonPart,createCompactSelectPart,createComposerRegionPart,createComposerPanelsPart,createInputToolbarPart,createInputContextPart,createInputActionsPart,createMessageInputPart,createFilePickerPart,createFormPart,createFeedbackPart,createContextNotePart,type LayoutPart,type ImageData,type NativeFileDropData} from 'pith-ui';
import {composePermissionControl,type PermissionState} from './permission-control.js';
import {composeAttachments,type AttachmentsState} from './attachments.js';

export interface ComposerState {placeholder?: string;disabled?: boolean;readOnly?: boolean;action?: 'send'|'queue'|'stop';actionDisabled?: boolean;model?: {label: string;description: string;disabled?: boolean};thinking?: {options: readonly {value: string;label: string}[];value: string;disabled?: boolean}}
type Result = void|{ok: true}|{ok: false;error: string};
export interface ComposerCallbacks {onSubmit?(text: string): Result|Promise<Result>;onStop?(): Result|Promise<Result>;onInput?(text: string): void;onBlur?(): void;onAction?(action: 'model'): void;onThinkingChange?(value: string): void;onImages?(files: File[]): void;onPermissionChange?(mode: string): void;onRemoveAttachment?(id: string): void;onOpenImage?(image: ImageData): void;onDropReferences?(data: {paths: readonly string[];uris?: string;hasUnidentifiedFiles: boolean}): void}
export interface ComposerComposition {readonly part: LayoutPart;readonly panels: LayoutPart;updateComposer(state: Readonly<ComposerState>): void;readDraft(): string;resetDraft(text: string): void;focusComposer(): void;pickImages(): void;insertReferences(paths: readonly string[]): void;updatePermission(state: Readonly<PermissionState>): void;updateAttachments(state: Readonly<AttachmentsState>): void;updateAvailability(state: {busy?: boolean}): void;updateImageGuidance(message: string): void;setDropPending(value: boolean): void;receiveNativeDrop(data: NativeFileDropData): void;destroy(): void}
export function composeComposer(initial: Readonly<ComposerState>,callbacks: ComposerCallbacks = {}): ComposerComposition {
  let alive = true,last = initial,action: 'send'|'queue'|'stop' = 'send',attachmentsDisabled = false,busy = false,dropPending = false;
  const unavailable = () => !!last.disabled || !!last.readOnly || busy;
  const error = createFeedbackPart({message: '',tone: 'error',hidden: true});
  const fail = (message: string) => error.update({message,tone: 'error',hidden: !message});
  const permission = composePermissionControl({mode: 'ask',description: ''},{onChange: callbacks.onPermissionChange});
  const attachments = composeAttachments({items: []},{onRemove: callbacks.onRemoveAttachment,onOpen: callbacks.onOpenImage});
  const picker = createFilePickerPart({kind: 'images',onFiles(files) {if (alive) callbacks.onImages?.(files);}});
  const input = createMessageInputPart({label: 'Message Pith',placeholder: 'Ask Pith to help with your work…',onInput: callbacks.onInput,onBlur: callbacks.onBlur,onImages: callbacks.onImages,onSubmit() {if (alive && action !== 'stop') form.submit();}});
  const attach = createButtonPart({variant: 'context-icon',icon: 'image',label: 'Attach images',title: 'Attach images',onAction() {pickImages();}});
  const model = createButtonPart({variant: 'compact-choice',label: 'Choose model',accessibleLabel: 'Choose model',onAction() {if (alive) callbacks.onAction?.('model');}});
  const thinking = createCompactSelectPart({purpose: 'inline',label: 'Thinking effort',options: [],onChange: callbacks.onThinkingChange});
  const send = createButtonPart({variant: 'submit-icon',icon: 'arrow',type: 'submit',label: 'Send message',onAction() {if (alive && action === 'stop') form.submit();}});
  const toolbar = createInputToolbarPart({children: [createInputContextPart({children: [attach,permission.control]}),createInputActionsPart({children: [model,thinking,send]})]});
  const form = createFormPart({purpose: 'composer',children: [error,attachments.part,picker,input,toolbar],dropEnabled: true,onNativeDrop(paths) {if (alive && !unavailable() && !dropPending) callbacks.onDropReferences?.({paths,hasUnidentifiedFiles: false});},onDrop({files,uris}) {
    if (!alive || unavailable()) return;
    const isImage = (file: File) => ['image/png','image/jpeg','image/gif','image/webp'].includes(file.type) || !file.type && /\.(?:png|jpe?g|gif|webp)$/i.test(file.name);
    const images = files.filter(isImage);if (images.length && !attachmentsDisabled) callbacks.onImages?.(images);if (dropPending) return;
    const hasUnidentifiedFiles = files.some(file => !isImage(file));if (uris || hasUnidentifiedFiles) callbacks.onDropReferences?.({paths: [],uris,hasUnidentifiedFiles});
  },onPending() {update(last);},onError: fail,onSubmit() {
    if (!alive) return;
    if (action === 'stop') {if (!callbacks.onStop) return;fail('');return callbacks.onStop();}
    if (last.disabled || last.readOnly || !callbacks.onSubmit) return;fail('');return callbacks.onSubmit(input.read());
  }});
  const panels = createComposerPanelsPart({children: []});
  const guidance = createContextNotePart({purpose: 'attachment-guidance',text: '',hidden: true});
  const part = createComposerRegionPart({children: [panels,form,guidance,permission.description],onDispose() {alive = false;}});
  function syncAttach(): void {attach.update({variant: 'context-icon',icon: 'image',label: 'Attach images',title: 'Attach images',disabled: attachmentsDisabled || unavailable()});form.update({dropEnabled: !unavailable() && !dropPending});}
  function update(state: Readonly<ComposerState>): void {
    if (!alive) return;last = state;if (state.action) action = state.action;
    input.update({disabled: !!state.disabled,readOnly: !!state.readOnly,...(state.placeholder !== undefined ? {placeholder: state.placeholder} : {})});
    const label = action === 'stop' ? 'Stop agent' : action === 'queue' ? 'Queue message' : 'Send message';
    send.update({...(action === 'stop' ? {variant: 'stop-icon' as const,icon: 'stop' as const,type: 'button' as const} : {variant: 'submit-icon' as const,icon: 'arrow' as const,type: 'submit' as const}),label,title: label,disabled: !!(state.actionDisabled || state.disabled),pending: form.isPending()});
    form.update({disabled: !!(state.actionDisabled || state.disabled)});
    if (state.model) model.update({variant: 'compact-choice',label: state.model.label,title: state.model.description,accessibleLabel: 'Choose model',disabled: !!state.model.disabled});
    if (state.thinking) {thinking.update({options: state.thinking.options,disabled: !!state.thinking.disabled,hidden: state.thinking.options.length < 2});thinking.reset(state.thinking.value);}
    syncAttach();
  }
  function pickImages(): void {if (alive && !last.disabled && !last.readOnly && !busy && !attachmentsDisabled) picker.pick();}
  function resetDraft(text: string): void {if (alive) {form.invalidate();fail('');input.reset(text);update(last);}}
  update(initial);
  return {part,panels,updateComposer: update,readDraft: input.read,resetDraft,focusComposer: input.focus,pickImages,
    insertReferences(paths) {if (!alive || unavailable() || dropPending || !paths.length) return;
      const reference = paths.map(path => {const ticks = Math.max(0,...[...path.matchAll(/`+/g)].map(match => match[0].length))+1,delimiter = '`'.repeat(ticks);return delimiter + (/^`|`$|^ | $/.test(path) && !/^ +$/.test(path) ? ' '+path+' ' : path) + delimiter;}).join(' ');
      const {before,after} = input.readSelection(),inserted = (before && !/\s$/.test(before) ? ' ' : '') + reference + (after && !/^\s/.test(after) ? ' ' : '');
      form.invalidate();fail('');input.replaceSelection(inserted);update(last);input.focus();callbacks.onInput?.(input.read());
    },updatePermission: permission.update,updateAttachments(state) {if (alive) {attachmentsDisabled = !!state.disabled;attachments.update(state);syncAttach();}},updateAvailability(state) {if (alive) {busy = !!state.busy;syncAttach();}},updateImageGuidance(message) {if (alive) guidance.update({text: message,hidden: !message});},setDropPending(value) {if (alive) {dropPending = value;syncAttach();}},receiveNativeDrop: form.receiveNativeDrop,destroy() {part.destroy();},
  };
}
