import {mutate, request, setError, copyText} from './core.ts';
import {desk, newDraftScope, type DraftImage} from '@/stores/desk.ts';
import {selected, blockedWorkspace, focusComposer, isConversationRunning} from './conversations.ts';
import {createDrafts, draftKey} from '@/drafts.ts';
import {createDraftRecovery, type DraftRecovery} from '@/draft-recovery.ts';
import {imagePreviewBlob} from '@/image-data.ts';
import {app, runtime} from '@/lib/runtime.ts';
import type {DraftScope, DraftImage as WireDraftImage, ImageContent, QueuedMessage} from '@/contract.generated.ts';

type Draft = ReturnType<typeof createDrafts>;
type ImageInput = ImageContent;

let draftsInstance: Draft | undefined;
let recoveryInstance: DraftRecovery | undefined;
let recoveryEnabled = false;
let scope: DraftScope = {};
let draftReady: Promise<void> = Promise.resolve();
let loadGeneration = 0;
let imageGeneration = 0;
let submittingMessageEdit = '';
let draftHandoff = false;
let composerElement: HTMLTextAreaElement | null = null;

export function composerRecovery(): DraftRecovery | undefined {
  return recoveryInstance;
}

export function enableDraftRecovery(recovery?: DraftRecovery): void {
  recoveryEnabled = true;
  if (recovery) recoveryInstance = recovery;
}

function drafts(): Draft {
  const draftRequest = ((path: string, input?: unknown, options?: {signal?: AbortSignal; keepalive?: boolean}) =>
    (request as unknown as (p: string, i?: unknown, o?: unknown) => Promise<unknown>)(path, input, options)) as never;
  draftsInstance ??= createDrafts(
    draftRequest,
    message => setError(message),
    250,
    recoveryEnabled ? recoveryInstance ??= createDraftRecovery() : undefined,
  );
  return draftsInstance;
}

export function composerScope(): DraftScope {
  return scope;
}

export function composerText(): string {
  return desk().composer.text;
}

export function rememberDraft(): void {
  const composer = desk().composer;
  if (composer.loading) return;
  drafts().update(scope, composer.text, composer.images.map(({url: _url, ...image}) => image));
}

export function setComposerText(text: string): void {
  desk().setComposer({text});
  rememberDraft();
}

export function attachComposerElement(element: HTMLTextAreaElement | null): void {
  composerElement = element;
}

/** Insert an inline Markdown reference at the caret, replacing a selection. */
export function insertReference(path: string): void {
  const text = desk().composer.text;
  const element = composerElement && document.contains(composerElement) ? composerElement : null;
  const start = element?.selectionStart ?? text.length;
  const end = element?.selectionEnd ?? text.length;
  const trailing = !text[end] || /\s/.test(text[end]) ? '' : ' ';
  const insert = `\`${path}\`` + trailing;
  const next = text.slice(0, start) + insert + text.slice(end);
  desk().setComposer({text: next});
  rememberDraft();
  requestAnimationFrame(() => {
    if (!composerElement) return;
    composerElement.focus();
    const caret = start + insert.length;
    composerElement.setSelectionRange(caret, caret);
  });
}

export function insertReferences(paths: string[]): void {
  if (!paths.length) return;
  const element = composerElement && document.contains(composerElement) ? composerElement : null;
  const text = element?.value ?? desk().composer.text;
  const start = element?.selectionStart ?? text.length;
  const end = element?.selectionEnd ?? text.length;
  const trailing = !text[end] || /\s/.test(text[end]) ? '' : ' ';
  const insert = paths.map(path => `\`${path}\``).join(' ') + trailing;
  desk().setComposer({text: text.slice(0, start) + insert + text.slice(end), dropPending: false});
  rememberDraft();
  requestAnimationFrame(() => {
    if (!composerElement) return;
    composerElement.focus();
    const caret = start + insert.length;
    composerElement.setSelectionRange(caret, caret);
  });
}

export function setDropPending(pending: boolean): void {
  desk().setComposer({dropPending: pending});
}

