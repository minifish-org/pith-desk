import type { ApiDownload, ApiRequest } from './api.ts';
import type { Artifact, Workspace, ResourceInventory as WorkspaceResources } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { imagePreviewBlob } from './image-viewer.ts';
import { mountPagedPreview } from './paged-preview.ts';
import type { createSDKUI } from './sdk-features.ts';
import { dialogHeading, escape, icon } from './ui.ts';
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
    const sdkUI = { resourceActions: api.resourceActions };
    let artifacts: Artifact[] = [];
    let artifactsError = '';
    let artifactsLoading = false;
    let artifactsRequest = 0;
    let artifactsSignature = '';
    let artifactsOpen = false;
    let resources: WorkspaceResources | null = null;
    let resourcesWorkspaceId = '';
    let resourcesRequest = 0;
    let previewRequest = 0;
    let previewImageURL = '';
    function fileActions(kind: 'artifact' | 'resource', ownerId: string, path: string, includePreview = false): string {
        const preview = kind === 'artifact' && includePreview ? `<button type="button" class="secondary-button" data-preview-path="${escape(path)}" data-preview-id="${escape(ownerId)}" data-idle-action data-idle-conversation="${escape(ownerId)}">Preview</button>` : '';
        const copy = kind === 'artifact' ? `<button type="button" class="secondary-button" data-file-kind="artifact" data-file-owner="${escape(ownerId)}" data-file-path="${escape(path)}" data-file-action="${nativeClipboard ? 'copy' : 'copy-path'}" data-idle-action data-idle-conversation="${escape(ownerId)}">${nativeClipboard ? 'Copy file' : 'Copy path'}</button>` : '';
        return `<div class="file-actions">${preview}<button class="secondary-button" data-file-kind="${kind}" data-file-owner="${escape(ownerId)}" data-file-path="${escape(path)}" data-file-action="open" data-idle-action ${kind === 'resource' ? 'data-idle-workspace' : 'data-idle-conversation'}="${escape(ownerId)}">Open</button><button class="secondary-button" data-file-kind="${kind}" data-file-owner="${escape(ownerId)}" data-file-path="${escape(path)}" data-file-action="reveal" data-idle-action ${kind === 'resource' ? 'data-idle-workspace' : 'data-idle-conversation'}="${escape(ownerId)}">Reveal</button>${copy}</div>`;
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
    async function copyWithFeedback(button: HTMLButtonElement, action: () => Promise<void>, announcement: string): Promise<void> {
        const original = button.innerHTML;
        const label = button.getAttribute('aria-label');
        const title = button.title;
        $('copy-status').textContent = '';
        button.dataset.copyPending = 'true';
        button.disabled = true;
        try {
            await action();
            $('copy-status').textContent = announcement;
            if (!button.isConnected)
                return;
            button.innerHTML = button.classList.contains('message-action') ? icon('check') : 'Copied';
            button.setAttribute('aria-label', announcement);
            button.title = announcement;
            window.setTimeout(() => {
                if (!button.isConnected)
                    return;
                button.innerHTML = original;
                if (label === null)
                    button.removeAttribute('aria-label');
                else
                    button.setAttribute('aria-label', label);
                button.title = title;
                delete button.dataset.copyPending;
                button.disabled = !!button.dataset.idleConversation && (activity.busy || conversationRunning(button.dataset.idleConversation));
            }, 1500);
        }
        catch (error) {
            delete button.dataset.copyPending;
            button.disabled = false;
            activity.error = error instanceof Error ? error.message : String(error);
            render();
        }
    }
    function setArtifactsOpen(open: boolean, restoreFocus = false): void {
        artifactsOpen = open && !$('artifacts-control').hidden;
        $('artifacts').hidden = !artifactsOpen;
        $('artifacts-toggle').setAttribute('aria-expanded', String(artifactsOpen));
        if (artifactsOpen)
            $('artifacts').focus();
        else if (restoreFocus && !$('artifacts-control').hidden)
            $('artifacts-toggle').focus();
    }
    function renderArtifacts(): void {
        const region = $('artifacts');
        const signature = JSON.stringify([app.state.activeId, artifacts, artifactsError, artifactsLoading]);
        if (signature === artifactsSignature)
            return;
        artifactsSignature = signature;
        $('artifacts-control').hidden = !app.state.activeId || (!artifacts.length && !artifactsError);
        if ($('artifacts-control').hidden)
            setArtifactsOpen(false);
        const count = `${artifacts.length} ${artifacts.length === 1 ? 'file' : 'files'}`;
        const label = artifactsError ? 'Conversation files unavailable' : `Conversation files (${count})`;
        $('artifacts-toggle').setAttribute('aria-label', label);
        $('artifacts-toggle').title = label;
        $('artifacts-count').textContent = artifacts.length ? String(artifacts.length) : '!';
        region.innerHTML = `<div class="artifacts-heading"><h2 id="artifacts-title">Files <span>${count}</span></h2><button type="button" class="quiet-icon" data-artifacts-close aria-label="Close files">${icon('close')}</button></div>${artifactsLoading ? '<p class="artifacts-status" role="status">Looking for files…</p>' : ''}<div class="artifacts-content">${artifacts.map((file) => `<article class="file-card">${icon('file')}<div class="file-info"><strong>${escape(file.name)}</strong><span class="file-path">${escape(file.path)}</span></div>${fileActions('artifact', app.state.activeId || '', file.path, true)}</article>`).join('')}${artifactsError ? `<p class="form-error" role="alert">${escape(artifactsError)}</p>` : ''}</div>`;
    }
    function clearFilePreview(): void {
        previewRequest++;
        if (previewImageURL)
            URL.revokeObjectURL(previewImageURL);
        previewImageURL = '';
        $('preview-content').replaceChildren();
    }
    async function openArtifactPreview(id: string, path: string): Promise<void> {
        if (conversationRunning(id) || id !== app.state.activeId)
            return;
        clearFilePreview();
        const sequence = previewRequest;
        const dialog = $<HTMLDialogElement>('preview-dialog');
        const heading = dialogHeading(path.split('/').pop() || 'File preview', 'preview-title', 'preview-dialog', 'File preview');
        $('preview-content').innerHTML = `${heading}<p class="file-preview-path">${escape(path)}</p><div id="file-preview-body" class="file-preview-body" aria-live="polite">Loading preview…</div><div class="file-preview-actions">${fileActions('artifact', id, path)}</div>`;
        showDialog('preview-dialog');
        try {
            const preview = await request('/api/artifact-preview', { query: { id, path } });
            if (sequence !== previewRequest || app.state.activeId !== id || !dialog.open)
                return;
            const body = $('file-preview-body');
            if (preview.kind === 'image' && preview.data && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(preview.mimeType || '')) {
                const blob = await imagePreviewBlob(preview.data, preview.mimeType!, () => sequence === previewRequest && app.state.activeId === id && dialog.open);
                if (!blob)
                    return;
                previewImageURL = URL.createObjectURL(blob);
                body.innerHTML = `<img class="file-preview-image" src="${escape(previewImageURL)}" alt="${escape(path.split('/').pop())}" role="button" tabindex="0" title="Click to enlarge" />`;
            }
            else
                mountPagedPreview(body, preview.text || '', preview.kind === 'markdown' ? 'markdown' : 'text');
            if (preview.truncated)
                body.insertAdjacentHTML('beforeend', '<p class="preview-note">Showing the first 8 MiB. Use Open for the complete file.</p>');
        }
        catch (error) {
            if (sequence === previewRequest && dialog.open)
                $('file-preview-body').textContent = error instanceof Error ? error.message : String(error);
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
        $('resources-content').innerHTML = `${dialogHeading('Workspace resources', 'resources-title', 'resources-dialog', workspace.name)}<p class="modal-description">Instructions, skills and prompt templates are loaded by Pith for each task. Edit them here or open their Markdown files.</p><div class="feature-toolbar"><button class="secondary-button" data-action="refresh-resources">Refresh</button><button class="secondary-button" data-sdk="resource" data-resource-workspace="${escape(resourcesWorkspaceId)}" data-idle-action data-idle-workspace="${escape(resourcesWorkspaceId)}" data-kind="skill">Add skill</button><button class="secondary-button" data-sdk="resource" data-resource-workspace="${escape(resourcesWorkspaceId)}" data-idle-action data-idle-workspace="${escape(resourcesWorkspaceId)}" data-kind="template">Add prompt template</button></div><div id="resources-list"><p class="feature-hint">Loading workspace resources…</p></div><div id="resources-error" class="form-error" role="alert"></div>`;
        showDialog('resources-dialog');
        void loadResources();
    }
    async function loadResources(): Promise<void> {
        const id = resourcesWorkspaceId;
        if (!id)
            return;
        const sequence = ++resourcesRequest;
        $('resources-error').textContent = '';
        try {
            const result = await request('/api/resources', { query: { workspaceId: id } });
            if (sequence !== resourcesRequest || id !== resourcesWorkspaceId)
                return;
            resources = result;
            renderResources();
        }
        catch (error) {
            if (sequence === resourcesRequest)
                $('resources-error').textContent = error instanceof Error ? error.message : String(error);
        }
    }
    function renderResources(): void {
        if (!resources)
            return;
        const workspace = app.state.workspaces.find((entry) => entry.id === resourcesWorkspaceId);
        const rootPath = `${workspace?.path.replace(/\\/g, '/').replace(/\/$/, '')}/AGENTS.md`;
        const hasInstructions = (resources.instructions || []).some((entry) => entry.path.replace(/\\/g, '/') === rootPath);
        $('resources-list').innerHTML = `<section class="resource-section"><h3>Instructions</h3>${(resources.instructions || []).map((entry) => `<article class="resource-card"><div class="file-card">${icon('file')}<div class="file-info"><strong>${escape(entry.name)}</strong><span class="file-path">${escape(entry.path)}</span></div>${fileActions('resource', resourcesWorkspaceId, entry.path)}${sdkUI.resourceActions('instructions', entry, resourcesWorkspaceId)}</div><details class="resource-preview"><summary>View instructions</summary><pre>${escape(entry.content)}</pre></details></article>`).join('') || '<p class="feature-hint">No workspace instructions found.</p>'}${!hasInstructions ? `<button class="secondary-button" data-sdk="resource" data-resource-workspace="${escape(resourcesWorkspaceId)}" data-kind="instructions" data-idle-action data-idle-workspace="${escape(resourcesWorkspaceId)}">Create AGENTS.md in this workspace</button>` : ''}</section><section class="resource-section"><h3>Skills</h3>${(resources.skills || []).map((entry) => `<article class="file-card">${icon('file')}<div class="file-info"><strong>${escape(entry.name)}</strong><p>${escape(entry.description)}</p><span class="file-path">${escape(entry.path)}</span></div>${fileActions('resource', resourcesWorkspaceId, entry.path)}${sdkUI.resourceActions('skill', entry, resourcesWorkspaceId)}</article>`).join('') || '<p class="feature-hint">No skills found. Add .pi/skills/&lt;skill-name&gt;/SKILL.md in this workspace, then refresh.</p>'}</section><section class="resource-section"><h3>Prompt templates</h3>${(resources.templates || []).map((entry) => `<article class="file-card"><div class="file-info"><strong>${escape(entry.name)}</strong><p>${escape(entry.description)}</p><span class="file-path">${escape(entry.path)}</span></div>${sdkUI.resourceActions('template', entry, resourcesWorkspaceId)}</article>`).join('') || '<p class="feature-hint">No prompt templates yet.</p>'}</section>${(resources.diagnostics || []).length ? `<section class="resource-section resource-diagnostics"><h3>Resource notes</h3>${(resources.diagnostics || []).map((entry) => `<p>${escape(entry)}</p>`).join('')}</section>` : ''}`;
        render();
    }
    return { downloadConversationFile, copyText, copyWithFeedback, setArtifactsOpen, renderArtifacts, clearFilePreview, openArtifactPreview, loadArtifacts, openResources, loadResources, get artifactsOpen() { return artifactsOpen; }, get resourcesWorkspaceId() { return resourcesWorkspaceId; }, activeChanged() { artifacts = []; artifactsError = ''; artifactsLoading = false; artifactsRequest++; setArtifactsOpen(false); $<HTMLDialogElement>('preview-dialog').close(); }, removeWorkspace(id: string) { if (resourcesWorkspaceId === id) {
            resources = null;
            resourcesWorkspaceId = '';
            resourcesRequest++;
            $<HTMLDialogElement>('resources-dialog').close();
        } }, closeResources() { resourcesRequest++; } };
}
