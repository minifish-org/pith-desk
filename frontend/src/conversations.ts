import type { ApiDownload, ApiMutate, ApiRequest } from './api.ts';
import type { Confirmation } from './confirmation.ts';
import type { Conversation, RunSummary, Workspace } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { dialogHeading, escape, icon } from './ui.ts';
type API = {
    view: AppView;
    activity: UIActivity;
    input: HTMLTextAreaElement;
    request: ApiRequest;
    download: ApiDownload;
    mutate: ApiMutate;
    render: () => void;
    closeSidebar: () => void;
    showDialog: (id: string) => void;
    workspaceRun: (id?: string) => RunSummary | undefined;
    conversationRunning: (id: string | null) => boolean;
    historyStatus: (entry: Conversation) => string;
    confirmRemoval: (options: Confirmation) => void;
    removeWorkspaceResources: (id: string) => void;
    clearHistoryImages: () => void;
    loadComposerDraft: () => void;
    resizeComposer: () => void;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
export function createConversationsUI(api: API) {
    const { view: app, activity, input, request, download, mutate, render, closeSidebar, showDialog, workspaceRun, conversationRunning, historyStatus, confirmRemoval, clearHistoryImages, loadComposerDraft, resizeComposer } = api;
    let selectedWorkspaceId = '';
    let historySearch = '';
    const expandedWorkspaces = new Set<string>();
    let historySignature = '';
    let historyFilterSignature = '';
    let historyActiveId: string | null | undefined;
    let menuConversationId: string | null = null;
    let menuWorkspaceId: string | null = null;
    function selectedWorkspace(): Workspace | undefined {
        const conversation = app.state.conversations.find((entry) => entry.id === app.state.activeId);
        return app.state.workspaces.find((entry) => entry.id === (conversation?.workspaceId || selectedWorkspaceId)) ?? app.state.workspaces[0];
    }
    function renderHistory(): void {
        if (historyActiveId !== app.state.activeId) {
            const active = app.state.conversations.find((entry) => entry.id === app.state.activeId);
            if (active)
                expandedWorkspaces.add(active.workspaceId);
            historyActiveId = app.state.activeId;
        }
        const search = historySearch.trim().toLocaleLowerCase();
        const conversations = app.state.conversations.filter((entry) => (entry.title || 'Untitled conversation').toLocaleLowerCase().includes(search)).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const filterSignature = search;
        if (filterSignature !== historyFilterSignature) {
            if (search)
                for (const entry of conversations)
                    expandedWorkspaces.add(entry.workspaceId);
            historyFilterSignature = filterSignature;
        }
        const signature = JSON.stringify([app.state.workspaces, app.state.conversations, app.state.activeId, selectedWorkspace()?.id, historySearch, [...expandedWorkspaces], app.state.runs, activity.busy]);
        if (signature === historySignature)
            return;
        historySignature = signature;
        const disabled = activity.busy ? 'disabled' : '';
        $('history-list').innerHTML = app.state.workspaces.map((workspace) => {
            const children = conversations.filter((entry) => entry.workspaceId === workspace.id);
            if (search && !children.length)
                return '';
            const expanded = expandedWorkspaces.has(workspace.id);
            const selected = workspace.id === selectedWorkspace()?.id;
            return `<section class="workspace-group" aria-label="${escape(workspace.name)}"><div class="workspace-heading ${selected ? 'selected' : ''}"><button class="workspace-toggle" data-toggle-workspace="${escape(workspace.id)}" aria-expanded="${expanded}" aria-controls="workspace-children-${escape(workspace.id)}" title="${escape(workspace.path)}">${icon('chevron', 'workspace-chevron')}${icon('folder')}<span>${escape(workspace.name)}</span></button><button id="workspace-actions-${escape(workspace.id)}" class="quiet-icon workspace-more" data-workspace-menu="${escape(workspace.id)}" aria-label="Actions for workspace ${escape(workspace.name)}" aria-haspopup="menu" aria-expanded="${workspace.id === menuWorkspaceId}" ${disabled}>${icon('more')}</button><button class="quiet-icon workspace-new" data-new-workspace="${escape(workspace.id)}" aria-label="New conversation in ${escape(workspace.name)}" title="New conversation" ${disabled}>${icon('compose')}</button></div><div class="workspace-children" id="workspace-children-${escape(workspace.id)}" ${expanded ? '' : 'hidden'}>${children.map((entry) => `<div class="history-row ${entry.id === app.state.activeId ? 'active' : ''}"><button class="history-item" data-conversation="${escape(entry.id)}" ${entry.id === app.state.activeId ? 'aria-current="page"' : ''} title="${escape(entry.title || 'Untitled conversation')}" ${disabled}><span>${escape(entry.title || 'Untitled conversation')}</span>${historyStatus(entry)}</button><button id="conversation-actions-${escape(entry.id)}" class="quiet-icon history-more" data-conversation-menu="${escape(entry.id)}" aria-label="Actions for ${escape(entry.title || 'Untitled conversation')}" aria-haspopup="menu" aria-expanded="${entry.id === menuConversationId}" ${disabled}>${icon('more')}</button></div>`).join('') || `<p class="workspace-empty">No conversations yet</p>`}</div></section>`;
        }).join('') + (!app.state.workspaces.length ? `<button class="workspace-item empty-workspace" data-action="workspace">${icon('folder')}<span>Add a workspace</span></button>` : search && !conversations.length ? '<p class="history-empty">No matching conversations.</p>' : '');
    }
    function closeConversationMenu(restoreFocus = false): void {
        const triggerID = menuConversationId ? `conversation-actions-${menuConversationId}` : menuWorkspaceId ? `workspace-actions-${menuWorkspaceId}` : '';
        menuConversationId = null;
        menuWorkspaceId = null;
        $('conversation-menu').hidden = true;
        if (triggerID) {
            const trigger = document.getElementById(triggerID);
            trigger?.setAttribute('aria-expanded', 'false');
            if (restoreFocus)
                trigger?.focus();
        }
    }
    function openConversationMenu(id: string, trigger: HTMLElement): void {
        if (activity.busy)
            return;
        const conversation = app.state.conversations.find((entry) => entry.id === id);
        if (!conversation)
            return;
        const alreadyOpen = menuConversationId === id;
        closeConversationMenu();
        if (alreadyOpen)
            return;
        menuConversationId = id;
        trigger.setAttribute('aria-expanded', 'true');
        const menu = $('conversation-menu');
        menu.setAttribute('aria-label', 'Conversation actions');
        const idleAction = `data-idle-action data-idle-conversation="${escape(id)}" ${conversationRunning(id) ? 'disabled' : ''}`;
        menu.innerHTML = `<button role="menuitem" data-action="rename" ${idleAction}>Rename</button>${id === app.state.activeId && !conversationRunning(id) ? '<button role="menuitem" data-sdk="history" data-action="close-conversation-menu">Conversation branches</button>' : ''}<button role="menuitem" data-action="export" ${idleAction}>Export Markdown</button><button role="menuitem" class="destructive-menu-item" data-action="delete-conversation" ${idleAction}>Delete conversation</button>`;
        positionContextMenu(trigger);
    }
    function openWorkspaceMenu(id: string, trigger: HTMLElement): void {
        if (activity.busy || !app.state.workspaces.some((entry) => entry.id === id))
            return;
        const alreadyOpen = menuWorkspaceId === id;
        closeConversationMenu();
        if (alreadyOpen)
            return;
        menuWorkspaceId = id;
        trigger.setAttribute('aria-expanded', 'true');
        const menu = $('conversation-menu');
        menu.setAttribute('aria-label', 'Workspace actions');
        menu.innerHTML = `<button role="menuitem" class="destructive-menu-item" data-action="remove-workspace" data-idle-action data-idle-workspace="${escape(id)}" ${workspaceRun(id) ? 'disabled' : ''}>Remove workspace</button>`;
        positionContextMenu(trigger);
    }
    function positionContextMenu(trigger: HTMLElement): void {
        const menu = $('conversation-menu');
        menu.hidden = false;
        const rect = trigger.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
        menu.querySelector<HTMLButtonElement>('button')?.focus();
    }
    function openDeletion(kind: 'conversation' | 'workspace', id: string): void {
        const busy = () => kind === 'workspace' ? !!workspaceRun(id) : conversationRunning(id);
        if (busy() || activity.busy)
            return;
        const item = kind === 'workspace' ? app.state.workspaces.find((entry) => entry.id === id) : app.state.conversations.find((entry) => entry.id === id);
        if (!item)
            return;
        const count = app.state.conversations.filter((entry) => entry.workspaceId === id).length;
        const name = 'name' in item ? item.name : item.title || 'Untitled conversation';
        const action = kind === 'workspace' ? 'Remove workspace' : 'Delete conversation';
        const description = kind === 'workspace'
            ? `Remove <strong>${escape(name)}</strong> from Pith Desk and permanently delete its <strong>${count} ${count === 1 ? 'conversation' : 'conversations'}</strong>, including history, image attachments and run records?`
            : `Permanently delete <strong>${escape(name)}</strong>, including its history, image attachments and run records?`;
        confirmRemoval({ title: `${action}?`, action, description,
            hint: 'The folder and its files stay on your computer, including files created by Pith. Deleted conversation data cannot be recovered from Pith Desk.',
            scope: kind === 'workspace' ? { workspaceId: id } : { conversationId: id },
            unavailable: () => busy() || activity.busy, error: () => activity.error,
            run: async () => {
                const activeWorkspace = selectedWorkspace()?.id;
                const activeID = app.state.activeId;
                const ok = await mutate(kind === 'workspace' ? '/api/remove-workspace' : '/api/delete-conversation', { id, ...(kind === 'workspace' ? { conversationCount: count } : {}) });
                if (!ok)
                    return false;
                if (kind === 'workspace') {
                    expandedWorkspaces.delete(id);
                    if (selectedWorkspaceId === id)
                        selectedWorkspaceId = '';
                    api.removeWorkspaceResources(id);
                }
                if (activeID !== app.state.activeId || activeWorkspace !== selectedWorkspace()?.id) {
                    clearHistoryImages();
                    loadComposerDraft();
                    resizeComposer();
                }
                render();
                return true;
            } });
    }
    async function newConversation(workspaceId = selectedWorkspace()?.id): Promise<void> {
        if (!workspaceId) {
            openWorkspace();
            return;
        }
        if (await mutate('/api/conversations', { workspaceId })) {
            expandedWorkspaces.add(workspaceId);
            renderHistory();
            resizeComposer();
            closeSidebar();
            input.focus();
        }
    }
    function openRename(id = app.state.activeId): void {
        const conversation = app.state.conversations.find((entry) => entry.id === id);
        if (!conversation || conversationRunning(id))
            return;
        $('rename-content').innerHTML = `${dialogHeading('Rename conversation', 'rename-title', 'rename-dialog', 'CONVERSATION')}<form id="rename-form"><label class="field-label" for="conversation-title">Title</label><input id="conversation-title" name="title" value="${escape(conversation.title || '')}" required autocomplete="off" /><div id="rename-error" class="form-error" role="alert"></div><div class="modal-footer"><button type="button" class="secondary-button" data-close="rename-dialog">Cancel</button><button type="submit" class="primary-button" data-idle-action data-idle-conversation="${escape(id)}">Save title</button></div></form>`;
        showDialog('rename-dialog');
        $<HTMLInputElement>('conversation-title').select();
        $('rename-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const title = $<HTMLInputElement>('conversation-title').value.trim();
            if (!title || conversationRunning(id) || activity.busy)
                return;
            if (await mutate('/api/rename', { id, title }))
                $<HTMLDialogElement>('rename-dialog').close();
            else
                $('rename-error').textContent = activity.error;
        });
    }
    async function exportConversation(id = app.state.activeId): Promise<void> {
        const conversation = app.state.conversations.find((entry) => entry.id === id);
        if (!conversation || activity.busy || conversationRunning(id))
            return;
        activity.busy = true;
        activity.error = '';
        render();
        try {
            const delivery = await request('/api/export', { id: conversation.id });
            // A native save (including cancellation) fully handles this export.
            // Only an explicit browser-preview response permits the Blob download.
            if (delivery?.native === true)
                return;
            if (delivery?.native !== false)
                throw new Error('The local service returned an invalid export response.');
            const url = URL.createObjectURL(await download('/api/export', { id: conversation.id }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `${(conversation.title || 'Conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Conversation'}.md`;
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
    function openWorkspace(): void {
        closeSidebar();
        $('workspace-content').innerHTML = `${dialogHeading('Workspaces', 'workspace-title', 'workspace-dialog', 'A PLACE TO WORK')}<p class="modal-description">Choose a local folder. Conversations belong to a workspace, so Pith knows where to read and create files.</p><div class="modal-workspaces">${app.state.workspaces.map((entry) => `<button class="modal-workspace" data-modal-workspace="${escape(entry.id)}">${icon('folder')}<span><strong>${escape(entry.name)}</strong><small>${escape(entry.path)}</small></span>${icon('chevron')}</button>`).join('')}</div><div class="workspace-add"><button class="picker-button" id="pick-folder" type="button">${icon('folder')}Choose a folder…</button><div class="path-divider"><span>or enter a folder path</span></div><form id="workspace-form"><label class="sr-only" for="workspace-path">Absolute folder path</label><input id="workspace-path" name="path" placeholder="/Users/you/Documents/my-work" required autocomplete="off" spellcheck="false" /><p class="field-hint">Use an existing folder on this computer. Pith will work inside it.</p><div id="workspace-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="workspace-dialog">Cancel</button><button class="primary-button" id="add-workspace" type="submit">Add workspace</button></div></form></div>`;
        $<HTMLDialogElement>('workspace-dialog').showModal();
        $('workspace-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            await addWorkspace($<HTMLInputElement>('workspace-path').value.trim());
        });
        $('pick-folder').addEventListener('click', async () => {
            const button = $<HTMLButtonElement>('pick-folder');
            button.disabled = true;
            $('workspace-error').textContent = '';
            try {
                const result = await request('/api/pick-workspace', {});
                if (result.path) {
                    $<HTMLInputElement>('workspace-path').value = result.path;
                    await addWorkspace(result.path);
                }
            }
            catch (error) {
                $('workspace-error').textContent = `${error instanceof Error ? error.message : String(error)} You can enter the path below.`;
                $<HTMLInputElement>('workspace-path').focus();
            }
            finally {
                button.disabled = false;
            }
        });
    }
    async function addWorkspace(path: string): Promise<void> {
        if (!path)
            return;
        $<HTMLButtonElement>('add-workspace').disabled = true;
        let workspaceId = '';
        if (await mutate('/api/workspaces', { path }, (response) => {
            if (!response?.workspace?.id)
                throw new Error('The local service did not return the added workspace.');
            workspaceId = response.workspace.id;
        })) {
            selectedWorkspaceId = workspaceId;
            $<HTMLDialogElement>('workspace-dialog').close();
            await newConversation(workspaceId);
        }
        else
            $('workspace-error').textContent = activity.error;
        $<HTMLButtonElement>('add-workspace').disabled = false;
    }
    return { selectedWorkspace, renderHistory, closeConversationMenu, openConversationMenu, openWorkspaceMenu, openDeletion, newConversation, openRename, exportConversation, openWorkspace, get selectedWorkspaceId() { return selectedWorkspaceId; }, set selectedWorkspaceId(id: string) { selectedWorkspaceId = id; }, get menuConversationId() { return menuConversationId; }, get menuWorkspaceId() { return menuWorkspaceId; }, toggleWorkspace(id: string) { if (expandedWorkspaces.has(id))
            expandedWorkspaces.delete(id);
        else
            expandedWorkspaces.add(id); renderHistory(); }, search(value: string) { historySearch = value; renderHistory(); } };
}