export async function loadComposerDraft(): Promise<void> {
  // Creating the first conversation changes activeId before the draft has been
  // transferred. The send path owns the scope during that handoff.
  if (draftHandoff) return;
  const state = desk().state;
  const next = newDraftScope(state, desk().selectedWorkspaceId);
  if (draftKey(next) === draftKey(scope)) return;
  const previous = scope;
  const exists = previous.id ? state.conversations.some(entry => entry.id === previous.id) : state.workspaces.some(entry => entry.id === previous.workspaceId);
  if (exists) {
    rememberDraft();
    void drafts().flush(previous).catch(() => {});
  }
  clearImages();
  scope = next;
  const generation = ++loadGeneration;
  desk().setComposer({text: '', loading: !!draftKey(next)});
  drafts().prune(state.conversations.map(entry => entry.id), state.workspaces.map(entry => entry.id));
  if (!draftKey(next)) return;
  draftReady = drafts().load(next).then(async draft => {
    if (generation !== loadGeneration) return;
    // A submitted pending message must not reappear as an unsent draft after a
    // late autosave or refresh.
    if (draft.text && !draft.images?.length && desk().state.queuedMessages.some(entry => entry.text === draft.text)) {
      drafts().clearIfUnchanged(next, draft.text, []);
      void drafts().flush(next).catch(() => {});
      draft = {...draft, text: ''};
    }
    const images = await restoreDraftImages(draft.images || [], () => generation === loadGeneration);
    if (generation !== loadGeneration) {
      for (const image of images) URL.revokeObjectURL(image.url);
      return;
    }
    if (generation === loadGeneration) desk().setComposer({text: draft.text, images});
  }).catch(error => {
    if (generation === loadGeneration) setError(`Draft could not be restored: ${error instanceof Error ? error.message : String(error)}`);
  }).finally(() => {
    if (generation === loadGeneration) desk().setComposer({loading: false});
  });
}

export function clearImages(ids?: Set<string>): void {
  const composer = desk().composer;
  if (!ids) imageGeneration++;
  const kept: DraftImage[] = [];
  for (const image of composer.images) {
    if (ids && !ids.has(image.id)) kept.push(image);
    else URL.revokeObjectURL(image.url);
  }
  desk().setComposer({images: kept});
}

async function restoreDraftImages(images: WireDraftImage[], active: () => boolean): Promise<DraftImage[]> {
  const restored: DraftImage[] = [];
  for (const image of images) {
    const blob = await imagePreviewBlob(image.data, image.mimeType, active);
    if (blob && active()) restored.push({...image, type: 'image', url: URL.createObjectURL(blob)});
  }
  return restored;
}

export async function addImageFiles(files: File[]): Promise<void> {
  const composer = desk().composer;
  if (!files.length || desk().activity.busy || composer.reading || composer.loading) return;
  desk().setComposer({reading: true});
  desk().setError('');
  const added: DraftImage[] = [];
  const generation = imageGeneration;
  try {
    const limit = desk().state.settings.imageUploadLimit || 50 * 1024 * 1024;
    const total = composer.images.reduce((sum, image) => sum + image.size, 0) + files.reduce((sum, file) => sum + file.size, 0);
    if (total > limit) throw new Error('Image attachments must total 50 MiB or less per message.');
    for (const file of files) {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const mimeType = file.type || ({png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'} as Record<string, string>)[extension];
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) || !file.size) throw new Error('Use nonempty PNG, JPEG, GIF or WebP images.');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
        reader.readAsDataURL(file);
      });
      added.push({
        id: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
        type: 'image', data, mimeType, name: file.name || 'Pasted image', size: file.size, url: URL.createObjectURL(file),
      });
    }
    if (generation !== imageGeneration) {
      for (const image of added) URL.revokeObjectURL(image.url);
      return;
    }
    desk().setComposer({images: [...desk().composer.images, ...added]});
    rememberDraft();
  } catch (error) {
    for (const image of added) URL.revokeObjectURL(image.url);
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    desk().setComposer({reading: false});
  }
}

export function removeAttachment(id: string): void {
  if (desk().activity.busy || desk().composer.reading) return;
  clearImages(new Set([id]));
  rememberDraft();
}

