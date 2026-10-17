import { createText, createTextInput, createTextArea, createForm, createButton, createActions, createStack, createList, createListRow, createDisclosure, createSlot, createNotice, createCollectionState } from 'pith-ui';
import type { Control, ButtonState, ListRowState } from 'pith-ui';
import type { ResourcesScene, ResourcesState, ResourcesCallbacks, ResourcesSession, AppResourceKind, AppResourceEntry, AppResourceTarget, AppResourceEditorState, ResourceEditorCallbacks, ResourceEditorSession, ResourceDraft } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
export function createResourcesView(hub: SessionHub): ResourcesScene {
    return { openEditorLoading(state, callbacks = {}) { return hub.loading('feature', state.path ? 'Edit workspace resource' : 'Create ' + state.kind, state, callbacks.onClose); }, open: (state, callbacks = {}) => openInventory(hub, state, callbacks), openEditor: (state, callbacks = {}) => openEditor(hub, state, callbacks), destroy() { } };
}
function openInventory(hub: SessionHub, initial: ResourcesState, callbacks: ResourcesCallbacks): ResourcesSession {
    let state = initial, surface: Surface, disposed = false;
    const owner = initial.workspace.id, active = () => !disposed && !!surface?.isOpen();
    const description = createText({ role: 'description', text: initial.workspace.path }), error = createNotice({ message: '', tone: 'error' }), loading = createCollectionState({ status: 'loading', message: 'Loading resources…' }), loadingSlot = createSlot({ content: loading, hidden: !initial.loading });
    const sections = new Map<AppResourceKind, {
        list: ReturnType<typeof createList>;
        rows: Map<string, {
            control: Control;
            update(value: AppResourceEntry): void;
        }>;
        add: Control<ButtonState>;
        slot: ReturnType<typeof createSlot>;
    }>();
    const children: Control[] = [description, createButton({ label: 'Refresh', onAction: () => callbacks.onRefresh?.(), onError: message => surface.fail(message) }), error, loadingSlot];
    for (const [kind, title] of [['instructions', 'Instructions'], ['skill', 'Skills'], ['template', 'Prompt templates']] as const) {
        const add = createButton({ label: (kind === 'instructions' ? 'Create AGENTS.md in this workspace' : kind === 'skill' ? 'Add skill' : 'Add prompt template'), onAction: () => callbacks.onCreate?.(kind), onError: message => surface.fail(message) }), slot = createSlot({ content: add }), list = createList({ items: [] });
        sections.set(kind, { list, rows: new Map(), add, slot });
        children.push(createText({ role: 'heading', text: title }), slot, list);
    }
    const diagnostics = createText({ role: 'code', text: '' }), diagnosticSlot = createSlot({ content: createDisclosure({ title: 'Diagnostics', content: diagnostics }), hidden: true });
    children.push(diagnosticSlot, createButton({ label: 'Close workspace resources', onAction: () => surface.close() }));
    function render(): void {
        if (disposed)
            return;
        error.update({ message: state.error ?? '', tone: 'error' });
        loadingSlot.update({ hidden: !state.loading });
        diagnostics.update({ role: 'code', text: state.diagnostics.join('\n') });
        diagnosticSlot.update({ hidden: !state.diagnostics.length });
        for (const [kind, section] of sections) {
            section.add.update({ label: (kind === 'instructions' ? 'Create AGENTS.md in this workspace' : kind === 'skill' ? 'Add skill' : 'Add prompt template'), disabled: state.busy });
            section.slot.update({ hidden: kind === 'instructions' && !state.canCreateInstructions });
            const entries = kind === 'instructions' ? state.instructions : kind === 'skill' ? state.skills : state.templates, keep = new Set<string>(), items: Array<{
                key: string;
                content: Control;
            }> = [];
            for (const entry of entries) {
                const key = entry.path;
                keep.add(key);
                let row = section.rows.get(key);
                if (!row) {
                    let current = entry;
                    const target = (): AppResourceTarget => Object.freeze({ workspaceId: owner, kind, name: current.name, path: current.path });
                    const buttons: Array<{
                        control: Control<ButtonState>;
                        label: string;
                    }> = [];
                    const action = (label: string, task: () => ReturnType<NonNullable<ResourcesCallbacks['onRefresh']>>) => { const control = createButton({ label, onAction: () => active() ? task() : undefined, onError: message => surface.fail(message) }); buttons.push({ control, label }); return control; };
                    const actions: Control[] = [];
                    if (kind !== 'instructions')
                        actions.push(action(kind === 'template' ? 'Use template' : 'Use skill', () => callbacks.onUse?.(target())));
                    actions.push(action(kind === 'instructions' ? 'Edit workspace instructions' : 'Edit', () => callbacks.onEdit?.(target())));
                    if (kind !== 'template')
                        actions.push(action('Open', () => callbacks.onFileAction?.('open', target())), action('Reveal', () => callbacks.onFileAction?.('reveal', target())));
                    const line = createListRow({ title: entry.name, description: entry.description, meta: entry.path, icon: kind === 'template' ? undefined : 'file', actions: createActions({ children: actions }) });
                    const source = createText({ role: 'code', text: entry.content ?? '' });
                    row = { control: kind === 'instructions' ? createStack({ children: [line, createDisclosure({ title: 'View instructions', content: source })] }) : line, update(value) { current = value; line.update({ title: value.name, description: value.description, meta: value.path, icon: kind === 'template' ? undefined : 'file' }); source.update({ role: 'code', text: value.content ?? '' }); for (const item of buttons)
                            item.control.update({ label: item.label, disabled: state.busy }); } };
                    section.rows.set(key, row);
                }
                row.update(entry);
                items.push({ key, content: row.control });
            }
            section.list.update({ items });
            for (const key of section.rows.keys())
                if (!keep.has(key))
                    section.rows.delete(key);
        }
    }
    surface = hub.open('resources', 'Workspace resources · ' + initial.workspace.name, createStack({ children }), callbacks.onClose, () => { disposed = true; });
    render();
    return { ...surface, read: () => state, update(next) { if (active() && next.workspace.id === owner) {
            state = next;
            render();
        } }, fail(message) { if (active()) {
            state = { ...state, error: message };
            render();
        } } };
}
function openEditor(hub: SessionHub, initial: AppResourceEditorState, callbacks: ResourceEditorCallbacks): ResourceEditorSession {
    let state = initial, surface: Surface, disposed = false, localError = '';
    const identity = JSON.stringify([initial.workspaceId, initial.workspacePath, initial.kind, initial.path]), active = () => !disposed && !!surface?.isOpen();
    const name = !initial.path && initial.kind !== 'instructions' ? createTextInput({ label: 'Name', required: true, pattern: '[A-Za-z0-9]([A-Za-z0-9_]|-)*', placeholder: 'my-resource', value: initial.name ?? '' }) : undefined;
    const body = createTextArea({ label: 'Markdown', value: initial.content, readOnly: !initial.editable }), hint = createText({ role: 'description', text: '' });
    const read = (): ResourceDraft => ({ name: name?.read().trim() ?? initial.name ?? '', content: body.read() });
    let saved = read();
    const remove = createButton({ label: 'Delete resource', intent: 'danger', onAction: () => callbacks.onDelete?.(Object.freeze({ workspaceId: initial.workspaceId, kind: initial.kind, name: initial.name || initial.path?.split('/').pop() || '', path: initial.path || '' })), onError: message => { if (active())
            surface.fail(message); } }), removeSlot = createSlot({ content: remove, hidden: !initial.path || !initial.editable });
    const editable = initial.editable ? createForm({ children: [...(name ? [name] : []), body], submitLabel: 'Save', onSubmit: async () => { saved = read(); const result = await resultOf(() => callbacks.onSubmit?.(saved)); if (active() && result.ok)
            surface.close(); return result; }, onCancel: () => surface.close() }) : undefined;
    // Read-only editors keep native selection, without offering a write action.
    const content: Control = editable ?? createStack({ children: [...(name ? [name] : []), body, createButton({ label: 'Close', onAction: () => surface.close() })] });
    function render() { if (disposed)
        return; const blocked = !!state.disabled || state.workspaceBusy || !state.editable; body.update({ label: 'Markdown', readOnly: !state.editable || state.workspaceBusy, disabled: false }); name?.update({ label: 'Name', required: true, readOnly: !state.editable || state.workspaceBusy, disabled: false }); hint.update({ role: 'description', text: !state.editable ? state.workspaceBusy ? 'Stop this workspace’s task before editing resources.' : 'Inherited instructions are read-only here. Add workspace instructions to specialize them.' : '' }); editable?.update({ submitLabel: 'Save', submitDisabled: blocked, error: localError || state.error }); removeSlot.update({ hidden: !state.path || !state.editable }); remove.update({ label: 'Delete resource', intent: 'danger', disabled: blocked }); }
    surface = hub.open('feature', !initial.editable ? 'Workspace resource' : initial.path ? 'Edit workspace resource' : 'Create ' + initial.kind, createStack({ children: [createText({ role: 'code', text: initial.path || initial.workspacePath }), hint, content, removeSlot] }), callbacks.onClose, () => { saved = read(); disposed = true; });
    render();
    return { ...surface, read: () => active() ? read() : { ...saved }, update(next) { if (active() && JSON.stringify([next.workspaceId, next.workspacePath, next.kind, next.path]) === identity) {
            state = next;
            render();
        } }, fail(message) { if (active()) {
            localError = message;
            render();
        } } };
}
