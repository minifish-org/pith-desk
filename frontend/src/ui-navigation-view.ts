import { createIconButton, createDisclosure, createContextMenu, createText, createActions, createList, createListRow, createStack, createSlot } from 'pith-ui';
import type { Control, ButtonState, Disclosure, MenuItem } from 'pith-ui';
import type { NavigationState, WorkspaceAvailability, WorkspaceCallbacks, ApplicationConversation } from './ui-types';
import type { SessionHub } from './ui-sessions';
function actionMenu(label: string, hub: SessionHub) {
    const menu = createContextMenu({ label, items: [], onError: hub.report }), trigger = createIconButton({ label, icon: 'more', onAction: () => menu.open(trigger) });
    return { control: createActions({ children: [trigger, menu] }), close: menu.close, update(state: {
            label: string;
            items: readonly MenuItem[];
            disabled?: boolean;
        }) { menu.update({ label: state.label, items: state.items, disabled: state.disabled }); trigger.update({ label: state.label, icon: 'more', disabled: state.disabled || !state.items.length }); } };
}
type ItemMenu = ReturnType<typeof actionMenu>;
export function createNavigationView(hub: SessionHub, callbacks: WorkspaceCallbacks) {
    let renderSignature = '';
    let state: NavigationState = { groups: [], empty: 'workspaces' }, availability: WorkspaceAvailability = {}, query = '', activeConversation = '', destroyed = false;
    const list = createList({ items: [] }), empty = createText({ role: 'description', text: 'No workspaces yet.' }), content = createStack({ children: [list, empty] });
    type ConversationRow = {
        control: Control;
        visibility: ReturnType<typeof createSlot>;
        menu: ItemMenu;
        update(item: ApplicationConversation): void;
    };
    const rows = new Map<string, {
        control: Control;
        disclosure: Disclosure;
        list: ReturnType<typeof createList>;
        children: Map<string, ConversationRow>;
        menu: ItemMenu;
        add: Control<ButtonState>;
        visibility: ReturnType<typeof createSlot>;
    }>(), menus = new Set<ItemMenu>(), searchFolds = new Map<string, boolean>();
    function render() {
        if (destroyed)
            return;
        const signature = JSON.stringify([state, availability, query]);
        if (signature === renderSignature)
            return;
        renderSignature = signature;
        menus.clear();
        const keep = new Set<string>(), items: Array<{
            key: string;
            content: Control;
        }> = [];
        let visible = 0;
        const current = state.groups.flatMap(group => group.children.filter(item => item.active).map(item => ({ workspace: group.id, id: item.id })))[0], filter = query.trim().toLocaleLowerCase();
        for (const group of state.groups) {
            keep.add(group.id);
            let row = rows.get(group.id);
            if (!row) {
                const id = group.id, children = createList({ items: [] }), menu = actionMenu('Workspace actions for ' + group.name, hub), add = createIconButton({ label: 'New conversation in ' + group.name, icon: 'plus', onAction: () => callbacks.onNewConversation?.(id) }), disclosure = createDisclosure({ title: group.name, description: group.path, open: group.selected, content: children }), visibility = createSlot({ content: createStack({ children: [createActions({ align: 'between', children: [add, menu.control] }), disclosure] }) });
                row = { control: visibility, visibility, disclosure, list: children, children: new Map(), menu, add };
                rows.set(group.id, row);
            }
            menus.add(row.menu);
            const blocked = !!state.disabled || !!availability.busy || !!availability.workspaces?.includes(group.id);
            row.add.update({ label: 'New conversation in ' + group.name, icon: 'plus', disabled: blocked });
            row.disclosure.update({ title: group.name, description: group.path });
            row.menu.update({ label: 'Workspace actions for ' + group.name, items: group.canRemove ? [{ id: 'remove', label: 'Remove workspace', intent: 'danger', disabled: blocked, onAction: () => callbacks.onWorkspaceAction?.('remove', group.id) }] : [] });
            if (current?.workspace === group.id && current.id !== activeConversation)
                row.disclosure.setOpen(true);
            if (filter) {
                if (!searchFolds.has(group.id))
                    searchFolds.set(group.id, row.disclosure.isOpen());
                row.disclosure.setOpen(true);
            }
            else if (searchFolds.has(group.id)) {
                row.disclosure.setOpen(searchFolds.get(group.id)!);
                searchFolds.delete(group.id);
            }
            const keepChildren = new Set<string>(), childItems: Array<{
                key: string;
                content: Control;
            }> = [];
            let matched = 0;
            for (const conversation of group.children) {
                keepChildren.add(conversation.id);
                let child = row.children.get(conversation.id);
                if (!child) {
                    let value = conversation;
                    const id = conversation.id, menu = actionMenu('Conversation actions', hub), line = createListRow({ title: conversation.title || 'New conversation', onAction: () => callbacks.onSelectConversation?.(id), actions: menu.control }), visibility = createSlot({ content: line });
                    child = { control: visibility, visibility, menu, update(next) {
                            value = next;
                            const title = next.title || 'New conversation', status = next.status?.kind, label = status === 'approval' ? 'Waiting for approval' : status === 'running' ? 'Running' : status === 'unread' ? 'Completed, unread' : '';
                            line.update({ title, selected: next.active, meta: label, disabled: state.disabled || availability.busy });
                            const actions: MenuItem[] = [];
                            for (const [action, label] of [['rename', 'Rename'], ['history', 'Conversation branches'], ['export', 'Export Markdown'], ['delete', 'Delete']] as const)
                                if (value.actions?.[action])
                                    actions.push({ id: action, label, intent: action === 'delete' ? 'danger' : 'neutral', disabled: state.disabled || availability.busy || availability.conversations?.includes(id), onAction: () => callbacks.onConversationAction?.(action, id) });
                            menu.update({ label: 'Conversation actions for ' + title, items: actions });
                        } };
                    row.children.set(id, child);
                }
                menus.add(child.menu);
                child.update(conversation);
                const hidden = !!filter && !(conversation.title || 'New conversation').toLocaleLowerCase().includes(filter);
                if (!hidden)
                    matched++;
                child.visibility.update({ hidden });
                childItems.push({ key: conversation.id, content: child.control });
            }
            row.list.update({ items: childItems });
            for (const id of row.children.keys())
                if (!keepChildren.has(id))
                    row.children.delete(id);
            const hidden = !!filter && !matched;
            if (!hidden)
                visible++;
            row.visibility.update({ hidden });
            items.push({ key: group.id, content: row.control });
        }
        list.update({ items });
        for (const key of rows.keys())
            if (!keep.has(key)) {
                rows.delete(key);
                searchFolds.delete(key);
            }
        activeConversation = current?.id ?? '';
        empty.update({ role: 'description', text: visible ? '' : filter || state.empty === 'search' ? 'No conversations found.' : 'No workspaces yet.' });
    }
    return { content, update(next: NavigationState) { state = next; render(); }, search(value: string) { query = value; render(); callbacks.onSearch?.(value); }, availability(next: WorkspaceAvailability) { availability = next; render(); }, closeMenus() {
            for (const menu of menus)
                menu.close();
        }, destroy() { destroyed = true; rows.clear(); menus.clear(); searchFolds.clear(); } };
}