export function canSubmit(): boolean {
  const composer = desk().composer;
  return (!!composer.text.trim() || composer.images.length > 0)
    && !desk().activity.busy && !composer.loading && !composer.reading && !composer.resolving
    && (composer.images.length === 0 || desk().state.settings.supportsImages);
}

export function composerAction(): 'send' | 'queue' | 'stop' {
  const state = desk().state;
  const hasDraft = !!desk().composer.text.trim() || desk().composer.images.length > 0;
  return state.running && !hasDraft ? 'stop' : state.running ? 'queue' : 'send';
}

export function composerDisabled(): boolean {
  const state = desk().state;
  const composer = desk().composer;
  const stopping = composerAction() === 'stop';
  const workspace = selected();
  return stopping
    ? desk().activity.busy
    : !desk().loaded || desk().activity.busy || composer.loading || composer.reading || composer.resolving || !canSubmit()
      || (composer.images.length > 0 && !state.settings.supportsImages)
      || !workspace || !state.settings.hasApiKey || (!state.running && !!blockedWorkspace(workspace?.id));
}

export async function send(): Promise<void> {
  const composer = desk().composer;
  const text = composer.text.trim();
  const sourceScope = scope;
  const images: ImageInput[] = composer.images.map(({type, data, mimeType}) => ({type, data, mimeType}));
  const submittedImages = composer.images.map(({url: _url, ...image}) => image);
  const submittedIds = new Set(submittedImages.map(image => image.id));
  if ((!text && !images.length) || desk().activity.busy || composer.loading || composer.reading || composer.resolving) return;
  if (images.length && !desk().state.settings.supportsImages) {
    setError('Choose an image-capable model beside the message box, or remove the attachments.');
    return;
  }
  if (desk().state.running) {
    await queueMessage(text, composer.text, images, submittedImages);
    return;
  }
  if (!desk().state.settings.hasApiKey) {
    const {openSettings} = await import('./settings.ts');
    openSettings();
    return;
  }
  const workspace = selected();
  if (!workspace) {
    const {openWorkspace} = await import('./conversations.ts');
    openWorkspace();
    return;
  }
  rememberDraft();
  void drafts().flush(sourceScope).catch(() => {});
  let id = desk().state.activeId;
  if (!id) {
    draftHandoff = true;
    try {
      if (!await mutate('/api/conversations', {workspaceId: workspace.id}, response => { id = response.conversation.id; })) return;
      const carried = await drafts().transfer(sourceScope, {id});
      await draftReady;
      // A failed snapshot after the committed create leaves activeId stale; only
      // an explicit switch to another conversation invalidates this handoff.
      if (desk().state.activeId && desk().state.activeId !== id) {
        setError('The conversation changed before the message could be sent. Your draft is kept.');
        return;
      }
      scope = {id};
      // The submitted draft stays in the composer until the host accepts it.
      if (!desk().composer.text && carried.text) desk().setComposer({text: carried.text});
      rememberDraft();
    } catch (error) {
      setError(`Draft could not be moved: ${error instanceof Error ? error.message : String(error)}`);
      return;
    } finally {
      draftHandoff = false;
    }
  }
  const ok = await mutate('/api/send', {id, text, images}, () => {
    drafts().clearIfUnchanged(sourceScope, composer.text, submittedImages);
    if (sourceScope.id !== id) drafts().clearIfUnchanged({id}, composer.text, submittedImages);
    if (scope.id === id) {
      if (desk().composer.text === composer.text) desk().setComposer({text: ''});
      clearImages(submittedIds);
      rememberDraft();
    }
  });
  if (ok) {
    await drafts().flushAll();
    followLatest();
  }
}

async function queueMessage(text: string, draft: string, images: ImageInput[], submittedImages: Omit<DraftImage, 'url'>[]): Promise<void> {
  const id = desk().state.activeId;
  if (!id || desk().activity.busy) return;
  desk().setBusy(true);
  desk().setError('');
  try {
    // A queue POST is sent exactly once. A lost response must not duplicate work.
    await request('/api/queue', {id, text, images});
    // The submitted message must leave both the composer and its saved draft.
    drafts().clearIfUnchanged({id}, draft, submittedImages);
    drafts().clearIfUnchanged(scope, draft, submittedImages);
    if (desk().composer.text === draft) desk().setComposer({text: ''});
    clearImages(new Set(submittedImages.map(image => image.id)));
    rememberDraft();
    await drafts().flushAll();
    await app().refresh().catch(() => {
      setError('Message submitted. Waiting for the local service to update the pending list.');
    });
  } catch (error) {
    setError(`${error instanceof Error ? error.message : String(error)} The message was not resent. Check pending messages before trying again.`);
  } finally {
    desk().setBusy(false);
  }
}

