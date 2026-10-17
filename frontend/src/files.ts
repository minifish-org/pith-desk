import type {ApiDownload, ApiMutate, ApiRequest} from './api.ts';
import type {Artifact, Workspace, ResourceInventory as WorkspaceResources} from './contract.generated.ts';
import type {AppView, UIActivity} from './feature-api.ts';
import {imagePreviewBlob} from './image-data.ts';
import type {Application, AppFileAction, AppFileTarget, AppFilePreviewState, AppResourceKind, AppResourceTarget, FilePreviewSession, ResourcesSession, ResourcesState} from './ui-contract.ts';

type API = {
    ui: Application;
    view: AppView;
    activity: UIActivity;
    request: ApiRequest;
    mutate: ApiMutate;
    download: ApiDownload;
    render: () => void;
    draft: (prefix: string) => void;
    selectedWorkspace: () => Workspace | undefined;
    openWorkspace: () => void;
    conversationRunning: (id: string | null) => boolean;
    workspaceBusy: (id: string) => boolean;
    nativeClipboard: boolean;
    editResource: (workspaceId: string, kind: AppResourceKind, path?: string) => Promise<void>;
};

export function createFilesUI(api: API) {
    const {ui, view: app, activity, request, mutate, download, render, selectedWorkspace, openWorkspace, conversationRunning, nativeClipboard} = api;
    let destroyed = false;
    let artifacts: Artifact[] = [];
    let artifactsError = '';
    let artifactsLoading = false;
    let artifactsRequest = 0;
    let artifactsSignature = '';
    let resources: WorkspaceResources | null = null;
    let resourcesWorkspaceId = '';
    let resourcesRequest = 0;
    let resourcesError = '';
    let resourceSession: ResourcesSession | undefined;
    let previewRequest = 0;
    let previewImageURL = '';
    let previewSession: FilePreviewSession | undefined;
    let previewContent: AppFilePreviewState | undefined;
    let previewOwnerId = '';
    const message = (error: unknown) => error instanceof Error ? error.message : String(error);

    async function downloadConversationFile(id: string, path: string): Promise<void> {
        if (activity.busy || conversationRunning(id) || id !== app.state.activeId) return;
        activity.busy = true;
        activity.error = '';
        render();
        try {
            const result = await request('/api/conversation-file', {id, path});
            // Native cancellation is a completed native action; it must not download.
            if (result.native) return;
            const saved = await ui.downloadFile({blob: await download('/api/conversation-file', {id, path}), name: result.name});
            if (!saved.ok) throw new Error(saved.error);
        } catch (error) {activity.error = message(error);}
        finally {activity.busy = false; render();}
    }
    async function copyText(text: string): Promise<void> {
        if (nativeClipboard) await request('/api/copy-text', {text});
        else await navigator.clipboard.writeText(text);
    }
    async function artifactAction(action: AppFileAction, target: AppFileTarget): Promise<void> {
        const id = target.owner.id;
        if (activity.busy || conversationRunning(id) || id !== app.state.activeId) return;
        const payload = {kind: 'artifact', id, path: target.path, action};
        if (action === 'copy' || action === 'copy-path') {
            try {
                if (action === 'copy') await request('/api/file', payload);
                else await copyText(target.path);
            } catch (error) {activity.error = message(error); render(); throw error;}
        } else if (!await mutate('/api/file', payload)) throw new Error(activity.error);
    }
    async function resourceFileAction(action: 'open' | 'reveal', target: AppResourceTarget): Promise<void> {
        if (activity.busy || api.workspaceBusy(target.workspaceId) || target.workspaceId !== resourcesWorkspaceId) return;
        if (!await mutate('/api/file', {kind: 'resource', workspaceId: target.workspaceId, path: target.path, action})) {
            setResourceError(activity.error);
            throw new Error(activity.error);
        }
    }
    function resourceState(): ResourcesState | undefined {
        const workspace = app.state.workspaces.find(entry => entry.id === resourcesWorkspaceId);
        if (!workspace) return;
        const rootPath = `${workspace.path.replace(/\\/g, '/').replace(/\/$/, '')}/AGENTS.md`;
        const hasInstructions = (resources?.instructions || []).some(entry => entry.path.replace(/\\/g, '/') === rootPath);
        return {
            workspace, instructions: resources?.instructions || [], skills: resources?.skills || [], templates: resources?.templates || [],
            diagnostics: resources?.diagnostics || [], canCreateInstructions: !hasInstructions, loading: !resources, error: resourcesError,
            busy: activity.busy || api.workspaceBusy(resourcesWorkspaceId),
        };
    }
    function renderResourceAvailability(): void {
        const state = resourceState();
        if (state && resourceSession?.isOpen()) resourceSession.update(state);
    }
    function renderArtifacts(): void {
        const disabled = activity.busy || conversationRunning(app.state.activeId);
        const signature = JSON.stringify([app.state.activeId, artifacts, artifactsError, artifactsLoading, disabled]);
        if (signature !== artifactsSignature) {
            artifactsSignature = signature;
            ui.files.updateArtifacts({ownerId: app.state.activeId || '', files: artifacts, error: artifactsError, loading: artifactsLoading, copyMode: nativeClipboard ? 'file' : 'path', disabled}, {
                onPreview: target => openArtifactPreview(target.owner.id, target.path), onFileAction: artifactAction,
            });
        }
        if (previewContent && previewSession?.isOpen()) previewSession.update({...previewContent, disabled: activity.busy || conversationRunning(previewOwnerId)});
    }
    function clearFilePreview(): void {
        previewRequest++;
        const previous = previewSession;
        previewSession = undefined;
        previewContent = undefined;
        previewOwnerId = '';
        previous?.close();
        if (previewImageURL) URL.revokeObjectURL(previewImageURL);
        previewImageURL = '';
    }
    async function openArtifactPreview(id: string, path: string): Promise<void> {
        if (conversationRunning(id) || id !== app.state.activeId) return;
        clearFilePreview();
        const sequence = previewRequest;
        const session = ui.files.openPreview({owner: {kind: 'artifact', id}, name: path.split('/').pop() || 'File preview', path, capabilities: {open: true, reveal: true, copyMode: nativeClipboard ? 'file' : 'path'}}, {
            onFileAction: artifactAction,
            onClose() {if (previewSession === session) clearFilePreview();},
        });
        previewSession = session; previewOwnerId = id;
        const current = () => !destroyed && sequence === previewRequest && app.state.activeId === id && previewSession === session && session.isOpen();
        const update = (content: AppFilePreviewState) => {if (current()) {previewContent = content; session.update({...content, disabled: activity.busy || conversationRunning(id)});}};
        try {
            const preview = await request('/api/artifact-preview', {query: {id, path}});
            if (!current()) return;
            if (preview.kind === 'image' && preview.data && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(preview.mimeType || '')) {
                const blob = await imagePreviewBlob(preview.data, preview.mimeType!, current);
                if (!blob || !current()) return;
                previewImageURL = URL.createObjectURL(blob);
                update({kind: 'image', imageSrc: previewImageURL, imageAlt: path.split('/').pop(), truncated: preview.truncated});
            } else update({kind: preview.kind === 'markdown' ? 'markdown' : 'text', text: preview.text || '', truncated: preview.truncated});
        } catch (error) {if (current()) update({kind: 'text', error: message(error)});}
    }
    async function loadArtifacts(id: string): Promise<void> {
        const sequence = ++artifactsRequest;
        artifactsLoading = true; artifactsError = ''; render();
        try {
            const result = await request('/api/artifacts', {query: {id}});
            if (destroyed || sequence !== artifactsRequest || app.state.activeId !== id) return;
            artifacts = result || [];
        } catch (error) {
            if (destroyed || sequence !== artifactsRequest || app.state.activeId !== id) return;
            artifactsError = message(error);
        } finally {
            if (!destroyed && sequence === artifactsRequest) {artifactsLoading = false; render();}
        }
    }
    async function editResource(kind: AppResourceKind, path?: string): Promise<void> {
        const id = resourcesWorkspaceId, sequence = resourcesRequest, session = resourceSession;
        try {await api.editResource(id, kind, path);}
        catch (error) {
            if (sequence !== resourcesRequest || id !== resourcesWorkspaceId || session !== resourceSession || !session?.isOpen()) return;
            activity.error = message(error); setResourceError(activity.error);
        }
    }
    function openResources(): void {
        const workspace = selectedWorkspace();
        if (!workspace) {openWorkspace(); return;}
        resourceSession?.close(); resourcesWorkspaceId = workspace.id; resources = null; resourcesError = '';
        const state = resourceState(); if (!state) return;
        const session = ui.resources.open(state, {
            onRefresh: loadResources,
            onCreate: async kind => {
                const id = workspace.id;
                const current = () => !destroyed && resourceSession === session && session.isOpen() && resourcesWorkspaceId === id;
                if (!current() || activity.busy || api.workspaceBusy(id)) return;
                if (kind !== 'instructions') {await editResource(kind); return;}
                const saved = await mutate('/api/create-instructions', {workspaceId: id});
                if (!current()) return;
                if (saved) await loadResources();
                else setResourceError(activity.error);
            },
            onEdit: target => editResource(target.kind, target.path),
            onUse(target) {
                api.draft(target.kind === 'skill' ? `/skill:${target.name} ` : `/${target.name} `);
                session.close(); ui.workspace.focusComposer();
            },
            onFileAction: resourceFileAction,
            onClose() {if (resourceSession === session) {resourcesRequest++; resourceSession = undefined;}},
        });
        resourceSession = session; void loadResources();
    }
    async function loadResources(): Promise<void> {
        const id = resourcesWorkspaceId, session = resourceSession;
        if (!id || !session?.isOpen()) return;
        const sequence = ++resourcesRequest;
        resourcesError = ''; renderResourceAvailability();
        const current = () => !destroyed && sequence === resourcesRequest && id === resourcesWorkspaceId && session === resourceSession && session.isOpen();
        try {
            const result = await request('/api/resources', {query: {workspaceId: id}});
            if (!current()) return;
            resources = result; renderResourceAvailability(); render();
        } catch (error) {if (current()) setResourceError(message(error));}
    }
    function setResourceError(error: string): void {resourcesError = error; resourceSession?.fail(error);}
    function closeResources(): void {resourcesRequest++; const previous = resourceSession; resourceSession = undefined; previous?.close();}
    return {
        downloadConversationFile, copyText, closeArtifacts: () => ui.files.closeArtifacts(), renderArtifacts, renderResourceAvailability, clearFilePreview,
        openArtifactPreview, loadArtifacts, openResources, loadResources, setResourceError,
        get artifactsOpen() {return ui.files.areArtifactsOpen();}, get resourcesWorkspaceId() {return resourcesWorkspaceId;},
        activeChanged() {artifacts = []; artifactsError = ''; artifactsLoading = false; artifactsRequest++; ui.files.closeArtifacts(); clearFilePreview();},
        removeWorkspace(id: string) {if (resourcesWorkspaceId === id) {resources = null; resourcesWorkspaceId = ''; closeResources();}},
        closeResources,
        destroy() {if (destroyed) return; destroyed = true; artifactsRequest++; closeResources(); clearFilePreview(); ui.files.closeArtifacts();},
    };
}
