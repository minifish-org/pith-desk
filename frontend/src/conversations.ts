import type { Application, NavigationStatus, RenameConversationState, SceneSession, WorkspacePickerState } from 'pith-ui/app';
import type { ApiDownload, ApiMutate, ApiRequest } from './api.ts';
import type { Confirmation } from './confirmation.ts';
import type { Conversation, RunSummary, Workspace } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
type API = {
    ui: Application;
    view: AppView;
    activity: UIActivity;
    request: ApiRequest;
    download: ApiDownload;
    mutate: ApiMutate;
    render: () => void;
    closeSidebar: () => void;
    workspaceRun: (id?: string) => RunSummary | undefined;
    conversationRunning: (id: string | null) => boolean;
    historyStatus: (entry: Conversation) => NavigationStatus;
    confirmRemoval: (options: Confirmation) => void;
    removeWorkspaceResources: (id: string) => void;
    clearHistoryImages: () => void;
    loadComposerDraft: () => void;
};

export function createConversationsUI(api: API) {
    const {ui, view: app, activity, request, download, mutate, render, closeSidebar, workspaceRun, conversationRunning, historyStatus, confirmRemoval, clearHistoryImages, loadComposerDraft} = api;
    let selectedWorkspaceId = '';
    let destroyed = false;
    let historySignature = '';
    let renameEditor: (SceneSession<RenameConversationState> & {read(): {id: string; title: string}}) | undefined;
    let workspacePicker: SceneSession<WorkspacePickerState> | undefined;
    function selectedWorkspace(): Workspace | undefined {
        const conversation = app.state.conversations.find(entry => entry.id === app.state.activeId);
        return app.state.workspaces.find(entry => entry.id === (conversation?.workspaceId || selectedWorkspaceId)) ?? app.state.workspaces[0];
    }
    function renderHistory(): void {
        if (destroyed) return;
        if (renameEditor?.isOpen()) {
            const draft = renameEditor.read();
            renameEditor.update({...draft, disabled: activity.busy || conversationRunning(draft.id)});
        }
        workspacePicker?.update({workspaces: app.state.workspaces, disabled: activity.busy});
        const signature = JSON.stringify([app.state.workspaces, app.state.conversations, app.state.activeId, selectedWorkspace()?.id, app.state.runs, activity.busy]);
        if (signature === historySignature) return;
        historySignature = signature;
        const conversations = [...app.state.conversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        ui.workspace.updateNavigation({
            groups: app.state.workspaces.map(workspace => ({...workspace, selected: workspace.id === selectedWorkspace()?.id,
                canRemove: !activity.busy && !workspaceRun(workspace.id),
                children: conversations.filter(entry => entry.workspaceId === workspace.id).map(entry => ({...entry,
                    active: entry.id === app.state.activeId, status: historyStatus(entry),
                    actions: {rename: !conversationRunning(entry.id), history: entry.id === app.state.activeId && !conversationRunning(entry.id), export: !conversationRunning(entry.id), delete: !conversationRunning(entry.id)},
                })),
            })),
            empty: !app.state.workspaces.length ? 'workspaces' : null, disabled: activity.busy,
        });
    }
    function openDeletion(kind: 'conversation' | 'workspace', id: string): void {
        const busy = () => kind === 'workspace' ? !!workspaceRun(id) : conversationRunning(id);
        if (busy() || activity.busy) return;
        const item = kind === 'workspace' ? app.state.workspaces.find(entry => entry.id === id) : app.state.conversations.find(entry => entry.id === id);
        if (!item) return;
        const count = app.state.conversations.filter(entry => entry.workspaceId === id).length;
        const name = 'name' in item ? item.name : item.title || 'Untitled conversation';
        const action = kind === 'workspace' ? 'Remove workspace' : 'Delete conversation';
        const description = kind === 'workspace'
            ? {before: 'Remove ', subject: name, after: ` from Pith Desk and permanently delete its ${count} ${count === 1 ? 'conversation' : 'conversations'}, including history, image attachments and run records?`}
            : {before: 'Permanently delete ', subject: name, after: ', including its history, image attachments and run records?'};
        confirmRemoval({title: `${action}?`, action, description,
            hint: 'The folder and its files stay on your computer, including files created by Pith. Deleted conversation data cannot be recovered from Pith Desk.',
            scope: kind === 'workspace' ? {workspaceId: id} : {conversationId: id},
            unavailable: () => busy() || activity.busy, error: () => activity.error,
            run: async () => {
                const activeWorkspace = selectedWorkspace()?.id, activeID = app.state.activeId;
                const ok = await mutate(kind === 'workspace' ? '/api/remove-workspace' : '/api/delete-conversation', {id, ...(kind === 'workspace' ? {conversationCount: count} : {})});
                if (!ok) return false;
                if (kind === 'workspace') {
                    if (selectedWorkspaceId === id) selectedWorkspaceId = '';
                    api.removeWorkspaceResources(id);
                }
                if (activeID !== app.state.activeId || activeWorkspace !== selectedWorkspace()?.id) {clearHistoryImages(); loadComposerDraft();}
                render();
                return true;
            },
        });
    }
    async function newConversation(workspaceId = selectedWorkspace()?.id): Promise<void> {
        if (!workspaceId) {openWorkspace(); return;}
        if (await mutate('/api/conversations', {workspaceId})) {
            renderHistory(); closeSidebar(); ui.workspace.focusComposer();
        }
    }
    function openRename(id = app.state.activeId): void {
        const conversation = app.state.conversations.find(entry => entry.id === id);
        if (!conversation || conversationRunning(id)) return;
        renameEditor?.destroy();
        renameEditor = ui.workspace.openRename({id: id!, title: conversation.title || '', disabled: activity.busy}, {
            async onSubmit(draft) {
                if (activity.busy || conversationRunning(draft.id)) return {ok: false, error: 'This conversation is busy.'};
                const ok = await mutate('/api/rename', draft);
                return ok ? {ok: true} : {ok: false, error: activity.error};
            },
        });
    }
    async function exportConversation(id = app.state.activeId): Promise<void> {
        const conversation = app.state.conversations.find(entry => entry.id === id);
        if (!conversation || activity.busy || conversationRunning(id)) return;
        activity.busy = true; activity.error = ''; render();
        try {
            const delivery = await request('/api/export', {id: conversation.id});
            // Native cancellation is handled, too. Only explicit browser mode falls back.
            if (delivery?.native === true) return;
            if (delivery?.native !== false) throw new Error('The local service returned an invalid export response.');
            const result = await ui.downloadFile({blob: await download('/api/export', {id: conversation.id}), name: `${(conversation.title || 'Conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Conversation'}.md`});
            if (!result.ok) throw new Error(result.error);
        } catch (error) {activity.error = error instanceof Error ? error.message : String(error);}
        finally {activity.busy = false; render();}
    }
    async function selectWorkspace(id: string): Promise<void> {
        if (!app.state.workspaces.some(entry => entry.id === id)) return;
        selectedWorkspaceId = id;
        const latest = app.state.conversations.filter(entry => entry.workspaceId === id).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
        if (latest) await mutate('/api/open', {id: latest.id});
        else await newConversation(id);
        closeSidebar();
    }
    function openWorkspace(): void {
        closeSidebar(); workspacePicker?.destroy();
        const picker = ui.workspace.openWorkspacePicker({workspaces: app.state.workspaces, disabled: activity.busy}, {
            async onSubmit(path) {
                if (activity.busy) return {ok: false, error: 'Another operation is in progress.'};
                let addedWorkspaceId = '';
                const ok = await mutate('/api/workspaces', {path}, response => {
                    if (!response?.workspace?.id) throw new Error('The local service did not return the added workspace.');
                    addedWorkspaceId = response.workspace.id;
                });
                if (ok && !destroyed && workspacePicker === picker && picker.isOpen()) {
                    selectedWorkspaceId = addedWorkspaceId; picker.close(); void newConversation(addedWorkspaceId);
                }
                return ok ? {ok: true} : {ok: false, error: activity.error};
            },
            onPick: () => request('/api/pick-workspace', {}),
            onSelect(id) {picker.close(); void selectWorkspace(id);},
        });
        workspacePicker = picker;
    }
    return {selectedWorkspace, renderHistory, openDeletion, newConversation, openRename, exportConversation, openWorkspace, selectWorkspace,
        destroy() {destroyed = true; renameEditor?.destroy(); workspacePicker?.destroy();},
        get selectedWorkspaceId() {return selectedWorkspaceId;}, set selectedWorkspaceId(id: string) {selectedWorkspaceId = id;},
    };
}
