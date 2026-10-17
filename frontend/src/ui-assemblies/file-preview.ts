import {previewPageRanges} from './preview-pages.js';
/** Internal application recipe. File reads, native actions and URL lifetime stay in the host. */
import {
  createAnnouncementPart, createButtonPart, createCompactActionsPart, createContentViewportPart,
  createCopyButtonPart, createDialogPart, createImagePart, createMarkdownPart, createPaginationPart,
  createPreformattedPart, createStackPart, createTextPart, createTrailingActionsPart, mountParts,
  type AnnouncementPart, type ButtonPart, type DialogPart, type ImagePart, type MarkdownPart,
  type MountPartsOptions, type PaginationPart, type Part, type PreformattedPart, type TextPart,
} from 'pith-ui';

export type PreviewKind = 'text' | 'markdown' | 'diff' | 'image';
export type PreviewResult = void | {ok: true} | {ok: false; error: string};
export interface PreviewState {readonly kind: PreviewKind; readonly text?: string; readonly imageSrc?: string; readonly imageAlt?: string; readonly truncated?: boolean; readonly error?: string; readonly disabled?: boolean}
export interface PreviewTarget {readonly owner: {readonly kind: 'artifact'; readonly id: string}; readonly name: string; readonly path: string}
export interface PreviewInput extends PreviewTarget {readonly capabilities: {readonly open?: boolean; readonly reveal?: boolean; readonly copyMode?: 'file' | 'path' | 'none'}; readonly content?: PreviewState}
export interface PreviewCallbacks {
  onFileAction?(action: 'open' | 'reveal' | 'copy' | 'copy-path', target: PreviewTarget): PreviewResult | Promise<PreviewResult>;
  onCopyCode?(text: string): PreviewResult | Promise<PreviewResult>;
  /** Connect the shared sibling image-viewer controller; pass only image data. */
  onImage?(image: Readonly<{src: string; alt: string}>): void;
  onClose?(): void;
}
export interface FilePreviewAssembly {
  update(state: Readonly<PreviewState>): void; fail(message: string): void;
  close(): void; isOpen(): boolean; destroy(): void;
}
export interface FilePreviewComposition extends FilePreviewAssembly {readonly part: DialogPart; open(): void}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A native modal owns caller-assembled path, bounded content and file actions. */
export function composeFilePreview(input: Readonly<PreviewInput>, callbacks: PreviewCallbacks, announcement: AnnouncementPart): FilePreviewComposition {
  const target: PreviewTarget = Object.freeze({owner: Object.freeze({...input.owner}),name: input.name,path: input.path});
  let content: Readonly<PreviewState> = input.content ?? {kind: 'text'},alive = true,opened = false,pending = false,revision = 0;
  let dialog: DialogPart,mode: PreviewKind | 'error' | undefined,sourceText: string | undefined;
  let contentPart: ImagePart | MarkdownPart | PreformattedPart | undefined,pager: PaginationPart | undefined,note: TextPart | undefined;
  let bytes = new Uint8Array(),ranges: Array<[number,number]> = [[0,0]],page = 0;
  const decoder = new TextDecoder('utf-8',{fatal: true});
  const viewport = createContentViewportPart({purpose: 'preview',content: 'Loading preview…'});
  const current = () => alive && dialog.isOpen();
  function fail(message: string): void {if (current()) {content = {...content,error: message};renderContent();}}
  const actionButtons: {button: ButtonPart;label: string}[] = [];
  function availability(): void {for (const {button,label} of actionButtons) button.update({label,variant: 'secondary',disabled: !!content.disabled || pending});}
  async function completed(value: PreviewResult | Promise<PreviewResult>): Promise<void> {const result = await value;if (result && !result.ok) throw new Error(result.error);}
  function run(action: 'open' | 'reveal'): void {
    if (!current() || content.disabled || pending || !callbacks.onFileAction) return;
    const sequence = ++revision;pending = true;availability();
    void Promise.resolve().then(() => callbacks.onFileAction!(action,target)).then(completed).catch(error => {if (current() && revision === sequence) fail(errorMessage(error));}).finally(() => {
      if (alive && revision === sequence) {pending = false;availability();}
    });
  }
  const open = input.capabilities.open === false ? undefined : createButtonPart({label: 'Open',variant: 'secondary',onAction() {run('open');}});
  const reveal = input.capabilities.reveal === false ? undefined : createButtonPart({label: 'Reveal',variant: 'secondary',onAction() {run('reveal');}});
  const copyMode = input.capabilities.copyMode ?? 'none',copyLabel = copyMode === 'file' ? 'Copy file' : 'Copy path';
  const copy = copyMode === 'none' ? undefined : !callbacks.onFileAction ? createButtonPart({label: copyLabel,variant: 'secondary'}) : createCopyButtonPart({label: copyLabel,variant: 'secondary',announcement,successMessage: copyMode === 'file' ? 'File copied.' : 'Path copied.',
    async onCopy() {if (!current() || content.disabled) return;await completed(callbacks.onFileAction!(copyMode === 'file' ? 'copy' : 'copy-path',target));},onError: fail});
  if (open) actionButtons.push({button: open,label: 'Open'});if (reveal) actionButtons.push({button: reveal,label: 'Reveal'});if (copy) actionButtons.push({button: copy,label: copyLabel});
  const actions = createCompactActionsPart({children: actionButtons.map(entry => entry.button)});
  function footnote(): Part[] {
    if (content.truncated && !note) note = createTextPart({role: 'footnote',text: 'Showing the first 8 MiB. Use Open for the complete file.'});
    if (!content.truncated) note = undefined;
    return note ? [note] : [];
  }
  function renderPage(): void {
    const [start,end] = ranges[page]!,text = decoder.decode(bytes.subarray(start,end));
    if (content.kind === 'markdown' && ranges.length === 1) (contentPart as MarkdownPart).update({text});
    else (contentPart as PreformattedPart).update({text,...(content.kind === 'diff' ? {label: 'Proposed file changes'} : {})});
    pager?.update({page,total: ranges.length,...(content.kind === 'markdown' ? {note: 'Plain text preview'} : {})});
  }
  function renderContent(): void {
    if (!alive) return;
    const nextMode = content.error ? 'error' : content.kind;
    if (mode !== nextMode) {contentPart = undefined;pager = undefined;note = undefined;sourceText = undefined;mode = nextMode;}
    if (content.error) {viewport.replace({message: content.error,children: footnote()});return;}
    if (content.kind === 'image') {
      if (!contentPart) contentPart = createImagePart({purpose: 'preview',src: content.imageSrc ?? '',alt: content.imageAlt ?? '',status: 'ready',onActivate(image) {if (current()) callbacks.onImage?.(image);}});
      else (contentPart as ImagePart).update({src: content.imageSrc ?? '',alt: content.imageAlt ?? '',status: 'ready'});
    } else if (!contentPart || sourceText !== (content.text ?? '')) {
      sourceText = content.text ?? '';bytes = new TextEncoder().encode(sourceText);ranges = previewPageRanges(bytes);page = 0;
      contentPart = content.kind === 'markdown' && ranges.length === 1 ? createMarkdownPart({text: sourceText,
        ...(callbacks.onCopyCode ? {onCopyCode: async (text: string) => {if (current()) return callbacks.onCopyCode!(text);}} : {}),onError: fail})
        : createPreformattedPart({kind: content.kind === 'diff' ? 'diff' : 'text',text: '',...(content.kind === 'diff' ? {label: 'Proposed file changes'} : {})});
      pager = ranges.length > 1 ? createPaginationPart({page,total: ranges.length,...(content.kind === 'markdown' ? {note: 'Plain text preview'} : {}),onPage(next) {if (current()) {page = next;renderPage();}}}) : undefined;
      renderPage();
    }
    viewport.replace([...(pager ? [pager] : []),contentPart!,...footnote()]);
  }
  function release(): void {
    if (!alive) return;
    const notify = opened;alive = false;opened = false;revision++;pending = false;
    try {dialog.destroy();} finally {if (notify) callbacks.onClose?.();}
  }
  function close(): void {if (alive) {dialog.close();release();}}
  dialog = createDialogPart({purpose: 'preview',title: target.name,eyebrow: 'File preview',children: [createTextPart({role: 'location',text: target.path}),viewport,createTrailingActionsPart({children: [actions]})],onClose: release,onDispose: release});
  if (input.content) renderContent();availability();
  return {
    part: dialog,
    open() {if (alive && !dialog.isOpen()) {dialog.open();opened = dialog.isOpen();}},
    update(next) {if (current()) {content = next;renderContent();availability();}},fail,close,isOpen: current,destroy: close,
  };
}

/** Standalone validation adapter; the real application supplies shared siblings. */
export function mountFilePreview(mount: HTMLElement, input: Readonly<PreviewInput>, callbacks: PreviewCallbacks = {}, appearance: MountPartsOptions = {}): FilePreviewAssembly {
  const announcement = createAnnouncementPart({message: ''}),preview = composeFilePreview(input,callbacks,announcement);
  mountParts(mount,createStackPart({children: [announcement,preview.part]}),appearance);preview.open();return preview;
}
