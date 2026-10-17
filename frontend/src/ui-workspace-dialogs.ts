import { createTextEditDialog, createConfirmDialog, createTextInput, createText, createForm, createButton, createActions, createStack, createList, createListRow, createCollectionState, createSlot } from 'pith-ui';
import type { Control, ConfirmState } from 'pith-ui';
import type { WorkspaceScene, MessageEditorState, MessageEditorSession, SceneSession, ConfirmationState, FullAccessState, WorkspacePickerState, RenameConversationState, BranchHistoryState } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
export function createWorkspaceDialogs(hub: SessionHub): Pick<WorkspaceScene, 'openMessageEditor' | 'openQueueEditor' | 'openConfirmation' | 'openFullAccess' | 'openWorkspacePicker' | 'openRename' | 'openHistory'> {
    const editors = new Map<string, {
        close(): void;
    }>();
    function editor(kind: 'message' | 'queue', initial: MessageEditorState, callbacks: Parameters<WorkspaceScene['openMessageEditor']>[1] = {}): MessageEditorSession {
        editors.get(kind)?.close();
        let state = initial, alive = true, saved = initial.value, owner: {
            destroy(): void;
        } | undefined;
        const dialog = createTextEditDialog({ title: initial.title, purpose: kind === 'message' ? 'message' : 'pending-message', label: kind === 'message' ? 'Message' : 'Pending message', submitLabel: initial.submitLabel, onSubmit: text => resultOf(() => callbacks.onSubmit?.(text)), onInput: callbacks.onInput, onClose: release });
        function release() { if (!alive)
            return; saved = dialog.read(); alive = false; owner?.destroy(); if (editors.get(kind) === session)
            editors.delete(kind); callbacks.onClose?.(); }
        const session: MessageEditorSession = { read: () => alive ? dialog.read() : saved, reset(value) { if (alive) {
                dialog.open({ value });
                state = { ...state, value };
            } }, focus: dialog.focus, close: dialog.close, destroy: release, isOpen: () => alive && dialog.isOpen(), update(next) { if (alive) {
                state = next;
                dialog.update({ title: next.title, description: next.description, note: next.note, submitLabel: next.submitLabel, disabled: next.disabled, pending: next.pending, inputDisabled: next.inputDisabled, error: next.error });
            } }, fail(error) { if (alive)
                dialog.update({ ...state, error }); } };
        editors.set(kind, session);
        owner = hub.attach(dialog);
        dialog.update({ title: initial.title, description: initial.description, note: initial.note, submitLabel: initial.submitLabel, disabled: initial.disabled, pending: initial.pending, inputDisabled: initial.inputDisabled, error: initial.error });
        dialog.open({ value: initial.value });
        return session;
    }
    function confirmation(initial: ConfirmationState, callbacks: Parameters<WorkspaceScene['openConfirmation']>[1]): SceneSession<ConfirmationState> {
        let state = initial, alive = true, owner: {
            destroy(): void;
        } | undefined;
        const presentation = (value: ConfirmationState): ConfirmState => ({ title: value.title, confirmLabel: value.action, message: value.description, hint: value.hint, error: value.error, disabled: value.disabled });
        const dialog = createConfirmDialog({ ...presentation(initial), onConfirm: callbacks.onConfirm, onClose() { if (!alive)
                return; alive = false; owner?.destroy(); callbacks.onClose?.(); } });
        owner = hub.attach(dialog);
        dialog.open();
        return { isOpen: () => alive && dialog.isOpen(), close: dialog.close, destroy() { if (!alive)
                return; dialog.close(); }, update(next) { if (alive) {
                state = next;
                dialog.update(presentation(next));
            } }, fail(error) { if (alive)
                dialog.update(presentation({ ...state, error })); } };
    }
    return {
        openMessageEditor: (state, callbacks) => editor('message', state, callbacks), openQueueEditor: (state, callbacks) => editor('queue', state, callbacks), openConfirmation: confirmation,
        openFullAccess(initial, callbacks) {
            let state = initial;
            const convert = (value: FullAccessState): ConfirmationState => ({ title: 'Enable full access?', action: 'Enable full access', description: { before: 'Give Pith permission to run all enabled tools, including external MCP connections, without asking in ', subject: value.title || 'this conversation', after: '. Commands can read, change, or delete files outside the workspace and access the network. External tools can act on their connected services. There is no OS sandbox.' }, hint: 'This applies only to the current conversation and stays enabled across restarts until revoked. Choose “Ask before changes” or “Allow workspace changes” to revoke it. Workspace permission alone never grants external MCP tools access.', disabled: value.disabled, error: value.error });
            const session = confirmation(convert(initial), callbacks);
            return { ...session, update(next) { state = next; session.update(convert(next)); }, fail(error) { session.update(convert({ ...state, error })); } };
        },
        openWorkspacePicker(initial, callbacks = {}) {
            let state = initial, surface: Surface, disposed = false, generation = 0;
            const path = createTextInput({ label: 'Workspace folder', required: true, placeholder: '/path/to/workspace' }), list = createList({ items: [] });
            const form = createForm({ children: [path], submitLabel: 'Add workspace', onSubmit: async () => { const token = generation, result = await resultOf(() => callbacks.onSubmit?.(path.read().trim())); if (!disposed && token === generation && result.ok)
                    surface.close(); return result; }, onCancel: () => surface.close() });
            const choose = createButton({ label: 'Choose folder…', onAction: async () => { const token = generation, selection = await callbacks.onPick?.(); if (!disposed && token === generation && surface.isOpen()) {
                    if (selection?.error)
                        surface.fail(selection.error);
                    else if (selection?.path)
                        path.reset(selection.path);
                } } });
            const rows = new Map<string, {
                control: Control;
                button: ReturnType<typeof createButton>;
            }>();
            function render() { if (disposed)
                return; const keep = new Set<string>(); list.update({ items: state.workspaces.map(item => { keep.add(item.id); let row = rows.get(item.id); if (!row) {
                    const button = createButton({ label: item.name, onAction: () => { callbacks.onSelect?.(item.id); surface.close(); } });
                    row = { button, control: createListRow({ title: item.name, meta: item.path, actions: button }) };
                    rows.set(item.id, row);
                } row.button.update({ label: item.name, disabled: state.disabled }); return { key: item.id, content: row.control }; }) }); for (const id of rows.keys())
                if (!keep.has(id))
                    rows.delete(id); form.update({ submitLabel: 'Add workspace', disabled: state.disabled, error: state.error }); choose.update({ label: 'Choose folder…', disabled: state.disabled }); }
            surface = hub.open('workspace', 'Workspaces', createStack({ children: [list, choose, form] }), callbacks.onClose, () => { disposed = true; generation++; });
            render();
            path.focus();
            return { ...surface, read: () => ({ path: path.read().trim() }), reset(value = '') { if (!disposed) {
                    generation++;
                    path.reset(value);
                    form.resetSubmission();
                } }, focus: path.focus, update(next) { if (!disposed) {
                    state = next;
                    render();
                } } };
        },
        openRename(initial, callbacks = {}) {
            let state = initial, surface: Surface, disposed = false, revision = 0;
            const title = createTextInput({ label: 'Conversation title', value: initial.title, required: true });
            const form = createForm({ children: [title], submitLabel: 'Save title', onSubmit: async () => { const submitted = revision, result = await resultOf(() => callbacks.onSubmit?.({ id: state.id, title: title.read().trim() })); if (!disposed && submitted === revision && result.ok)
                    surface.close(); return result; }, onCancel: () => surface.close() });
            const render = () => form.update({ submitLabel: 'Save title', disabled: state.disabled, error: state.error });
            surface = hub.open('rename', 'Rename conversation', form, callbacks.onClose, () => { disposed = true; revision++; });
            render();
            title.focus();
            return { ...surface, read: () => ({ id: state.id, title: title.read().trim() }), reset(next) { if (!disposed) {
                    revision++;
                    state = next;
                    title.reset(next.title);
                    form.resetSubmission();
                    render();
                } }, focus: title.focus, update(next) { if (!disposed) {
                    state = next;
                    render();
                } } };
        },
        openHistory(initial, callbacks = {}) {
            let state = initial, surface: Surface, disposed = false;
            const list = createList({ items: [] }), status = createCollectionState({ status: 'loading', message: 'Loading branches…' }), rows = new Map<string, {
                control: Control;
                line: ReturnType<typeof createListRow>;
                text: ReturnType<typeof createText>;
                button: ReturnType<typeof createButton>;
            }>();
            function render() { if (disposed)
                return; status.update({ status: state.error ? 'error' : state.loading || state.nodes === null ? 'loading' : !state.nodes.length ? 'empty' : 'ready', message: state.error || (!state.nodes?.length ? 'No conversation branches yet.' : '') }); const keep = new Set<string>(); list.update({ items: (state.nodes ?? []).map(node => { keep.add(node.id); let row = rows.get(node.id); if (!row) {
                    const button = createButton({ label: 'Continue from here', onAction: async () => { const result = await resultOf(() => callbacks.onContinue?.(node.id)); if (!disposed && result.ok)
                            surface.close(); return result; }, onError: message => surface.fail(message) }), line = createListRow({ title: node.role, selected: node.active, actions: button }), text = createText({ text: node.text });
                    row = { button, line, text, control: createStack({ children: [line, text] }) };
                    rows.set(node.id, row);
                } row.line.update({ title: node.role, selected: node.active }); row.text.update({ text: node.text }); row.button.update({ label: 'Continue from here', disabled: node.active }); return { key: node.id, content: row.control }; }) }); for (const id of rows.keys())
                if (!keep.has(id))
                    rows.delete(id); }
            surface = hub.open('feature', 'Conversation branches', createStack({ children: [status, list, createButton({ label: 'Close', onAction: () => surface.close() })] }), callbacks.onClose, () => { disposed = true; });
            render();
            return { ...surface, update(next) { if (!disposed) {
                    state = next;
                    render();
                } } };
        },
    };
}
