import { createText, createButton, createCopyButton, createActions, createStack, createList, createListRow, createPopover, createSlot, createNotice, createDocument, createImage } from 'pith-ui';
import type { Control, ButtonState, CopyButtonState, DocumentState, ImageControl } from 'pith-ui';
import type { AppArtifactsState, ArtifactsCallbacks, AppFileTarget, AppFileAction, FilesScene, FilePreviewInput, FilePreviewCallbacks, FilePreviewSession, AppFilePreviewState } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
export function createFilesView(hub: SessionHub) {
    let state: AppArtifactsState = { ownerId: '', files: [], loading: false, error: '', copyMode: 'path' }, callbacks: ArtifactsCallbacks = {}, disposed = false;
    const rows = new Map<string, {
        control: Control;
        update(): void;
    }>(), list = createList({ items: [] }), status = createNotice({ message: '', tone: 'info' }), error = createNotice({ message: '', tone: 'error' });
    const popover = createPopover({ label: 'Conversation files', content: createStack({ children: [createText({ role: 'heading', text: 'Files' }), createButton({ label: 'Close files', onAction: () => popover.close() }), status, error, list] }) }), header = createSlot({ content: popover, hidden: true });
    function render() {
        if (disposed)
            return;
        header.update({ hidden: !state.ownerId || !state.files.length && !state.error });
        popover.update({ label: state.error ? 'Conversation files unavailable' : `Conversation files (${state.files.length} ${state.files.length === 1 ? 'file' : 'files'})` });
        status.update({ message: state.loading ? 'Looking for files…' : '', tone: 'info' });
        error.update({ message: state.error, tone: 'error' });
        const keep = new Set<string>(), items: Array<{
            key: string;
            content: Control;
        }> = [];
        for (const file of state.files) {
            const key = JSON.stringify([state.ownerId, file.path]);
            keep.add(key);
            let row = rows.get(key);
            if (!row) {
                const target: AppFileTarget = Object.freeze({ owner: Object.freeze({ kind: 'artifact', id: state.ownerId }), name: file.name, path: file.path }), owner = state.ownerId;
                const active = () => !disposed && state.ownerId === owner && rows.has(key), fail = (message: string) => { if (active()) {
                    state = { ...state, error: message };
                    render();
                } };
                const buttons: Array<{
                    control: Control<ButtonState>;
                    label: string;
                }> = [];
                const action = (label: string, task: () => ReturnType<NonNullable<ArtifactsCallbacks['onPreview']>>) => { const control = createButton({ label, onAction: () => active() ? task() : undefined, onError: fail }); buttons.push({ control, label }); return control; };
                const preview = action('Preview', () => callbacks.onPreview?.(target)), open = action('Open', () => callbacks.onFileAction?.('open', target)), reveal = action('Reveal', () => callbacks.onFileAction?.('reveal', target));
                const copy = createCopyButton({ value: target.path, label: 'Copy path', onCopy: () => active() ? resultOf(() => callbacks.onFileAction?.(state.copyMode === 'file' ? 'copy' : 'copy-path', target)) : Promise.resolve({ ok: false, error: 'File target changed.' }), onError: fail });
                row = { control: createListRow({ title: file.name, meta: file.path, icon: 'file', actions: createActions({ children: [preview, open, reveal, copy] }) }), update() { for (const item of buttons)
                        item.control.update({ label: item.label, disabled: state.disabled }); copy.update({ value: target.path, label: state.copyMode === 'file' ? 'Copy file' : 'Copy path', disabled: state.disabled }); } };
                rows.set(key, row);
            }
            row.update();
            items.push({ key, content: row.control });
        }
        list.update({ items });
        for (const key of rows.keys())
            if (!keep.has(key))
                rows.delete(key);
    }
    const api: FilesScene = { updateArtifacts(next, nextCallbacks) { if (disposed)
            return; if (next.ownerId !== state.ownerId)
            popover.close(); state = next; if (nextCallbacks)
            callbacks = nextCallbacks; render(); }, closeArtifacts: () => popover.close(), areArtifactsOpen: () => !disposed && popover.isOpen(), openPreview: (input, callbacks = {}) => openPreview(hub, input, callbacks), destroy() { disposed = true; popover.close(); rows.clear(); } };
    return { api, header };
}
function openPreview(hub: SessionHub, input: FilePreviewInput, callbacks: FilePreviewCallbacks): FilePreviewSession {
    let state: AppFilePreviewState = input.content ?? { kind: 'text' }, surface: Surface, disposed = false, kind = state.kind;
    const target: AppFileTarget = Object.freeze({ owner: Object.freeze({ ...input.owner }), name: input.name, path: input.path }), active = () => !disposed && !!surface?.isOpen();
    const error = createNotice({ message: '', tone: 'error' }), truncated = createText({ text: '', role: 'description' }), body = createSlot();
    let textDocument: Control<DocumentState> | undefined, image: ImageControl | undefined;
    const fail = (message: string) => { if (active()) {
        state = { ...state, error: message };
        render();
    } };
    const buttons: Array<{
        control: Control<ButtonState>;
        label: string;
    }> = [], actions: Control[] = [];
    for (const [action, label] of [['open', 'Open'], ['reveal', 'Reveal']] as const) {
        if (input.capabilities[action] === false)
            continue;
        const control = createButton({ label, onAction: () => active() ? callbacks.onFileAction?.(action, target) : undefined, onError: fail });
        buttons.push({ control, label });
        actions.push(control);
    }
    const copy = input.capabilities.copyMode && input.capabilities.copyMode !== 'none' ? createCopyButton({ value: input.path, label: input.capabilities.copyMode === 'file' ? 'Copy file' : 'Copy path', onCopy: () => resultOf(() => callbacks.onFileAction?.(input.capabilities.copyMode === 'file' ? 'copy' : 'copy-path', target)), onError: fail }) : undefined;
    if (copy)
        actions.push(copy);
    const codeCopy = (text: string) => callbacks.onCopyCode ? resultOf(() => callbacks.onCopyCode!(text)) : hub.copy(text);
    function render() {
        if (disposed)
            return;
        error.update({ message: state.error ?? '', tone: 'error' });
        truncated.update({ role: 'description', text: state.truncated ? 'Preview is truncated. Open the file to see all content.' : '' });
        if (kind !== state.kind || !textDocument && !image) {
            kind = state.kind;
            textDocument = undefined;
            image = undefined;
            if (kind === 'image') {
                image = createImage({ source: state.imageSrc ?? '', label: state.imageAlt ?? input.name });
                body.set(image);
            }
            else {
                textDocument = createDocument({ text: state.text ?? '', format: kind, disabled: state.disabled, onCopy: codeCopy, onError: fail });
                body.set(textDocument);
            }
        }
        if (image)
            image.update({ source: state.imageSrc ?? '', label: state.imageAlt ?? input.name });
        textDocument?.update({ text: state.text ?? '', format: state.kind === 'image' ? 'text' : state.kind, disabled: state.disabled });
        for (const item of buttons)
            item.control.update({ label: item.label, disabled: state.disabled });
        copy?.update({ value: input.path, label: input.capabilities.copyMode === 'file' ? 'Copy file' : 'Copy path', disabled: state.disabled });
    }
    surface = hub.open('preview', input.name, createStack({ children: [createText({ text: input.path, role: 'code' }), createActions({ children: actions }), error, body, truncated, createButton({ label: 'Close', onAction: () => surface.close() })] }), callbacks.onClose, () => { disposed = true; });
    render();
    return { ...surface, update(next) { if (active()) {
            state = next;
            render();
        } }, fail };
}
