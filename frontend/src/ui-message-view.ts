import { createText, createMarkdown, createMessage, createImage, createStack, createActions, createCopyButton, createIconButton, createDisclosure, createSlot, createList, createCollectionState, createStatus } from 'pith-ui';
import type { Control, ReadingItem, ImageControl, Disclosure, ButtonState, CopyButtonState } from 'pith-ui';
import type { ConversationMessage, ConversationState, ConversationActionAvailability, WorkspaceCallbacks, ConversationAction } from './ui-types';
import { resultOf, type SessionHub } from './ui-sessions';
export function createMessageView(hub: SessionHub, callbacks: WorkspaceCallbacks) {
    let renderRevision = 0, disabledSignature = '';
    let activeId = '', destroyed = false, generation = 0, busy = false, disabled: ConversationActionAvailability = {};
    type MessageRow = {
        control: Control;
        body: Control;
        current: ConversationMessage;
        parent: string;
        revision: string;
        version: number;
        update(message: ConversationMessage): void;
        images?: Map<number, ImageControl>;
        buttons: Array<{
            action: ConversationAction['action'];
            control: Control<ButtonState> | Control<CopyButtonState>;
            label: string;
            value?: string;
        }>;
    };
    const rows = new Map<string, MessageRow>(), groups = new Map<string, {
        control: Control;
        disclosure: Disclosure;
        status: ReturnType<typeof createStatus>;
        statusSlot: ReturnType<typeof createSlot>;
        list: ReturnType<typeof createList>;
        members: Set<string>;
        revision: string;
        version: number;
    }>(), folds = new Map<string, Map<string, boolean>>(), blobs = new Map<string, Promise<string | null>>(), urls = new Set<string>();
    const fail = (message: string) => callbacks.onError?.(message), remember = (key: string, open: boolean) => {
        let map = folds.get(activeId);
        if (!map) {
            map = new Map();
            folds.set(activeId, map);
        }
        map.set(key, open);
    };
    function clear() {
        generation++;
        for (const row of rows.values())
            for (const image of row.images?.values() ?? [])
                image.close();
        for (const url of urls)
            URL.revokeObjectURL(url);
        urls.clear();
        blobs.clear();
        rows.clear();
        groups.clear();
    }
    const load = (row: MessageRow, message: ConversationMessage) => {
        for (const image of message.images ?? []) {
            const view = row.images?.get(image.index);
            if (!view)
                continue;
            const id = activeId, token = generation, key = JSON.stringify([id, message.id, image.index]);
            let pending = blobs.get(key);
            if (!pending) {
                pending = Promise.resolve().then(() => callbacks.onLoadImage?.(Object.freeze({ conversationId: id, messageId: message.id, index: image.index }))).then(blob => {
                    if (!blob || destroyed || generation !== token || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type))
                        return null;
                    const url = URL.createObjectURL(blob);
                    urls.add(url);
                    return url;
                }).catch(() => null);
                blobs.set(key, pending);
            }
            void pending.then(source => {
                if (destroyed || generation !== token || activeId !== id || rows.get(message.id) !== row)
                    return;
                view.update({ source: source ?? '', label: source ? 'Image ' + (image.index + 1) : 'Image unavailable' });
                if (!source && blobs.get(key) === pending)
                    blobs.delete(key);
            });
        }
    };
    function make(message: ConversationMessage): MessageRow {
        const id = activeId, body = message.role === 'assistant' ? createMarkdown({ text: message.text, onLink: hub.external, onCopy: text => callbacks.onCopyCode ? resultOf(() => callbacks.onCopyCode!(text)) : hub.copy(text), resolveLink: url => { const target = callbacks.resolveLocalLink?.(url, id); return target ? JSON.stringify(target) : undefined; }, onLocalLink: key => {
                const target = JSON.parse(key) as {
                    path: string;
                    conversationId: string;
                };
                return callbacks.onLocalFile?.(target);
            }, onError: fail }) : createText({ text: message.text, role: message.role === 'tool' ? 'code' : 'body' });
        const actionSlot = message.role === 'tool' ? undefined : createSlot(), buttons: MessageRow['buttons'] = [];
        let images: Map<number, ImageControl> | undefined;
        let current = message, actionSignature = '';
        const command = message.role === 'tool' ? createText({ text: '', role: 'code' }) : undefined, commandSlot = command ? createSlot({ content: command, hidden: true }) : undefined;
        const status = message.role === 'tool' ? createStatus({ label: '', tone: 'neutral' }) : undefined, statusSlot = status ? createSlot({ content: status }) : undefined;
        const content = createList({ items: [...(commandSlot ? [{ key: 'command', content: commandSlot }] : []), { key: 'body', content: body }] });
        const tool = message.role === 'tool' ? createDisclosure({ title: message.toolName || 'Tool result', open: folds.get(id)?.get('tool:' + message.id) ?? false, onToggle: open => remember('tool:' + message.id, open), content }) : undefined;
        const frame = tool ? createStack({ children: [statusSlot!, tool] }) : createMessage({ role: ['user', 'assistant', 'system'].includes(message.role) ? message.role as 'user' | 'assistant' | 'system' : 'assistant', content, actions: actionSlot });
        const row: MessageRow = { control: frame, body, current: message, parent: '', revision: '', version: 0, images, buttons, update(next) {
                current = next;
                row.current = next;
                if (next.role === 'assistant')
                    (body as ReturnType<typeof createMarkdown>).update({ text: next.text, disabled: busy });
                else
                    (body as ReturnType<typeof createText>).update({ text: next.text, role: next.role === 'tool' ? 'code' : 'body' });
                commandSlot?.update({ hidden: !next.command });
                command?.update({ role: 'code', text: next.command ? `Command\n${next.command.text}\nDirectory\n${next.command.cwd}\n${next.command.exitCode === undefined ? '' : 'Exit ' + next.command.exitCode}` : '' });
                if (next.role === 'tool') {
                    status!.update({ label: next.command ? (next.status === 'error' ? 'Failed' : next.status === 'done' ? 'Completed' : next.status === 'running' ? 'Running' : next.status ?? 'Result') : next.status ?? 'Result', tone: next.status === 'error' ? 'error' : 'neutral' });
                    const label = (next.command ? 'Command' : next.toolName || 'Tool result') + ' · ' + (next.status === 'error' ? 'Failed' : next.status === 'done' ? 'Completed' : next.status === 'running' ? 'Running' : next.status || 'Result') + (next.command?.exitCode === undefined ? '' : ' · Exit ' + next.command.exitCode);
                    tool!.update({ title: label });
                }
                else {
                    const date = new Date(next.timestamp ?? NaN);
                    (frame as ReturnType<typeof createMessage>).update({ role: next.role as 'user' | 'assistant' | 'system', time: Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined, status: next.role === 'assistant' && next.status === 'error' ? 'Response interrupted' : undefined });
                }
                const keep = new Set<number>(), items: Array<{
                    key: string;
                    content: Control;
                }> = [];
                for (const image of next.images ?? []) {
                    keep.add(image.index);
                    let view = images?.get(image.index);
                    if (!view) {
                        view = createImage({ label: 'Image ' + (image.index + 1), source: '' });
                        (images ??= new Map()).set(image.index, view);
                        row.images = images;
                    }
                    items.push({ key: String(image.index), content: view });
                }
                content.update({ items: [...(commandSlot ? [{ key: 'command', content: commandSlot }] : []), { key: 'body', content: body }, ...items.map(item => ({ ...item, key: 'image:' + item.key }))] });
                for (const index of images?.keys() ?? [])
                    if (!keep.has(index))
                        images!.delete(index);
                const signature = JSON.stringify(next.actions ?? {});
                if (next.role !== 'tool' && signature !== actionSignature) {
                    actionSignature = signature;
                    buttons.length = 0;
                    const actions: Control[] = [];
                    if (next.actions?.copy) {
                        const label = typeof next.actions.copy === 'string' ? next.actions.copy : 'Copy message', control = createCopyButton({ value: next.id, label, onCopy: () => callbacks.onMessageAction ? resultOf(() => callbacks.onMessageAction!({ action: 'copy', messageId: current.id })) : hub.copy(current.text), onError: fail });
                        buttons.push({ action: 'copy', control, label, value: next.id });
                        actions.push(control);
                    }
                    for (const action of ['edit', 'branch'] as const) {
                        if (!next.actions?.[action])
                            continue;
                        const branch = next.actions.branch, label = action === 'edit' ? 'Edit message' : branch?.label || 'Branch from this message', control = createIconButton({ label, icon: action, onAction: () => callbacks.onMessageAction?.({ action, messageId: current.id, branchKey: action === 'branch' ? current.actions?.branch?.key : undefined }), onError: fail });
                        buttons.push({ action, control, label });
                        actions.push(control);
                    }
                    actionSlot!.set(actions.length ? createActions({ children: actions }) : undefined);
                }
                syncRow(row);
                load(row, next);
            } };
        return row;
    }
    function syncRow(row: MessageRow) {
        for (const button of row.buttons) {
            if (button.action === 'copy')
                (button.control as Control<CopyButtonState>).update({ value: button.value!, label: button.label, disabled: busy || disabled.copy });
            else
                (button.control as Control<ButtonState>).update({ label: button.label, icon: button.action, disabled: disabled[button.action] });
        }
    }
    return {
        update(state: ConversationState): ReadingItem[] {
            if (state.id !== activeId) {
                clear();
                activeId = state.id;
            }
            const items: ReadingItem[] = [], keepRows = new Set<string>(), keepGroups = new Set<string>();
            const get = (message: ConversationMessage, parent = '') => {
                keepRows.add(message.id);
                let row = rows.get(message.id);
                if (row && (row.parent !== parent || row.current.role !== message.role)) {
                    row.control.destroy();
                    rows.delete(message.id);
                    row = undefined;
                }
                if (!row) {
                    row = make(message);
                    row.parent = parent;
                    rows.set(message.id, row);
                }
                const revision = JSON.stringify(message);
                if (row.revision !== revision) {
                    row.update(message);
                    row.revision = revision;
                    row.version = ++renderRevision;
                }
                return row;
            };
            for (let i = 0; i < state.messages.length;) {
                const message = state.messages[i];
                if (message.role !== 'tool') {
                    const row = get(message);
                    items.push({ key: message.id, revision: String(row.version), content: row.control });
                    i++;
                    continue;
                }
                const tools: ConversationMessage[] = [];
                while (i < state.messages.length && state.messages[i].role === 'tool')
                    tools.push(state.messages[i++]);
                const members = new Set(tools.map(item => item.id)), retained = [...groups].find(([key, group]) => !keepGroups.has(key) && [...members].some(id => group.members.has(id)));
                let key = retained?.[0] ?? 'tools:' + tools[0].id;
                for (let suffix = 2; !retained && (groups.has(key) || keepGroups.has(key)); suffix++)
                    key = 'tools:' + tools[0].id + ':' + suffix;
                keepGroups.add(key);
                let group = groups.get(key);
                if (!group) {
                    const list = createList({ items: [] });
                    const disclosure = createDisclosure({ title: 'Used tools', open: folds.get(activeId)?.get(key) ?? false, onToggle: open => remember(key, open), content: list }), status = createStatus({ label: '', tone: 'error' }), statusSlot = createSlot({ content: status, hidden: true });
                    group = { list, members, disclosure, status, statusSlot, revision: '', version: 0, control: createStack({ children: [statusSlot, disclosure] }) };
                    groups.set(key, group);
                }
                group.members = members;
                group.list.update({ items: tools.map(tool => ({ key: tool.id, content: get(tool, key).control })) });
                const running = tools.filter(tool => tool.status === 'running').length, failed = tools.filter(tool => tool.status === 'error').length;
                const label = tools.every(tool => tool.toolName === 'run_command') ? (tools.length === 1 ? 'Ran a command' : 'Ran commands') : tools.every(tool => ['list_files', 'read_file', 'grep', 'find', 'ls', 'run_command'].includes(tool.toolName ?? '')) ? 'Explored files' : 'Used tools';
                group.status.update({ label: failed + ' failed', tone: 'error' });
                group.statusSlot.update({ hidden: !failed });
                group.disclosure.update({ title: `${label} · ${tools.length} ${tools.length === 1 ? 'call' : 'calls'}${failed ? ' · ' + failed + ' failed' : ''}${running ? ' · ' + running + ' running' : ''}` });
                const revision = JSON.stringify(tools);
                if (revision !== group.revision) {
                    group.revision = revision;
                    group.version = ++renderRevision;
                }
                items.push({ key, revision: String(group.version), content: group.control });
            }
            if (state.working) {
                let row = rows.get('__working');
                if (!row) {
                    const loading = createCollectionState({ status: 'loading', message: 'Working…' });
                    row = { control: loading, body: loading, current: { id: '__working', role: 'system', text: '' }, parent: '', revision: '', version: 0, update() { }, buttons: [] };
                    rows.set('__working', row);
                }
                keepRows.add('__working');
                items.push({ key: '__working', revision: 'working', content: row.control });
            }
            for (const key of rows.keys())
                if (!keepRows.has(key))
                    rows.delete(key);
            for (const key of groups.keys())
                if (!keepGroups.has(key))
                    groups.delete(key);
            return items;
        }, setBusy(value: boolean) {
            if (busy === value)
                return;
            busy = value;
            rows.forEach(row => {
                syncRow(row);
                if (row.current.role === 'assistant')
                    (row.body as ReturnType<typeof createMarkdown>).update({ text: row.current.text, disabled: busy });
            });
        }, setAvailability(state: ConversationActionAvailability) {
            const signature=JSON.stringify(state);
            if(signature===disabledSignature)return;
            disabledSignature=signature;disabled={...state};
            rows.forEach(syncRow);
        }, prune(ids: readonly string[]) {
            const keep = new Set(ids);
            for (const key of folds.keys())
                if (!keep.has(key))
                    folds.delete(key);
        }, destroy() { destroyed = true; clear(); folds.clear(); },
    };
}