export function followLatest(): void {
  window.dispatchEvent(new CustomEvent('pith:follow-latest'));
}

export async function stop(): Promise<void> {
  if (desk().state.running && !desk().activity.busy) await mutate('/api/abort', {id: desk().state.activeId});
}

export function startMessageEdit(messageId: string): void {
  const state = desk().state;
  const message = state.messages.find(entry => entry.id === messageId);
  if (!message || message.role !== 'user' || desk().activity.busy || state.running) return;
  submittingMessageEdit = state.messages.at(-1)?.id || '';
  desk().openModal({
    kind: 'editor', id: `edit-${messageId}`, slot: 'message', targetId: messageId, title: 'Edit message', submitLabel: 'Send again',
    value: message.text, note: 'Send again to replace this message and its following replies.' + (message.images?.length ? ` ${message.images.length} attached image${message.images.length === 1 ? '' : 's'} will be kept.` : ''),
    error: '', disabled: desk().activity.busy,
  });
}

export async function submitMessageEdit(modalValue: string, messageId: string, text: string): Promise<boolean> {
  const state = desk().state;
  const modal = desk().modals.find(entry => entry.id === modalValue);
  if (!modal || modal.kind !== 'editor') return false;
  const message = state.messages.find(entry => entry.id === messageId);
  const expected = modal.expectedLastMessageId || submittingMessageEdit;
  if (!message || message.role !== 'user' || modal.conversationId !== state.activeId || desk().activity.busy || state.running || expected !== (state.messages.at(-1)?.id || '') || (!text.trim() && !message.images?.length)) {
    desk().patchModal(modalValue, {error: 'The conversation changed. Reopen the message to send this edit. Your text is kept here so you can copy it.'});
    return false;
  }
  const ok = await mutate('/api/edit-message', {id: state.activeId, messageId, expectedLastMessageId: expected, text});
  if (ok) {
    desk().closeModal(modalValue);
    followLatest();
  } else desk().patchModal(modalValue, {error: desk().activity.error});
  return ok;
}

export function unsentEditorText(slot: 'message' | 'queue'): string {
  const modal = desk().modals.find(entry => entry.kind === 'editor' && entry.slot === slot);
  if (!modal || modal.kind !== 'editor') return '';
  const original = slot === 'queue'
    ? desk().state.queuedMessages.find(entry => entry.id === modal.targetId)?.text || ''
    : desk().state.messages.find(entry => entry.id === modal.targetId)?.text || '';
  const value = editorValues.get(modal.id) ?? modal.value;
  return value !== original ? value : '';
}

// The dialog keeps its unsaved text here so lifecycle saves can read it.
export const editorValues = new Map<string, string>();

export function preserveTexts(): void {
  rememberDraft();
  recoveryInstance?.keepText('Unassigned message', !scope.id && !scope.workspaceId ? desk().composer.text : '');
  recoveryInstance?.keepText('Message edit', unsentEditorText('message'));
  recoveryInstance?.keepText('Pending message edit', unsentEditorText('queue'));
}

export async function flushAllDrafts(options?: {keepalive?: boolean}): Promise<PromiseSettledResult<void>[]> {
  return drafts().flushAll(options);
}

export function queuedEntry(id: string): QueuedMessage | undefined {
  return desk().state.queuedMessages.find(entry => entry.id === id);
}

export function draftImages(): DraftImage[] {
  return desk().composer.images;
}

export function copyComposerText(): Promise<void> {
  return copyText(desk().composer.text);
}

export function isDraftLoading(): boolean {
  return desk().composer.loading;
}

export function disposeComposer(): void {
  drafts().suspend();
  loadGeneration++;
  imageGeneration++;
}

export {runtime};

