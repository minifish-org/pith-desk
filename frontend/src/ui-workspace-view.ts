import { createText, createButton, createIconButton, createImage, createSearchInput, createSelect, createPromptInput, createReadingArea, createPane, createSplitPane, createStack, createActions, createToolbar, createScrollArea, createSlot, createList, createNotice, createTextAction, createListRow, createDisclosure } from 'pith-ui';
import type { Control, ButtonState, ImageControl, ListRowState } from 'pith-ui';
import type { WorkspaceScene, WorkspaceCallbacks, ApplicationBrand, WorkspaceAvailability, ComposerViewState, AttachmentsState, PendingMessagesState, WelcomeState } from './ui-types';
import { resultOf, type SessionHub } from './ui-sessions';
import { createNavigationView } from './ui-navigation-view';
import { createMessageView } from './ui-message-view';
import { createTaskView } from './ui-task-view';
import { createWorkspaceDialogs } from './ui-workspace-dialogs';
import type { createNativeFileIO } from './ui-native-io';
import { createDropArea } from 'pith-ui';
export function createWorkspaceView(hub: SessionHub, callbacks: WorkspaceCallbacks, brand: ApplicationBrand, fileHeader: Control, io: ReturnType<typeof createNativeFileIO>) {
    let selectedWorkspace = '', selectionGeneration = 0, composerSignature = '', welcomeSignature = '', availabilitySignature = '';
    let destroyed = false, activeId = '', availability: WorkspaceAvailability = {}, composerState: ComposerViewState = {}, attachmentsState: AttachmentsState = { items: [] }, dropPending = false, conversationWorking = false, hasMessages = false, sidebarOpen = false;
    const fail = callbacks.onError ?? hub.report, navigation = createNavigationView(hub, callbacks), messages = createMessageView(hub, callbacks), tasks = createTaskView(hub, callbacks), dialogs = createWorkspaceDialogs(hub);
    const globalButtons: Array<{
        control: Control<ButtonState>;
        label: string;
        icon?: 'file' | 'settings' | 'plug' | 'plus';
    }> = [];
    const globalAction = (label: string, action: 'workspace' | 'resources' | 'connections' | 'settings', icon?: 'file' | 'settings' | 'plug' | 'plus') => { const control = action === 'workspace' ? createIconButton({ label, icon: 'plus', onAction: () => callbacks.onAction?.(action), onError: fail }) : createTextAction({ label, icon, onAction: () => callbacks.onAction?.(action), onError: fail }); globalButtons.push({ control, label, icon }); return control; };
    const brandImage = createImage({ purpose: 'brand', source: brand.mark && 'src' in brand.mark ? brand.mark.src ?? '/brand-light.svg' : '/brand-light.svg', label: brand.mark?.alt ?? '' }), wordmark = createText({ role: 'heading', text: brand.name + ' ' + (brand.qualifier ?? '') });
    const reconnect = createNotice({ message: '', tone: 'info' }), search = createSearchInput({ label: 'Search conversation titles', placeholder: 'Search conversations', onInput: value => navigation.search(value) });
    const sidebar = createPane({ header: createStack({ children: [createActions({ align: 'start', children: [brandImage, wordmark] }), createToolbar({ label: 'Workspaces', children: [createText({ role: 'heading', text: 'WORKSPACES' }), globalAction('Manage workspaces', 'workspace', 'plus')] }), search] }), content: navigation.content, footer: createStack({ children: [globalAction('Workspace resources', 'resources', 'file'), globalAction('Connections', 'connections', 'plug'), globalAction('Settings', 'settings', 'settings'), reconnect] }) });
    const workspaceLabel = createText({ text: 'No workspace' }), title = createText({ text: 'New conversation' }), toggle = createIconButton({ label: 'Open sidebar', icon: 'menu', onAction: () => { sidebarOpen = !sidebarOpen; layout.setNavigationOpen(sidebarOpen); } }), compact = createIconButton({ label: 'Compress context', icon: 'compress', title: 'Compress context by summarizing older messages', disabled: true, onAction: () => callbacks.onAction?.('compact'), onError: fail });
    const welcomeTitle = createText({ role: 'heading', text: 'Your work. A little more possible.' }), welcomeInfo = createText({ role: 'description', text: 'An agent that works alongside you, with your files and the tools you choose.' }), welcomeSetup = createSlot(), welcome = createStack({ children: [createText({ role: 'description', text: 'YOUR LOCAL WORK COMPANION' }), welcomeTitle, welcomeInfo, welcomeSetup, createText({ role: 'description', text: 'Local workspace. Your choice of model.' })] });
    const reader = createReadingArea({ label: 'Conversation', identity: '', items: [], viewport: 'fill', empty: welcome });
    const attachmentList = createList({ items: [] }), attachmentRows = new Map<string, ImageControl>(), pendingList = createList({ items: [] }), pendingRows = new Map<string, {
        control: Control;
        line: Control<ListRowState>;
        buttons: Array<{
            control: Control<ButtonState>;
            label: string;
            action: 'edit' | 'delete' | 'steer';
        }>;
    }>();
    let submitting = false, submitGeneration = 0;
    const prompt = createPromptInput({ label: 'Message Pith', placeholder: 'Ask Pith to help with your work…', onInput: callbacks.onInput, onBlur: () => callbacks.onBlur?.(), onImages: files => {
            if (!attachmentsState.disabled)
                callbacks.onImages?.([...files]);
        }, onSubmit: () => composerState.action === 'stop' ? undefined : submit(), onError: fail });
    const attach = createIconButton({ label: 'Attach images', icon: 'image', onAction: () => pickImages() }), permissions = createSelect({ label: 'Conversation permissions', value: 'ask', options: [{ value: 'ask', label: 'Ask before changes' }, { value: 'workspace-write', label: 'Allow workspace changes' }, { value: 'full-access', label: 'Full access' }], onChange: callbacks.onPermissionChange }), permissionNote = createText({ role: 'description', text: '' });
    const model = createButton({ label: 'Choose model', onAction: () => callbacks.onAction?.('model'), onError: fail }), thinking = createSelect({ label: 'Thinking effort', options: [], onChange: callbacks.onThinkingChange }), thinkingSlot = createSlot({ content: thinking, hidden: true }), send = createIconButton({ label: 'Send message', icon: 'arrow', intent: 'primary', onAction: () => submit(), onError: fail });
    const guidance = createNotice({ message: '', tone: 'info' }), error = createNotice({ message: '', tone: 'error' }), busyMessage = createText({ text: '' }), busyAction = createButton({ label: 'Open conversation', onAction: () => callbacks.onBusyAction?.(busyKey) }), busy = createSlot({ content: createActions({ children: [busyMessage, busyAction] }), hidden: true });
    let busyKey = '';
    const composer = createStack({ children: [attachmentList, prompt, createToolbar({ label: 'Message actions', children: [attach, permissions, model, thinkingSlot, send] })] });
    const drop = createDropArea({ content: composer, onError: fail, onDrop: input => {
            if (composerUnavailable())
                return;
            const images = input.files.filter(file => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || !file.type && /\.(png|jpe?g|gif|webp)$/i.test(file.name));
            if (images.length && !attachmentsState.disabled)
                callbacks.onImages?.([...images]);
            if (!dropPending && (input.paths.length || input.uris || input.hasUnidentifiedFiles))
                callbacks.onDropReferences?.({ paths: input.paths, uris: input.uris, hasUnidentifiedFiles: input.hasUnidentifiedFiles });
        } });
    const panels = createScrollArea({ label: 'Task status and pending messages', content: createStack({ children: [tasks.content, busy, error, pendingList] }) });
    const panelsSlot = createSlot({ content: panels, hidden: true });
    let hasApproval = false, hasFailure = false, hasRuntime = false, hasNotices = false, hasPending = false, hasError = false, hasBusy = false;
    const syncPanels = () => panelsSlot.update({ hidden: !(hasApproval || hasFailure || hasRuntime || hasNotices || hasPending || hasError || hasBusy) });
    const main = createPane({ header: createToolbar({ label: 'Conversation navigation', children: [toggle, workspaceLabel, title, compact, fileHeader] }), content: reader, footer: createStack({ children: [panelsSlot, drop, guidance, permissionNote] }) }), layout = createSplitPane({ navigation: sidebar, content: main, onNavigationToggle: open => { sidebarOpen = open; } });
    function composerUnavailable() { return destroyed || !!composerState.disabled || !!composerState.readOnly || !!availability.busy; }
    function pickImages() {
        if (!composerUnavailable() && !attachmentsState.disabled) {
            const id = activeId, generation = selectionGeneration;
            io.pickImages(files => {
                if (!destroyed && generation === selectionGeneration && id === activeId && !composerUnavailable() && !attachmentsState.disabled)
                    callbacks.onImages?.(files);
            });
        }
    }
    function renderComposer() {
        if (destroyed)
            return;
        const signature = JSON.stringify([composerState, !!attachmentsState.disabled, !!availability.busy, !!availability.active, conversationWorking, activeId, hasMessages, submitting]);
        if (signature === composerSignature)
            return;
        composerSignature = signature;
        prompt.update({ label: 'Message Pith', placeholder: composerState.placeholder ?? 'Ask Pith to help with your work…', disabled: composerState.disabled, readOnly: composerState.readOnly });
        attach.update({ label: 'Attach images', icon: 'image', disabled: composerUnavailable() || attachmentsState.disabled });
        model.update({ label: composerState.model?.label ?? 'Choose model', title: composerState.model?.description, disabled: composerState.model?.disabled });
        const mode = composerState.action ?? 'send', label = mode === 'stop' ? 'Stop agent' : mode === 'queue' ? 'Queue message' : 'Send message';
        send.update({ label, icon: mode === 'stop' ? 'stop' : 'arrow', intent: 'primary', disabled: composerState.disabled || composerState.actionDisabled, pending: submitting });
        thinkingSlot.update({ hidden: (composerState.thinking?.options.length ?? 0) < 2 });
        thinking.update({ label: 'Thinking effort', options: composerState.thinking?.options ?? [], disabled: composerState.thinking?.disabled });
        if (composerState.thinking)
            thinking.reset(composerState.thinking.value);
        drop.update({ disabled: composerUnavailable() });
        compact.update({ label: 'Compress context', icon: 'compress', title: 'Compress context by summarizing older messages', disabled: availability.busy || availability.active || conversationWorking || !activeId || !hasMessages });
    }
    async function submit() {
        if (destroyed || submitting || composerState.actionDisabled || composerState.disabled)
            return { ok: true } as const;
        const stop = composerState.action === 'stop';
        if (!stop && composerState.readOnly)
            return { ok: true } as const;
        submitting = true;
        const token = submitGeneration;
        renderComposer();
        error.update({ message: '', tone: 'error' });
        const result = await resultOf(stop ? callbacks.onStop : () => callbacks.onSubmit?.(prompt.read()));
        if (!destroyed && token === submitGeneration) {
            submitting = false;
            renderComposer();
            if (!result.ok)
                error.update({ message: result.error, tone: 'error' });
        }
        return result;
    }
    function updateAttachments(state: AttachmentsState) {
        attachmentsState = state;
        const keep = new Set<string>();
        attachmentList.update({ items: state.items.map(item => {
                keep.add(item.id);
                let row = attachmentRows.get(item.id);
                if (!row) {
                    row = createImage({ label: item.name, source: item.url, purpose: 'attachment', onRemove: () => callbacks.onRemoveAttachment?.(item.id), onError: fail });
                    attachmentRows.set(item.id, row);
                }
                row.update({ label: item.name, source: item.url, removeDisabled: state.disabled });
                return { key: item.id, content: row };
            }) });
        for (const key of attachmentRows.keys())
            if (!keep.has(key))
                attachmentRows.delete(key);
        renderComposer();
    }
    function updatePending(state: PendingMessagesState) {
        hasPending = state.items.length > 0;
        syncPanels();
        const keep = new Set<string>();
        pendingList.update({ items: state.items.map(item => {
                keep.add(item.id);
                let row = pendingRows.get(item.id);
                if (!row) {
                    const buttons: Array<{
                        control: Control<ButtonState>;
                        label: string;
                        action: 'edit' | 'delete' | 'steer';
                    }> = [];
                    for (const [action, label] of [['edit', 'Edit pending message'], ['delete', 'Remove pending message'], ['steer', 'Send as steering']] as const)
                        buttons.push({ action, label, control: createButton({ label, onAction: () => callbacks.onQueueAction?.(action, item.id) }) });
                    const line = createListRow({ title: item.text, actions: createActions({ children: buttons.map(button => button.control) }) });
                    row = { control: line, line, buttons };
                    pendingRows.set(item.id, row);
                }
                row.line.update({ title: item.text, meta: [item.mode, item.imageCount ? item.imageCount + ' images' : ''].filter(Boolean).join(' · ') });
                for (const button of row.buttons)
                    button.control.update({ label: button.label, disabled: state.busy || button.action === 'steer' && !state.running });
                return { key: item.id, content: row.control };
            }) });
        for (const key of pendingRows.keys())
            if (!keep.has(key))
                pendingRows.delete(key);
    }
    function updateWelcome(state: WelcomeState) {
        const signature = JSON.stringify(state);
        if (signature === welcomeSignature)
            return;
        welcomeSignature = signature;
        const ready = !!state.workspace && state.hasApiKey;
        welcomeTitle.update({ role: 'heading', text: ready ? 'What are we working on?' : 'Your work. A little more possible.' });
        if (ready) {
            welcomeSetup.set(createStack({ children: [createText({ text: 'Working in ' + state.workspace!.name }), createButton({ label: 'Change workspace', onAction: () => callbacks.onAction?.('workspace') }), createActions({ children: [['Explore my workspace', 'Explore this workspace and give me a concise overview of its files.'], ['Think through a task', 'Help me plan a task. Start by asking what I want to accomplish.'], ['Create something', "I'd like help creating a document in this workspace. Ask me what it should cover."]].map(([label, text]) => createButton({ label, onAction: () => { prompt.reset(text); callbacks.onInput?.(text); prompt.focus(); } })) })] }));
        }
        else
            welcomeSetup.set(createStack({ children: [createText({ role: 'heading', text: 'Make yourself at home · Two quick steps' }), createButton({ label: state.hasApiKey ? 'Model selected · ' + state.modelName : state.hasConnections ? 'Choose a model' : 'Connect a provider', onAction: () => callbacks.onAction?.(state.hasConnections ? 'model' : 'settings') }), createButton({ label: state.workspace ? state.workspace.name + ' · ' + state.workspace.path : 'Choose a workspace', onAction: () => callbacks.onAction?.('workspace') })] }));
    }
    const api: WorkspaceScene = {
        ...dialogs, ...tasks.api, updateApproval(state) { hasApproval = !!state.approval; tasks.api.updateApproval(state); syncPanels(); }, updateFailure(state) { hasFailure = state.visible; tasks.api.updateFailure(state); syncPanels(); }, updateRuntime(state) { hasRuntime = state.visible; tasks.api.updateRuntime(state); syncPanels(); }, updateNotices(entries) { hasNotices = entries.length > 0; tasks.api.updateNotices(entries); syncPanels(); },
        updateShell(state) {
            if (destroyed)
                return;
            if (state.workspace !== undefined)
                workspaceLabel.update({ text: state.workspace });
            if (state.conversation !== undefined)
                title.update({ text: state.conversation });
            reconnect.update({ message: state.reconnecting ? 'Reconnecting…' : '', tone: 'info' });
            if (state.error) {
                hasError = !!state.error.message && !state.error.hidden;
                error.update({ message: state.error.hidden ? '' : state.error.message, tone: 'error' });
            }
            if (state.busy !== undefined) {
                hasBusy = !!state.busy;
                busy.update({ hidden: !state.busy });
                if (state.busy) {
                    busyKey = state.busy.key;
                    busyMessage.update({ text: state.busy.message });
                    busyAction.update({ label: state.busy.actionLabel });
                }
            }
            syncPanels();
        },
        updateComposer(state) { composerState = state; renderComposer(); }, readDraft: prompt.read, resetDraft(text) { submitGeneration++; submitting = false; prompt.reset(text); error.update({ message: '', tone: 'error' }); renderComposer(); }, focusComposer: prompt.focus, pickImages,
        insertReferences(paths) {
            if (composerUnavailable() || dropPending || !paths.length)
                return;
            const value = paths.map(path => { const ticks = Math.max(0, ...[...path.matchAll(/`+/g)].map(match => match[0].length)) + 1, delimiter = '`'.repeat(ticks); return delimiter + (/^`|`$|^ | $/.test(path) && !/^ +$/.test(path) ? ' ' + path + ' ' : path) + delimiter; }).join(' ');
            prompt.insert(value, { separate: true });
        },
        receiveNativeDrop(input) {
            if (!dropPending)
                drop.receiveNativeDrop(input);
        }, setDropPending(pending) {
            dropPending = pending;
            if (pending)
                drop.clear();
        }, updateNavigation(state) {
            const selected = state.groups.find(group => group.selected)?.id ?? '';
            if (selected !== selectedWorkspace) {
                selectedWorkspace = selected;
                selectionGeneration++;
            }
            navigation.update(state);
        }, search(value) { search.reset(value); navigation.search(value); }, closeNavigationMenu: navigation.closeMenus, setSidebarOpen: layout.setNavigationOpen,
        updateConversation(state) {
            if (destroyed)
                return;
            if (state.id !== activeId) {
                selectionGeneration++;
                activeId = state.id;
                tasks.api.resetCosts();
            }
            conversationWorking = state.working;
            hasMessages = state.messages.length > 0;
            reader.update({ label: 'Conversation', identity: state.id, items: messages.update(state), viewport: 'fill' });
            renderComposer();
        }, updateMessageAvailability: messages.setAvailability, pruneConversations(ids) { messages.prune(ids); reader.prune(ids); }, updateWelcome, followLatest: reader.followLatest, openFind: reader.find, closeFind: reader.closeFind, updatePending, updateAttachments, updateImageGuidance(message) { guidance.update({ message, tone: 'info' }); }, updatePermission(state) { permissions.update({ label: 'Conversation permissions', disabled: state.disabled, options: [{ value: 'ask', label: 'Ask before changes' }, { value: 'workspace-write', label: 'Allow workspace changes' }, { value: 'full-access', label: 'Full access' }] }); permissions.reset(state.mode); permissionNote.update({ role: 'description', text: state.description }); },
        updateAvailability(state) {
            const signature = JSON.stringify(state);
            if (signature === availabilitySignature)
                return;
            availabilitySignature = signature;
            availability = state;
            tasks.availability(state);
            messages.setBusy(!!state.busy);
            for (const button of globalButtons)
                button.control.update({ label: button.label, icon: button.icon, disabled: false });
            navigation.availability(state);
            renderComposer();
        },
        destroy() {
            if (destroyed)
                return;
            destroyed = true;
            submitGeneration++;
            messages.destroy();
            navigation.destroy();
        },
    };
    return { api, content: layout, brandImage };
}
