import { createTextInput, createURLInput, createSecretInput, createSecretTextArea, createTextArea, createSelect, createCheckbox, createText, createNotice, createButton, createActions, createStack, createSlot, createDisclosure, createForm, createList } from 'pith-ui';
import type { Control, Input, Checkbox, ButtonState } from 'pith-ui';
import type { MCPConnectionsState, MCPCallbacks, MCPSession, MCPConnectionDraft, MCPConnectionItem, MCPEditorValue, MCPConnectionAction } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
export function openConnections(hub: SessionHub, initial: MCPConnectionsState, callbacks: MCPCallbacks): MCPSession {
    let state = initial, surface: Surface, disposed = false, editing: MCPEditorValue | undefined, revision = 0, localError = '';
    const active = () => !disposed && !!surface?.isOpen();
    const name = createTextInput({ label: 'Name', required: true, autocomplete: 'off', placeholder: 'my-tools' });
    const type = createSelect({ label: 'Connection type', value: 'http', options: [{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local command (stdio)' }], onChange: () => render() });
    const url = createURLInput({ label: 'Server URL', placeholder: 'https://example.com/mcp', autocomplete: 'off' });
    const oauth = createCheckbox({ label: 'Sign in with OAuth' }), client = createTextInput({ label: 'Registered client ID' }), scope = createTextInput({ label: 'Scopes' });
    const token = createSecretInput({ label: 'Bearer token (optional)', autocomplete: 'new-password', placeholder: 'Optional token' }), clearToken = createCheckbox({ label: 'Remove saved bearer token' }), clearTokenSlot = createSlot({ content: clearToken, hidden: true });
    const http = createSlot({ content: createStack({ children: [url, oauth, createDisclosure({ title: 'OAuth settings (optional)', content: createStack({ children: [client, scope, createText({ role: 'description', text: 'Uses the server’s OAuth discovery and PKCE. The temporary callback listens on 127.0.0.1:54819.' })] }) }), token, clearTokenSlot, createText({ role: 'description', text: 'Saved tokens are never returned to this page. Leave blank to keep a saved token.' })] }) });
    const command = createTextInput({ label: 'Installed executable', placeholder: '/path/to/mcp-server', autocomplete: 'off' }), args = createTextArea({ label: 'Arguments (JSON array)', value: '[]' }), env = createSecretTextArea({ label: 'Environment overrides (JSON object, optional)', autocomplete: 'off', placeholder: '{"API_KEY":"…"}', description: 'Values stay private. Leave blank to keep saved overrides. Use a JSON object of string keys and values to set individual overrides.' }), clearEnv = createCheckbox({ label: 'Clear saved environment overrides' }), clearEnvSlot = createSlot({ content: clearEnv, hidden: true }), envKeys = createText({ role: 'description', text: '' });
    const stdio = createSlot({ hidden: true, content: createStack({ children: [command, args, createText({ role: 'description', text: 'The executable and any runtime it needs must already be installed on your computer. Pith Desk does not bundle external runtimes or a marketplace.' }), env, envKeys, clearEnvSlot] }) });
    const enabled = createCheckbox({ label: 'Enable this connection', checked: true }), title = createText({ role: 'heading', text: 'Add connection' });
    const read = (): MCPConnectionDraft => ({ name: name.read().trim(), type: type.read() === 'stdio' ? 'stdio' : 'http', url: url.read().trim(), oauth: oauth.read(), oauthClientId: client.read().trim(), oauthScope: scope.read().trim(), command: command.read().trim(), args: args.read(), enabled: enabled.read(), bearerToken: token.read().trim(), clearBearerToken: clearToken.read(), env: env.read(), clearEnv: clearEnv.read() });
    let closed = read();
    const form = createForm({ children: [title, name, type, http, stdio, enabled], submitLabel: 'Save connection', onSubmit: async () => { const submittedRevision = revision; const result = await resultOf(() => callbacks.onSubmit?.(read())); if (active() && submittedRevision === revision && !result.ok) {
            localError = result.error;
            render();
        } return result; }, onCancel: () => surface.close() });
    const rows = new Map<string, {
        control: Control;
        update(item: MCPConnectionItem): void;
    }>(), list = createList({ items: [] }), empty = createSlot({ content: createText({ role: 'description', text: 'No connections yet. Add an HTTP server or an installed local MCP command below. Tools are discovered on demand using tool search and Codemode.' }) }), listError = createNotice({ tone: 'error', message: '' });
    let entries: readonly MCPConnectionItem[] = [];
    function renderRows(): void {
        const keep = new Set<string>(), items: Array<{
            key: string;
            content: Control;
        }> = [];
        for (const item of entries) {
            keep.add(item.name);
            let row = rows.get(item.name);
            if (!row) {
                const target = Object.freeze({ name: item.name }), heading = createText({ role: 'heading', text: item.name }), address = createText({ role: 'code', text: '' }), status = createNotice({ tone: 'info', message: '' }), saved = createText({ role: 'description', text: '' }), error = createNotice({ tone: 'error', message: '' });
                let current = item, local = '';
                const action = (action: MCPConnectionAction, label: string, danger = false) => createButton({ label, intent: danger ? 'danger' : 'neutral', onAction: () => { local = ''; error.update({ message: current.error ?? '', tone: 'error' }); return active() ? callbacks.onConnectionAction?.(action, target) : undefined; }, onError: message => { if (active()) {
                        local = message;
                        error.update({ message, tone: 'error' });
                    } } });
                const login = action('mcp-login', 'Sign in'), logout = action('mcp-logout', 'Sign out'), edit = action('mcp-edit', 'Edit'), toggle = action('mcp-toggle', 'Disable'), remove = action('mcp-remove', 'Delete', true), loginSlot = createSlot({ content: login, hidden: true }), logoutSlot = createSlot({ content: logout, hidden: true });
                row = { control: createStack({ children: [heading, address, saved, status, error, createActions({ children: [loginSlot, logoutSlot, edit, toggle, remove] })] }), update(next) { current = next; address.update({ text: next.type === 'http' ? next.url ?? '' : [next.command, ...next.args ?? []].join(' '), role: 'code' }); saved.update({ role: 'description', text: [next.enabled ? 'Enabled' : 'Disabled', next.hasBearerToken ? 'Token configured' : '', next.envKeys?.length ? 'Saved environment keys: ' + next.envKeys.join(', ') : ''].filter(Boolean).join(' · ') }); status.update({ message: next.statusLabel, tone: next.enabled && next.status === 'error' ? 'error' : 'info' }); error.update({ message: next.error || local, tone: 'error' }); loginSlot.update({ hidden: !next.oauth }); logoutSlot.update({ hidden: !next.oauth || !next.signedIn }); login.update({ label: next.signedIn ? 'Sign in again' : 'Sign in', disabled: state.disabled || !next.oauth }); logout.update({ label: 'Sign out', disabled: state.disabled || !next.oauth || !next.signedIn }); edit.update({ label: 'Edit', disabled: state.disabled }); toggle.update({ label: next.enabled ? 'Disable' : 'Enable', disabled: state.disabled }); remove.update({ label: 'Delete', intent: 'danger', disabled: state.disabled }); } };
                rows.set(item.name, row);
            }
            row.update(item);
            items.push({ key: item.name, content: row.control });
        }
        list.update({ items });
        for (const key of rows.keys())
            if (!keep.has(key))
                rows.delete(key);
        empty.update({ hidden: entries.length > 0 });
    }
    function render(): void {
        if (disposed)
            return;
        const isHTTP = type.read() === 'http', disabled = false;
        http.update({ hidden: !isHTTP });
        stdio.update({ hidden: isHTTP });
        name.update({ label: 'Name', required: true, readOnly: !!editing, disabled });
        type.update({ label: 'Connection type', options: [{ value: 'http', label: 'HTTP' }, { value: 'stdio', label: 'Local command (stdio)' }], disabled });
        url.update({ label: 'Server URL', required: isHTTP, disabled: disabled || !isHTTP, placeholder: 'https://example.com/mcp' });
        command.update({ label: 'Installed executable', required: !isHTTP, disabled: disabled || isHTTP, placeholder: '/path/to/mcp-server' });
        for (const [field, label] of [[client, 'Registered client ID'], [scope, 'Scopes'], [token, 'Bearer token (optional)']] as const)
            field.update({ label, disabled: disabled || !isHTTP });
        oauth.update({ label: 'Sign in with OAuth', disabled: disabled || !isHTTP });
        clearToken.update({ label: 'Remove saved bearer token', disabled: disabled || !isHTTP });
        args.update({ label: 'Arguments (JSON array)', disabled: disabled || isHTTP });
        env.update({ label: 'Environment overrides (JSON object, optional)', disabled: disabled || isHTTP });
        clearEnv.update({ label: 'Clear saved environment overrides', disabled: disabled || isHTTP });
        enabled.update({ label: 'Enable this connection', disabled });
        form.update({ submitLabel: 'Save connection', submitDisabled: state.disabled, error: localError || state.formError });
        listError.update({ tone: 'error', message: state.error ?? '' });
        renderRows();
    }
    function edit(value?: Readonly<MCPEditorValue>): void { if (!active())
        return; revision++; form.resetSubmission(); editing = value; localError = ''; state = { ...state, formError: '' }; title.update({ role: 'heading', text: value ? 'Edit ' + value.name : 'Add connection' }); name.reset(value?.name ?? ''); type.reset(value?.type === 'stdio' ? 'stdio' : 'http'); url.reset(value?.url ?? ''); oauth.reset(value?.oauth ?? false); client.reset(value?.oauthClientId ?? ''); scope.reset(value?.oauthScope ?? ''); command.reset(value?.command ?? ''); args.reset(JSON.stringify(value?.args ?? [], null, 2)); enabled.reset(value?.enabled ?? true); token.reset(''); env.reset(''); clearToken.reset(false); clearEnv.reset(false); clearTokenSlot.update({ hidden: !value?.hasBearerToken }); clearEnvSlot.update({ hidden: !value?.envKeys?.length }); envKeys.update({ role: 'description', text: value?.envKeys?.length ? 'Saved environment keys: ' + value.envKeys.join(', ') : '' }); render(); (value ? value.type === 'stdio' ? command : url : name).focus(); }
    const refresh = createButton({ label: 'Refresh', onAction: () => callbacks.onRefresh?.(), onError: message => surface.fail(message) }), add = createButton({ label: 'New connection', onAction: () => callbacks.onNew ? callbacks.onNew() : edit() });
    surface = hub.open('connections', 'Connections', createStack({ children: [createText({ role: 'description', text: 'Add an MCP server to give Pith access to its tools. Enabled connections connect automatically when a task starts. External tools require approval unless this conversation has full access.' }), createActions({ children: [refresh, add] }), listError, list, empty, form] }), callbacks.onClose, () => { closed = { ...read(), bearerToken: '', env: '' }; token.reset(''); env.reset(''); disposed = true; revision++; });
    render();
    return { ...surface, update(next) { if (active()) {
            state = next;
            render();
        } }, read: () => active() ? read() : { ...closed }, edit, setConnections(next) { if (active()) {
            entries = next;
            renderRows();
        } }, clearBearerToken() { token.reset(''); closed.bearerToken = ''; }, clearSecrets() { token.reset(''); env.reset(''); closed.bearerToken = ''; closed.env = ''; }, fail(message) { if (active()) {
            state = { ...state, error: message };
            render();
        } } };
}
