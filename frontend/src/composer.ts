import type { ApiMutate, ApiRequest } from './api.ts';
import type { DraftScope, ImageContent, QueuedMessage, DraftImage as WireDraftImage, Workspace } from './contract.generated.ts';
import { createDrafts, draftKey } from './drafts.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { imagePreviewBlob } from './image-viewer.ts';
import { createPendingMessages, createAttachments, createTextEditDialog } from 'pith-ui';
type ImageInput = ImageContent & {
    type: 'image';
};
interface DraftImage extends ImageInput {
    id: string;
    name: string;
    size: number;
    url: string;
}
type API = {
    view: AppView;
    activity: UIActivity;
    input: HTMLTextAreaElement;
    request: ApiRequest;
    mutate: ApiMutate;
    refresh: () => Promise<void>;
    render: () => void;
    selectedWorkspace: () => Workspace | undefined;
    openWorkspace: () => void;
    openSettings: () => void;
    showDialog: (id: string) => void;
    followLatest: () => void;
    disposed: () => boolean;
    resizeInput: () => void;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
export function createComposer(api: API) {
    const { view: app, activity, input, request, mutate, refresh, render, selectedWorkspace, openWorkspace, openSettings, showDialog } = api;
    let resolvingReferences = false;
    let queueSignature = '';
    let queueEditTarget: {
        conversationId: string;
        messageId: string;
    } | null = null;
    let draftImages: DraftImage[] = [];
    let readingImages = false;
    let draftGeneration = 0;
    let composerScope: DraftScope = {};
    let draftLoading = false;
    let composerDraftReady: Promise<void> = Promise.resolve();
    let draftLoadGeneration = 0;
    const pendingView = createPendingMessages({ container: $('queued-messages') });
    const attachmentsView = createAttachments({ container: $('draft-images') });
    const queueEditor = createTextEditDialog({
        dialog: $<HTMLDialogElement>('queue-edit-dialog'), title: 'Edit pending message', submitLabel: 'Save message',
        ids: { form: 'queue-edit-form', control: 'queue-edit-text', submit: 'queue-edit-save', error: 'queue-edit-error', title: 'queue-edit-title' },
        onInput: renderQueueEditor,
        onClose: () => { queueEditTarget = null; },
        onSubmit: async text => {
            const target = queueEditTarget;
            const entry = target && app.state.queuedMessages.find(entry => entry.id === target.messageId);
            if (!target || target.conversationId !== app.state.activeId || !entry || activity.busy || (!text.trim() && !entry.imageCount))
                return { ok: false, error: 'This message is no longer pending. Your draft is kept here so you can copy it.' };
            const ok = await mutate('/api/queue/edit', { id: target.conversationId, messageId: target.messageId, text }, () => { if (queueEditTarget === target) queueEditor.close(); });
            return ok ? { ok: true } : { ok: false, error: activity.error };
        },
    });
    queueEditor.control.rows = 5;
    const drafts = createDrafts(request, (message) => { if (!api.disposed()) {
        activity.error = message;
        render();
    } });
    function rememberDraft(): void {
        if (!draftLoading)
            drafts.update(composerScope, input.value, draftImages.map(({ url, ...image }) => image));
    }
    function loadComposerDraft(): void {
        const scope: DraftScope = app.state.activeId ? { id: app.state.activeId } : { workspaceId: selectedWorkspace()?.id || '' };
        if (draftKey(scope) === draftKey(composerScope))
            return;
        const oldScope = composerScope;
        const exists = oldScope.id ? app.state.conversations.some((entry) => entry.id === oldScope.id) : app.state.workspaces.some((entry) => entry.id === oldScope.workspaceId);
        if (exists) {
            rememberDraft();
            void drafts.flush(oldScope).catch(() => { });
        }
        clearDraftImages();
        composerScope = scope;
        const generation = ++draftLoadGeneration;
        input.value = '';
        draftLoading = !!draftKey(scope);
        input.readOnly = draftLoading;
        drafts.prune(app.state.conversations.map((entry) => entry.id), app.state.workspaces.map((entry) => entry.id));
        if (!draftLoading)
            return;
        composerDraftReady = drafts.load(scope).then(async (draft) => {
            if (api.disposed() || generation !== draftLoadGeneration)
                return;
            const images = await restoreDraftImages(draft.images || [], () => !api.disposed() && generation === draftLoadGeneration);
            if (api.disposed() || generation !== draftLoadGeneration) {
                images.forEach((image) => URL.revokeObjectURL(image.url));
                return;
            }
            input.value = draft.text;
            draftImages = images;
        }).catch((error) => {
            if (generation === draftLoadGeneration)
                activity.error = `Draft could not be restored: ${error instanceof Error ? error.message : String(error)}`;
        }).finally(() => {
            if (api.disposed() || generation !== draftLoadGeneration)
                return;
            draftLoading = false;
            input.readOnly = false;
            resizeComposer();
            render();
        });
    }
    function renderQueue(): void {
        renderQueueEditor();
        pendingView.update({ items: app.state.queuedMessages || [], running: app.state.running, busy: activity.busy });
    }
    function renderQueueEditor(): void {
        if (!queueEditTarget) return;
        const pending = queueEditTarget.conversationId === app.state.activeId && app.state.queuedMessages.some(entry => entry.id === queueEditTarget!.messageId);
        const entry = app.state.queuedMessages.find(entry => entry.id === queueEditTarget!.messageId);
        queueEditor.update({ title: 'Edit pending message', submitLabel: 'Save message',
            disabled: activity.busy || !pending || (!queueEditor.getValue().trim() && !entry?.imageCount), inputDisabled: activity.busy,
            note: entry?.imageCount ? entry.imageCount + ' attached image' + (entry.imageCount === 1 ? '' : 's') + ' will be kept.' : '',
            error: !pending ? 'This message is no longer pending. Your draft is kept here so you can copy it.' : '',
        });
    }
    function openQueueEditor(entry: QueuedMessage): void {
        if (activity.busy || !app.state.activeId) return;
        queueEditTarget = { conversationId: app.state.activeId, messageId: entry.id };
        queueEditor.open({ value: entry.text, title: 'Edit pending message' });
        renderQueueEditor();
        showDialog('queue-edit-dialog');
        queueEditor.focus();
    }
    async function send(): Promise<void> {
        const draft = input.value;
        const sourceScope = composerScope;
        const text = input.value.trim();
        const images = draftImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
        const submittedImages = draftImages.map(({ url, ...image }) => image);
        const submittedIds = new Set(submittedImages.map((image) => image.id));
        if ((!text && !images.length) || activity.busy || draftLoading || readingImages || resolvingReferences)
            return;
        if (images.length && !app.state.settings.supportsImages) {
            activity.error = 'Choose an image-capable model beside the message box, or remove the attachments.';
            render();
            return;
        }
        if (app.state.running) {
            await queueMessage(text, draft, images, submittedImages);
            return;
        }
        if (!app.state.settings.hasApiKey) {
            openSettings();
            return;
        }
        if (!selectedWorkspace()) {
            openWorkspace();
            return;
        }
        rememberDraft();
        void drafts.flush(sourceScope).catch(() => { });
        let id = app.state.activeId;
        if (!id) {
            if (!await mutate('/api/conversations', { workspaceId: selectedWorkspace()!.id }, (response) => { id = response.conversation.id; }))
                return;
            try {
                const carried = await drafts.transfer(sourceScope, { id });
                const remaining = await drafts.load(sourceScope);
                if (draftKey(composerScope) === draftKey(sourceScope) && !remaining.text && !remaining.images?.length) {
                    input.value = '';
                    clearDraftImages();
                }
                await composerDraftReady;
                if (composerScope.id === id && !input.value && !draftImages.length) {
                    input.value = carried.text;
                    draftImages = await restoreDraftImages(carried.images || [], () => composerScope.id === id);
                    rememberDraft();
                }
            }
            catch (error) {
                activity.error = `Draft could not be moved: ${error instanceof Error ? error.message : String(error)}`;
                render();
                return;
            }
        }
        if (await mutate('/api/send', { id, text, images }, () => {
            drafts.clearIfUnchanged(sourceScope, draft, submittedImages);
            if (sourceScope.id !== id)
                drafts.clearIfUnchanged({ id }, draft, submittedImages);
            if (composerScope.id === id) {
                if (input.value === draft)
                    input.value = '';
                clearDraftImages(submittedIds);
                rememberDraft();
            }
        })) {
            await drafts.flushAll();
            resizeComposer();
            render();
            api.followLatest();
        }
    }
    async function queueMessage(text: string, draft: string, images: ImageInput[], submittedImages: Omit<DraftImage, 'url'>[]): Promise<void> {
        const id = app.state.activeId;
        if (!id || activity.busy)
            return;
        activity.busy = true;
        activity.error = '';
        render();
        try {
            // A queue POST is sent exactly once. A lost response must not duplicate work.
            await request('/api/queue', { id, text, images });
            drafts.clearIfUnchanged({ id }, draft, submittedImages);
            if (composerScope.id === id) {
                if (input.value === draft)
                    input.value = '';
                clearDraftImages(new Set(submittedImages.map((image) => image.id)));
                rememberDraft();
            }
            await drafts.flushAll();
            resizeComposer();
            await refresh().catch(() => { activity.error = 'Message submitted. Waiting for the local service to update the pending list.'; });
        }
        catch (error) {
            activity.error = `${error instanceof Error ? error.message : String(error)} The message was not resent. Check pending messages before trying again.`;
        }
        finally {
            activity.busy = false;
            render();
        }
    }
    function renderDraftImages(): void {
        $('draft-images').hidden = !draftImages.length;
        attachmentsView.update({ items: draftImages, disabled: activity.busy || readingImages });
        $<HTMLButtonElement>('attach-images').disabled = activity.busy || readingImages || draftLoading || !app.loaded;
        const guidance = $('image-guidance');
        guidance.hidden = !draftImages.length;
        guidance.textContent = app.state.settings.supportsImages
            ? 'Images are saved with this conversation and sent to your configured model provider. Up to 50 MiB total per message.'
            : 'This model does not support images. Choose an image-capable model beside the message box, or remove the attachments.';
    }
    function clearDraftImages(ids?: Set<string>): void {
        if (!ids)
            draftGeneration++;
        draftImages = draftImages.filter((image) => {
            if (ids && !ids.has(image.id))
                return true;
            URL.revokeObjectURL(image.url);
            return false;
        });
    }
    async function restoreDraftImages(images: WireDraftImage[], active: () => boolean): Promise<DraftImage[]> {
        const restored: DraftImage[] = [];
        for (const image of images) {
            const blob = await imagePreviewBlob(image.data, image.mimeType, active);
            if (blob && active())
                restored.push({ ...image, type: 'image', url: URL.createObjectURL(blob) });
        }
        return restored;
    }
    async function addImageFiles(files: File[]): Promise<void> {
        if (!files.length || activity.busy || readingImages || draftLoading)
            return;
        readingImages = true;
        activity.error = '';
        render();
        const added: DraftImage[] = [];
        const generation = draftGeneration;
        try {
            const limit = app.state.settings.imageUploadLimit || 50 * 1024 * 1024;
            if (draftImages.reduce((sum, image) => sum + image.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > limit)
                throw new Error('Image attachments must total 50 MiB or less per message.');
            for (const file of files) {
                const mimeType = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() || ''];
                if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) || !file.size)
                    throw new Error('Use nonempty PNG, JPEG, GIF or WebP images.');
                const data = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
                    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
                    reader.readAsDataURL(file);
                });
                added.push({ id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(''), type: 'image', data, mimeType, name: file.name || 'Pasted image', size: file.size, url: URL.createObjectURL(file) });
            }
            if (api.disposed() || generation !== draftGeneration) {
                for (const image of added)
                    URL.revokeObjectURL(image.url);
                return;
            }
            draftImages.push(...added);
            rememberDraft();
        }
        catch (error) {
            for (const image of added)
                URL.revokeObjectURL(image.url);
            activity.error = error instanceof Error ? error.message : String(error);
        }
        finally {
            readingImages = false;
            render();
        }
    }
    function resizeComposer(): void { api.resizeInput(); }
    return { destroy() { queueEditor.destroy(); pendingView.destroy(); attachmentsView.destroy(); }, rememberDraft, loadComposerDraft, renderQueue, openQueueEditor, send, renderDraftImages, clearDraftImages, addImageFiles, resizeComposer, drafts, get draftImages() { return draftImages; }, get readingImages() { return readingImages; }, get draftLoading() { return draftLoading; }, get draftGeneration() { return draftGeneration; }, get composerScope() { return composerScope; }, get resolvingReferences() { return resolvingReferences; }, set resolvingReferences(value: boolean) { resolvingReferences = value; }, closeQueueEditor() { queueEditTarget = null; } };
}
