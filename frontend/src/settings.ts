import { createSettingsPanel, createMCPConnectionsPanel, createMCPConnectionList, createModelPicker, createModelEditor, thinkingLabel } from 'pith-ui';
import type { ApiMutate, ApiRequest } from './api.ts';
import type { AppearanceMode, MCPServerView as MCPConnection, ModelCatalog, ProviderChoice } from './contract.generated.ts';
import { setControlPending } from './controls.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { escape } from './ui.ts';
import { mountUpdates } from './updates.ts';
type API = {
    view: AppView;
    activity: UIActivity;
    request: ApiRequest;
    mutate: ApiMutate;
    render: () => void;
    closeSidebar: () => void;
    showDialog: (id: string) => void;
    anyRunning: () => boolean;
    appearanceMode: (value: unknown) => AppearanceMode;
    applyAppearance: (mode: AppearanceMode) => void;
    providerActions: (provider: ProviderChoice) => string;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
export function createSettingsUI(api: API) {
    const { view: app, activity, request, mutate, render, closeSidebar, showDialog, anyRunning, appearanceMode, applyAppearance } = api;
    const sdkUI = { providerActions: api.providerActions };
    let settingsPanel: ReturnType<typeof createSettingsPanel> | undefined;
    let connectionsPanel: ReturnType<typeof createMCPConnectionsPanel> | undefined;
    let connectionsList: ReturnType<typeof createMCPConnectionList> | undefined;
    let modelPicker: ReturnType<typeof createModelPicker> | undefined;
    let modelEditor: ReturnType<typeof createModelEditor> | undefined;
    let settingsUpdates: ReturnType<typeof mountUpdates> | undefined;
    let connectionProbe: AbortController | null = null;
    let refreshSettingsAuth: ((provider: string) => void) | null = null;
    let mcpConnections: MCPConnection[] = [];
    let mcpRequest = 0;
    let mcpEditorGeneration = 0;
    function renderAppearance(): void {
        const mode = appearanceMode(app.state.settings.appearance);
        applyAppearance(mode);
        const selector = document.getElementById('appearance-mode') as HTMLSelectElement | null;
        if (selector) {
            selector.value = mode;
            selector.disabled = activity.busy || !app.loaded;
        }
    }
    function openConnections(): void {
        connectionsList?.destroy(); connectionsList = undefined;
        connectionsPanel?.destroy();
        connectionsPanel = createMCPConnectionsPanel({}, {idPrefix: ''});
        $('connections-content').replaceChildren(connectionsPanel.element);
        showDialog('connections-dialog');
        $('mcp-form').addEventListener('submit', (event) => { event.preventDefault(); void saveMCP(); });
        renderMCPType();
        render();
        void loadMCP();
    }
    function renderMCPType(): void { connectionsPanel?.renderType(); }
    async function loadMCP(): Promise<void> {
        const sequence = ++mcpRequest;
        $('mcp-error').textContent = '';
        try {
            const result = await request('/api/mcp');
            if (sequence !== mcpRequest)
                return;
            mcpConnections = result || [];
            renderMCPList();
            render();
        }
        catch (error) {
            if (sequence === mcpRequest)
                $('mcp-error').textContent = error instanceof Error ? error.message : String(error);
        }
    }
    function mcpStatusLabel(entry: MCPConnection): string {
        if (!entry.enabled)
            return 'Will not be used by tasks';
        if (entry.status === 'connected')
            return `Connected · ${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}`;
        if (entry.status === 'connecting')
            return 'Connecting…';
        if (entry.status === 'error')
            return 'Connection failed';
        return 'Connects automatically when a task starts';
    }
    function renderMCPList(): void {
        const state = {entries: mcpConnections.map((entry) => ({...entry, args: entry.args || [], envKeys: entry.envKeys || [], statusLabel: mcpStatusLabel(entry)}))};
        if (connectionsList) connectionsList.update(state);
        else {connectionsList = createMCPConnectionList(state); $('mcp-list').replaceChildren(connectionsList.element);}    }
    function editMCP(entry?: MCPConnection): void {
        mcpEditorGeneration++;
        connectionsPanel?.edit(entry ? {...entry, args: entry.args || [], envKeys: entry.envKeys || []} : undefined);
    }
    function parseConnectionJSON(value: string, label: string): unknown {
        try {
            return JSON.parse(value);
        }
        catch {
            throw new Error(`Enter valid JSON for ${label}.`);
        }
    }
    async function saveMCP(): Promise<void> {
        if (activity.busy || anyRunning())
            return;
        const originalForm = $<HTMLFormElement>('mcp-form');
        const generation = mcpEditorGeneration;
        const isCurrent = () => $<HTMLDialogElement>('connections-dialog').open && document.getElementById('mcp-form') === originalForm && mcpEditorGeneration === generation;
        $('mcp-form-error').textContent = '';
        try {
            const name = $<HTMLInputElement>('mcp-name').value.trim();
            const type = $<HTMLSelectElement>('mcp-type').value === 'stdio' ? 'stdio' : 'http';
            const args: unknown = type === 'stdio' ? parseConnectionJSON($<HTMLTextAreaElement>('mcp-args').value || '[]', 'arguments') : [];
            if (!Array.isArray(args) || !args.every((value) => typeof value === 'string'))
                throw new Error('Arguments must be a JSON array of strings.');
            const envDraft = $<HTMLTextAreaElement>('mcp-env').value.trim();
            const env: unknown = type === 'stdio' && envDraft ? parseConnectionJSON(envDraft, 'environment overrides') : undefined;
            if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((value) => typeof value === 'string')))
                throw new Error('Environment overrides must be a JSON object with string values.');
            const bearerToken = $<HTMLInputElement>('mcp-token').value.trim();
            const payload = { name, type, args, oauth: false, enabled: $<HTMLInputElement>('mcp-enabled').checked, ...(type === 'http' ? { oauth: $<HTMLInputElement>('mcp-oauth').checked, oauthClientId: $<HTMLInputElement>('mcp-oauth-client').value.trim(), oauthScope: $<HTMLInputElement>('mcp-oauth-scope').value.trim(), url: $<HTMLInputElement>('mcp-url').value.trim(), ...(bearerToken ? { bearerToken } : {}), ...($<HTMLInputElement>('mcp-clear-token').checked ? { clearBearerToken: true } : {}) } : { command: $<HTMLInputElement>('mcp-command').value.trim(), ...(env !== undefined ? { env: env as Record<string, string> } : {}), ...($<HTMLInputElement>('mcp-clear-env').checked ? { clearEnv: true } : {}) }) };
            const saved = await mutate('/api/mcp/save', payload);
            if (!isCurrent())
                return;
            $<HTMLInputElement>('mcp-token').value = '';
            if (!saved)
                $('mcp-form-error').textContent = activity.error;
            else {
                $<HTMLTextAreaElement>('mcp-env').value = '';
                await loadMCP();
                if (isCurrent())
                    editMCP(mcpConnections.find((entry) => entry.name === name));
            }
        }
        catch (error) {
            if (isCurrent())
                $('mcp-form-error').textContent = error instanceof Error ? error.message : String(error);
        }
    }
    function modelFormSelection(prefix: string): {
        provider: string;
        model: string;
        thinkingLevel: string;
    } {
        return { provider: $<HTMLSelectElement>(`${prefix}-provider`).value, model: $<HTMLSelectElement>(`${prefix}-model`).value, thinkingLevel: $<HTMLSelectElement>(`${prefix}-thinking`).value };
    }
    function setupModelEditor(prefix: string, catalog: ModelCatalog, configuredOnly: boolean): void {
        modelEditor?.destroy();
        modelEditor = createModelEditor({providers: configuredOnly ? (catalog.providers || []).filter((entry) => entry.hasApiKey) : catalog.providers, models: catalog.models, selection: {provider: app.state.settings.provider, model: app.state.settings.model, thinkingLevel: app.state.settings.thinkingLevel}}, {prefix, element: modelPicker!.element});
    }
    async function openModelPicker(): Promise<void> {
        if (anyRunning() || activity.busy)
            return;
        if (!app.state.settings.hasConnections && !app.state.settings.hasApiKey) {
            openSettings();
            return;
        }
        modelEditor?.destroy();
        modelPicker?.destroy();
        modelPicker = createModelPicker({}, {idPrefix: ''});
        $('model-content').replaceChildren(modelPicker.element);
        showDialog('model-dialog');
        const form = $<HTMLFormElement>('model-form');
        const isCurrent = () => $<HTMLDialogElement>('model-dialog').open && $('model-form') === form;
        try {
            const catalog = await request('/api/models');
            if (!isCurrent())
                return;
            if (!(catalog.providers || []).some((entry) => entry.hasApiKey)) {
                $<HTMLDialogElement>('model-dialog').close();
                openSettings();
                return;
            }
            setupModelEditor('picker', catalog, true);
            setControlPending($<HTMLButtonElement>('choose-model'), false);
            render();
            form.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (anyRunning() || activity.busy)
                    return;
                if (await mutate('/api/model-selection', modelFormSelection('picker')))
                    $<HTMLDialogElement>('model-dialog').close();
                else if (isCurrent())
                    $('model-error').textContent = activity.error;
            });
            $<HTMLInputElement>('picker-search').focus();
        }
        catch (error) {
            if (isCurrent())
                $('model-error').textContent = String(error);
        }
    }
    function openSettings(): void {
        settingsUpdates?.dispose();
        closeSidebar();
        connectionProbe?.abort();
        connectionProbe = null;
        settingsPanel?.destroy();
        settingsPanel = createSettingsPanel({baseUrl: app.state.settings.baseUrl, hasApiKey: app.state.settings.hasApiKey}, {idPrefix: ''});
        $('settings-content').replaceChildren(settingsPanel.element);
        renderAppearance();
        $<HTMLDialogElement>('settings-dialog').showModal();
        settingsUpdates = mountUpdates($('update-settings'), request);
        let catalog: ModelCatalog | null = null;
        const originalForm = $<HTMLFormElement>('settings-form');
        const isCurrent = () => $<HTMLDialogElement>('settings-dialog').open && document.getElementById('settings-form') === originalForm;
        $<HTMLSelectElement>('appearance-mode').addEventListener('change', async (event) => {
            if (activity.busy) {
                renderAppearance();
                return;
            }
            const mode = appearanceMode((event.currentTarget as HTMLSelectElement).value);
            $('appearance-error').textContent = '';
            if (!await mutate('/api/appearance', { mode }) && isCurrent())
                $('appearance-error').textContent = activity.error;
        });
        const keyStatus = () => {
            const provider = (catalog?.providers || []).find((entry) => entry.id === $<HTMLSelectElement>('settings-provider').value);
            const retained = !!provider?.hasSavedKey && provider.baseUrl === $<HTMLInputElement>('base-url').value.trim().replace(/\/+$/, '');
            $('key-status').textContent = provider?.signedIn ? 'Signed in' : retained ? 'Configured' : 'Not configured';
            const key = $<HTMLInputElement>('api-key');
            const signInOnly = !!provider?.oauth && !provider.apiKeySupported;
            const useSignIn = signInOnly || !!provider?.signedIn;
            $('provider-api-key').hidden = useSignIn;
            key.disabled = useSignIn;
            key.required = !useSignIn && !retained && !provider?.custom;
            const hint = $('provider-auth-hint');
            hint.hidden = !useSignIn;
            hint.textContent = provider?.signedIn ? 'Signed in with your provider account. No API key is needed.' : 'Sign in with your provider account above. No API key is needed.';
            key.placeholder = retained ? 'Leave blank to keep this provider’s key' : provider?.custom ? 'Optional API key for this endpoint' : 'Paste this provider’s API key';
            $('remove-key').hidden = !retained || !!provider?.signedIn;
            const actions = $('provider-actions');
            actions.hidden = !provider?.oauth && !provider?.custom;
            actions.innerHTML = provider ? sdkUI.providerActions(provider) : '';
        };
        refreshSettingsAuth = (providerID) => {
            if (!isCurrent())
                return;
            void request('/api/models').then((result) => {
                if (!isCurrent())
                    return;
                catalog = result;
                const select = $<HTMLSelectElement>('settings-provider');
                for (const option of select.options) {
                    const provider = (result.providers || []).find((entry) => entry.id === option.value);
                    if (provider)
                        option.textContent = `${provider.name}${provider.signedIn ? ' · Signed in' : provider.hasApiKey ? ' · Configured' : ''}`;
                }
                if (select.value === providerID)
                    keyStatus();
            }).catch((error) => { if (isCurrent())
                $('settings-error').textContent = String(error); });
        };
        setControlPending($<HTMLButtonElement>('save-settings'), true);
        void request('/api/models').then((result) => {
            if (!isCurrent())
                return;
            catalog = result;
            const providerSelect = $<HTMLSelectElement>('settings-provider');
            providerSelect.innerHTML = (result.providers || []).map((entry) => `<option value="${escape(entry.id)}">${escape(entry.name)}${entry.signedIn ? ' · Signed in' : entry.hasApiKey ? ' · Configured' : ''}</option>`).join('');
            providerSelect.disabled = false;
            providerSelect.value = (result.providers || []).some((entry) => entry.id === app.state.settings.provider) ? app.state.settings.provider! : (result.providers || [])[0]?.id || '';
            const chooseProvider = (changed: boolean) => {
                const provider = (result.providers || []).find((entry) => entry.id === providerSelect.value);
                if (!provider)
                    return;
                $<HTMLInputElement>('base-url').value = provider.baseUrl;
                if (changed) {
                    $<HTMLInputElement>('api-key').value = '';
                    $<HTMLDetailsElement>('provider-advanced').open = false;
                    connectionProbe?.abort();
                    $('connection-test-result').textContent = '';
                }
                keyStatus();
            };
            providerSelect.addEventListener('change', () => chooseProvider(true));
            chooseProvider(false);
            setControlPending($<HTMLButtonElement>('save-settings'), false);
            setControlPending($<HTMLButtonElement>('test-connection'), false);
            render();
        }).catch((error) => { if (isCurrent())
            $('settings-error').textContent = String(error); });
        $<HTMLInputElement>('base-url').addEventListener('input', keyStatus);
        $<HTMLInputElement>('base-url').addEventListener('invalid', () => { $<HTMLDetailsElement>('provider-advanced').open = true; });
        $('test-connection').addEventListener('click', async () => {
            if (connectionProbe) {
                connectionProbe.abort();
                return;
            }
            if (anyRunning() || activity.busy || !catalog || !originalForm.reportValidity())
                return;
            const controller = new AbortController();
            connectionProbe = controller;
            const form = new FormData(originalForm);
            const payload = { provider: $<HTMLSelectElement>('settings-provider').value, baseUrl: String(form.get('baseUrl') || '').trim(), apiKey: String(form.get('apiKey') || '').trim() };
            const button = $<HTMLButtonElement>('test-connection');
            button.textContent = 'Cancel test';
            setControlPending($<HTMLButtonElement>('save-settings'), true);
            $('connection-test-result').textContent = 'Testing streaming and tool calling…';
            try {
                const result = await request('/api/test-provider-connection', payload, { signal: controller.signal });
                if (!isCurrent() || connectionProbe !== controller)
                    return;
                $('connection-test-result').textContent = result.message;
                $('connection-test-result').className = result.ok ? 'pui-test-success' : 'pui-form-error';
            }
            catch (error) {
                if (isCurrent() && connectionProbe === controller) {
                    $('connection-test-result').textContent = controller.signal.aborted ? 'Test cancelled.' : error instanceof Error ? error.message : String(error);
                    $('connection-test-result').className = 'pui-form-error';
                }
            }
            finally {
                if (connectionProbe === controller) {
                    connectionProbe = null;
                    if (isCurrent()) {
                        button.textContent = 'Test connection';
                        setControlPending($<HTMLButtonElement>('save-settings'), false);
                        render();
                    }
                }
            }
        });
        originalForm.addEventListener('input', (event) => {
            if ((event.target as HTMLElement).id === 'appearance-mode')
                return;
            connectionProbe?.abort();
            $('connection-test-result').textContent = '';
        });
        $('settings-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (activity.busy || connectionProbe || !catalog)
                return;
            const form = new FormData(event.currentTarget as HTMLFormElement);
            const apiKey = String(form.get('apiKey') || '').trim();
            const payload = { provider: $<HTMLSelectElement>('settings-provider').value, baseUrl: String(form.get('baseUrl')).trim(), ...(apiKey ? { apiKey } : {}) };
            setControlPending($<HTMLButtonElement>('save-settings'), true);
            const saved = await mutate('/api/provider-config', payload);
            if (!isCurrent())
                return;
            if (!saved)
                $('settings-error').textContent = activity.error;
            $<HTMLInputElement>('api-key').value = '';
            setControlPending($<HTMLButtonElement>('save-settings'), false);
            render();
            if (saved) {
                $<HTMLDialogElement>('settings-dialog').close();
                if (!app.state.settings.hasApiKey && app.state.settings.hasConnections)
                    await openModelPicker();
            }
        });
        document.getElementById('remove-key')?.addEventListener('click', async () => {
            if (activity.busy)
                return;
            const removed = await mutate('/api/provider-config', { provider: $<HTMLSelectElement>('settings-provider').value, baseUrl: $<HTMLInputElement>('base-url').value.trim(), clearApiKey: true });
            if (!isCurrent())
                return;
            if (removed)
                $<HTMLDialogElement>('settings-dialog').close();
            else
                $('settings-error').textContent = activity.error;
        });
    }
    return { renderAppearance, openConnections, loadMCP, editMCP, thinkingLabel, openModelPicker, openSettings, get mcpConnections() { return mcpConnections; }, refreshProviderAuth(provider: string) { refreshSettingsAuth?.(provider); }, async checkUpdates() { openSettings(); await settingsUpdates?.check(); }, closeSettings() { settingsUpdates?.dispose(); settingsUpdates = undefined; connectionProbe?.abort(); connectionProbe = null; const key = document.getElementById('api-key') as HTMLInputElement | null; if (key)
            key.value = ''; }, closeConnections() { mcpRequest++; const key = document.getElementById('mcp-token') as HTMLInputElement | null; if (key)
            key.value = ''; const env = document.getElementById('mcp-env') as HTMLTextAreaElement | null; if (env)
            env.value = ''; } };
}
