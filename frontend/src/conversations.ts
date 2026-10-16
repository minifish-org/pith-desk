import { createWorkspaceNavigation, createContextMenu, createRenameConversation, createWorkspacePicker, type ContextMenuItem } from 'pith-ui';
import type { ApiDownload, ApiMutate, ApiRequest } from './api.ts';
import type { Confirmation } from './confirmation.ts';
import type { Conversation, RunSummary, Workspace } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { escape } from './ui.ts';
type API = {
    view: AppView;
    activity: UIActivity;
    input: HTMLTextAreaElement;
    request: ApiRequest;
    download: ApiDownload;
    mutate: ApiMutate;
    render: () => void;
    closeSidebar: () => void;
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
    const { view: app, activity, input, request, download, mutate, render, closeSidebar, workspaceRun, conversationRunning, historyStatus, confirmRemoval, clearHistoryImages, loadComposerDraft, resizeComposer } = api;
    let selectedWorkspaceId = '';
    let historySearch = '';
    const expandedWorkspaces = new Set<string>();
    let historySignature = '';
    let historyFilterSignature = '';
    let historyActiveId: string | null | undefined;
    let menuConversationId: string | null = null;
    let menuWorkspaceId: string | null = null;
    function toggleWorkspace(id: string): void {
        if (expandedWorkspaces.has(id)) expandedWorkspaces.delete(id);
        else expandedWorkspaces.add(id);
        renderHistory();
    }
    const navigation = createWorkspaceNavigation({groups: [], empty: null}, {element: $('history-list'), idPrefix: '', onToggle: toggleWorkspace});
    const contextMenu = createContextMenu({element: $('conversation-menu'), onDismiss: (restoreFocus) => closeConversationMenu(restoreFocus)});
    let renameEditor: ReturnType<typeof createRenameConversation> | undefined;
    let workspacePicker: ReturnType<typeof createWorkspacePicker> | undefined;
    function selectedWorkspace(): Workspace | undefined {
        const conversation = app.state.conversations.find((entry) => entry.id === app.state.activeId);
        return app.state.workspaces.find((entry) => entry.id === (conversation?.workspaceId || selectedWorkspaceId)) ?? app.state.workspaces[0];
    }
    function renderHistory(): void {
        if (renameEditor) {
            const draft = renameEditor.read();
            renameEditor.update({...draft, disabled: activity.busy || conversationRunning(draft.id)});
        }
        workspacePicker?.update({workspaces: app.state.workspaces, disabled: activity.busy});
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
        navigation.update({groups: app.state.workspaces.map((workspace) => ({...workspace, expanded: expandedWorkspaces.has(workspace.id), selected: workspace.id === selectedWorkspace()?.id, menuOpen: workspace.id === menuWorkspaceId, children: conversations.filter((entry) => entry.workspaceId === workspace.id).map((entry) => {
            const status = document.createElement('template'); status.innerHTML = historyStatus(entry);
            return {...entry, active: entry.id === app.state.activeId, menuOpen: entry.id === menuConversationId, status: status.content};
        })})).filter((workspace) => !search || workspace.children.length > 0), empty: !app.state.workspaces.length ? 'workspaces' : search && !conversations.length ? 'search' : null, disabled: activity.busy});
    }

    function closeConversationMenu(restoreFocus = false): void {
        menuConversationId = null;
        menuWorkspaceId = null;
        contextMenu.close(restoreFocus);
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
        const idle = {conversationId: id};
        const disabled = conversationRunning(id);
        const items: ContextMenuItem[] = [{label: 'Rename', action: 'rename', idle, disabled}];
        if (id === app.state.activeId && !conversationRunning(id)) items.push({label: 'Conversation branches', sdkAction: 'history', action: 'close-conversation-menu'});
        items.push({label: 'Export Markdown', action: 'export', idle, disabled}, {label: 'Delete conversation', action: 'delete-conversation', danger: true, idle, disabled});
        contextMenu.open(trigger, {label: 'Conversation actions', items});
    }

    function openWorkspaceMenu(id: string, trigger: HTMLElement): void {
        if (activity.busy || !app.state.workspaces.some((entry) => entry.id === id))
            return;
        const alreadyOpen = menuWorkspaceId === id;
        closeConversationMenu();
        if (alreadyOpen)
            return;
        menuWorkspaceId = id;
        contextMenu.open(trigger, {label: 'Workspace actions', items: [{label: 'Remove workspace', action: 'remove-workspace', danger: true, idle: {workspaceId: id}, disabled: !!workspaceRun(id)}]});
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
        renameEditor?.destroy();
        renameEditor = createRenameConversation({id: id!, title: conversation.title || ''}, {
            idPrefix: '', dialog: $<HTMLDialogElement>('rename-dialog'),
            unavailable: () => conversationRunning(id) || activity.busy,
            async onSubmit(draft) {
                const ok = await mutate('/api/rename', draft);
                return ok ? {ok: true} : {ok: false, error: activity.error};
            },
        });
        $('rename-content').replaceChildren(renameEditor.element);
        renameEditor.open();
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
        workspacePicker?.destroy();
        let addedWorkspaceId = '';
        workspacePicker = createWorkspacePicker({workspaces: app.state.workspaces}, {
            idPrefix: '', dialog: $<HTMLDialogElement>('workspace-dialog'), unavailable: () => activity.busy,
            async onSubmit(path) {
                const ok = await mutate('/api/workspaces', {path}, response => {
                    if (!response?.workspace?.id) throw new Error('The local service did not return the added workspace.');
                    addedWorkspaceId = response.workspace.id;
                });
                return ok ? {ok: true} : {ok: false, error: activity.error};
            },
            onPick: () => request('/api/pick-workspace', {}),
            onSelect(id) {
                selectedWorkspaceId = id;
                workspacePicker?.close();
                const latest = app.state.conversations.filter(entry => entry.workspaceId === id).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
                void (latest ? mutate('/api/open', {id: latest.id}) : newConversation(id)).then(() => closeSidebar());
            },
            onSubmitted() {selectedWorkspaceId = addedWorkspaceId; void newConversation(addedWorkspaceId);},
        });
        $('workspace-content').replaceChildren(workspacePicker.element);
        workspacePicker.open();
    }
    return { selectedWorkspace, renderHistory, closeConversationMenu, openConversationMenu, openWorkspaceMenu, openDeletion, newConversation, openRename, exportConversation, openWorkspace, destroy() {navigation.destroy(); contextMenu.destroy(); renameEditor?.destroy(); workspacePicker?.destroy();}, get selectedWorkspaceId() { return selectedWorkspaceId; }, set selectedWorkspaceId(id: string) { selectedWorkspaceId = id; }, get menuConversationId() { return menuConversationId; }, get menuWorkspaceId() { return menuWorkspaceId; }, search(value: string) { historySearch = value; renderHistory(); } };
}
