import type { ApiDownload, ApiRequest } from './api.ts';
import type { Artifact, Workspace, ResourceInventory as WorkspaceResources } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { imagePreviewBlob } from './image-viewer.ts';
import { createArtifactPanel, createFileActions, createFilePreview, createResourcesPanel, createCopyFeedback, createResourceActions, createButton } from 'pith-ui';
import type { createSDKUI } from './sdk-features.ts';
type API = {
    view: AppView;
    activity: UIActivity;
    request: ApiRequest;
    download: ApiDownload;
    render: () => void;
    selectedWorkspace: () => Workspace | undefined;
    openWorkspace: () => void;
    conversationRunning: (id: string | null) => boolean;
    showDialog: (id: string) => void;
    nativeClipboard: boolean;
    resourceActions: ReturnType<typeof createSDKUI>['resourceActions'];
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
export function createFilesUI(api: API) {
    const { view: app, activity, request, download, render, selectedWorkspace, openWorkspace, conversationRunning, showDialog, nativeClipboard } = api;
    let artifacts: Artifact[] = [];
    let artifactsError = '';
    let artifactsLoading = false;
    let artifactsRequest = 0;
    let artifactsSignature = '';
    let resources: WorkspaceResources | null = null;
    let resourcesWorkspaceId = '';
    let resourcesRequest = 0;
    let previewRequest = 0;
    let previewImageURL = '';
    const artifactsPanel = createArtifactPanel({ container: $('artifacts'), control: $('artifacts-control'), toggle: $('artifacts-toggle'), count: $('artifacts-count'), headingId: 'artifacts-title' });
    const resourcesPanel = createResourcesPanel({ container: $('resources-content'), titleId: 'resources-title', dialogId: 'resources-dialog', listId: 'resources-list', errorId: 'resources-error' });
    const previewPanel = createFilePreview({ container: $('preview-content'), titleId: 'preview-title', dialogId: 'preview-dialog', bodyId: 'file-preview-body' });
    const feedback = createCopyFeedback({
        status: $('copy-status'),
        isDisabled: (button) => !!button.dataset.idleConversation && (activity.busy || conversationRunning(button.dataset.idleConversation)),
        onError: (error) => { activity.error = error instanceof Error ? error.message : String(error); render(); },
    });
    function decorateFileActions(root: HTMLElement): void {
        for (const button of root.querySelectorAll<HTMLButtonElement>('[data-file-action], [data-preview-path]')) {
            button.dataset.idleAction = '';
            const ownerId = button.dataset.fileOwner || button.dataset.previewId || '';
            if (button.dataset.fileKind === 'resource') button.dataset.idleWorkspace = ownerId;
            else button.dataset.idleConversation = ownerId;
        }
    }
    function fileActions(kind: 'artifact' | 'resource', ownerId: string, path: string, includePreview = false): HTMLElement {
        const block = createFileActions({ kind, ownerId, path, preview: includePreview, copyMode: kind === 'artifact' ? nativeClipboard ? 'file' : 'path' : 'none' });
        decorateFileActions(block.element);
        return block.element;
    }
    function resourceCreate(kind: string, label: string): HTMLButtonElement {
        const button = createButton({ label }).element;
        button.classList.add('pui-secondary-button');
        Object.assign(button.dataset, { sdk: 'resource', resourceWorkspace: resourcesWorkspaceId, idleAction: '', idleWorkspace: resourcesWorkspaceId, kind });
        return button;
    }
    async function downloadConversationFile(id: string, path: string): Promise<void> {
        if (activity.busy || conversationRunning(id) || id !== app.state.activeId)
            return;
        activity.busy = true;
        activity.error = '';
        render();
        try {
            const result = await request('/api/conversation-file', { id, path });
            // Native cancellation is a completed native action; it must not download.
            if (result.native)
                return;
            const url = URL.createObjectURL(await download('/api/conversation-file', { id, path }));
            const link = document.createElement('a');
            link.href = url;
            link.download = result.name;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        catch (error) {
            activity.error = error instanceof Error ? error.message : String(error);
        }
        finally {
            activity.busy = false;
            render();
        }
    }
    async function copyText(text: string): Promise<void> {
        if (nativeClipboard)
            await request('/api/copy-text', { text });
        else
            await navigator.clipboard.writeText(text);
    }
    const copyWithFeedback = feedback.copy;
    const setArtifactsOpen = artifactsPanel.setOpen;
    function renderArtifacts(): void {
        const signature = JSON.stringify([app.state.activeId, artifacts, artifactsError, artifactsLoading]);
        if (signature === artifactsSignature) return;
        artifactsSignature = signature;
        artifactsPanel.update({ ownerId: app.state.activeId || '', files: artifacts, error: artifactsError, loading: artifactsLoading, copyMode: nativeClipboard ? 'file' : 'path' });
        decorateFileActions(artifactsPanel.element);
    }
    function clearFilePreview(): void {
        previewRequest++;
        if (previewImageURL)
            URL.revokeObjectURL(previewImageURL);
        previewImageURL = '';
        previewPanel.clear();
    }
    async function openArtifactPreview(id: string, path: string): Promise<void> {
        if (conversationRunning(id) || id !== app.state.activeId)
            return;
        clearFilePreview();
        const sequence = previewRequest;
        const dialog = $<HTMLDialogElement>('preview-dialog');
        previewPanel.open({ name: path.split('/').pop() || 'File preview', path, actions: fileActions('artifact', id, path) });
        showDialog('preview-dialog');
        try {
            const preview = await request('/api/artifact-preview', { query: { id, path } });
            if (sequence !== previewRequest || app.state.activeId !== id || !dialog.open)
                return;
            if (preview.kind === 'image' && preview.data && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(preview.mimeType || '')) {
                const blob = await imagePreviewBlob(preview.data, preview.mimeType!, () => sequence === previewRequest && app.state.activeId === id && dialog.open);
                if (!blob)
                    return;
                previewImageURL = URL.createObjectURL(blob);
                previewPanel.update({ kind: 'image', imageSrc: previewImageURL, imageAlt: path.split('/').pop(), truncated: preview.truncated });
            }
            else
                previewPanel.update({ kind: preview.kind === 'markdown' ? 'markdown' : 'text', text: preview.text || '', truncated: preview.truncated });
        }
        catch (error) {
            if (sequence === previewRequest && dialog.open)
                previewPanel.update({ kind: 'text', error: error instanceof Error ? error.message : String(error) });
        }
    }
    async function loadArtifacts(id: string): Promise<void> {
        const sequence = ++artifactsRequest;
        artifactsLoading = true;
        artifactsError = '';
        render();
        try {
            const result = await request('/api/artifacts', { query: { id } });
            if (sequence !== artifactsRequest || app.state.activeId !== id)
                return;
            artifacts = result || [];
        }
        catch (error) {
            if (sequence !== artifactsRequest || app.state.activeId !== id)
                return;
            artifactsError = error instanceof Error ? error.message : String(error);
        }
        finally {
            if (sequence === artifactsRequest) {
                artifactsLoading = false;
                render();
            }
        }
    }
    function openResources(): void {
        const workspace = selectedWorkspace();
        if (!workspace) {
            openWorkspace();
            return;
        }
        resourcesWorkspaceId = workspace.id;
        resources = null;
        const toolbar = document.createDocumentFragment();
        const refresh = createButton({ label: 'Refresh' }).element;
        refresh.classList.add('pui-secondary-button'); refresh.dataset.action = 'refresh-resources';
        toolbar.append(refresh, resourceCreate('skill', 'Add skill'), resourceCreate('template', 'Add prompt template'));
        resourcesPanel.open(workspace.name, toolbar);
        showDialog('resources-dialog');
        void loadResources();
    }
    async function loadResources(): Promise<void> {
        const id = resourcesWorkspaceId;
        if (!id)
            return;
        const sequence = ++resourcesRequest;
        resourcesPanel.setError('');
        try {
            const result = await request('/api/resources', { query: { workspaceId: id } });
            if (sequence !== resourcesRequest || id !== resourcesWorkspaceId)
                return;
            resources = result;
            renderResources();
        }
        catch (error) {
            if (sequence === resourcesRequest)
                resourcesPanel.setError(error instanceof Error ? error.message : String(error));
        }
    }
    function renderResources(): void {
        if (!resources)
            return;
        const workspace = app.state.workspaces.find((entry) => entry.id === resourcesWorkspaceId);
        const rootPath = `${workspace?.path.replace(/\\/g, '/').replace(/\/$/, '')}/AGENTS.md`;
        const hasInstructions = (resources.instructions || []).some((entry) => entry.path.replace(/\\/g, '/') === rootPath);
        const entry = (kind: string, item: { name: string; path: string; description?: string; content?: string }) => ({
            ...item,
            fileActions: kind === 'template' ? undefined : fileActions('resource', resourcesWorkspaceId, item.path),
            actions: createResourceActions({ kind, resource: item, workspaceId: resourcesWorkspaceId }).element,
        });
        resourcesPanel.update({
            instructions: (resources.instructions || []).map((item) => entry('instructions', item)),
            skills: (resources.skills || []).map((item) => entry('skill', item)),
            templates: (resources.templates || []).map((item) => entry('template', item)),
            diagnostics: resources.diagnostics || [],
            createInstructions: hasInstructions ? undefined : resourceCreate('instructions', 'Create AGENTS.md in this workspace'),
        });
        render();
    }
    return { downloadConversationFile, copyText, copyWithFeedback, setArtifactsOpen, renderArtifacts, clearFilePreview, openArtifactPreview, loadArtifacts, openResources, loadResources, get artifactsOpen() { return artifactsPanel.open; }, get resourcesWorkspaceId() { return resourcesWorkspaceId; }, activeChanged() { artifacts = []; artifactsError = ''; artifactsLoading = false; artifactsRequest++; setArtifactsOpen(false); $<HTMLDialogElement>('preview-dialog').close(); }, removeWorkspace(id: string) { if (resourcesWorkspaceId === id) {
            resources = null;
            resourcesWorkspaceId = '';
            resourcesRequest++;
            $<HTMLDialogElement>('resources-dialog').close();
        } }, closeResources() { resourcesRequest++; }, destroy() { artifactsRequest++; resourcesRequest++; clearFilePreview(); feedback.destroy(); artifactsPanel.destroy(); resourcesPanel.destroy(); previewPanel.destroy(); } };
}
