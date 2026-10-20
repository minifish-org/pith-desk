import { thinkingLabel, type Application, type SettingsSession, type MCPSession, type ModelSession, type SettingsPanelState, type ModelPickerState, type MCPConnectionsState, type MCPConnectionDraft, type SettingsDraft, type ProviderActionsState, type ProviderAction, type ProviderActionTarget, type ActionResult, type MCPCallbacks, type SettingsCallbacks } from './ui-contract.ts';
import type { ApiMutate, ApiRequest } from './api.ts';
import type { AppearanceMode, MCPServerView as MCPConnection, ModelCatalog, ProviderChoice } from './contract.generated.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { mountUpdates } from './updates.ts';
type API = {
    ui: Application;
    view: AppView;
    activity: UIActivity;
    request: ApiRequest;
    mutate: ApiMutate;
    render: () => void;
    closeSidebar: () => void;
    anyRunning: () => boolean;
    appearanceMode: (value: unknown) => AppearanceMode;
    applyAppearance: (mode: AppearanceMode) => void;
    providerActions: (provider: ProviderChoice) => ProviderActionsState;
    providerAction: (action: ProviderAction, target: ProviderActionTarget) => Promise<ActionResult>;
    mcpAction: NonNullable<MCPCallbacks['onConnectionAction']>;
    custom: (id?: string) => Promise<void>;
    diagnostics: NonNullable<SettingsCallbacks['onDiagnostics']>;
    server?: boolean;
};
export function createSettingsUI(api: API) {
    const { view: app, activity, request, mutate, render, closeSidebar, anyRunning, appearanceMode, applyAppearance } = api;
    let settingsPanel: SettingsSession | undefined, connectionsPanel: MCPSession | undefined, modelPicker: ModelSession | undefined;
    let destroyed = false;
    let settingsState: SettingsPanelState = { baseUrl: '', hasApiKey: false, ready: false }, connectionsState: MCPConnectionsState = {}, modelState: ModelPickerState = {};
    let settingsUpdates: ReturnType<typeof mountUpdates> | undefined, connectionProbe: AbortController | null = null, refreshSettingsAuth: ((provider: string) => void) | null = null;
    let mcpConnections: MCPConnection[] = [], mcpRequest = 0, mcpEditorGeneration = 0;
    function renderAppearance(): void {
        if (destroyed) return;
        const mode = appearanceMode(app.state.settings.appearance);
        applyAppearance(mode);
        settingsState = { ...settingsState, disabled: activity.busy || anyRunning(), appearance: { ...settingsState.appearance, mode, disabled: activity.busy || !app.loaded } };
        settingsPanel?.update(settingsState);
        connectionsState = { ...connectionsState, disabled: activity.busy || anyRunning() };
        connectionsPanel?.update(connectionsState);
        modelState = { ...modelState, disabled: activity.busy || anyRunning() };
        modelPicker?.update(modelState);
    }
    function openConnections(): void {
        if (destroyed) return;
        connectionsPanel?.destroy();
        mcpEditorGeneration++;
        connectionsState = { disabled: activity.busy || anyRunning() };
        connectionsPanel = api.ui.settings.openConnections(connectionsState, {onSubmit: saveMCP, onConnectionAction: api.mcpAction,
            onRefresh: () => {void loadMCP();}, onNew: () => editMCP(), onClose: closeConnections});
        render();
        void loadMCP();
    }
    async function loadMCP(): Promise<void> {
        const sequence = ++mcpRequest, panel = connectionsPanel;
        connectionsState = { ...connectionsState, error: '' };
        panel?.update(connectionsState);
        try {
            const result = await request('/api/mcp');
            if (destroyed || sequence !== mcpRequest || panel !== connectionsPanel)
                return;
            mcpConnections = result || [];
            renderMCPList();
            render();
        }
        catch (error) {
            if (!destroyed && sequence === mcpRequest && panel === connectionsPanel) {
                connectionsState = { ...connectionsState, error: error instanceof Error ? error.message : String(error) };
                panel?.update(connectionsState);
            }
        }
    }
    function mcpStatusLabel(entry: MCPConnection): string { if (!entry.enabled)
        return 'Will not be used by tasks'; if (entry.status === 'connected')
        return `Connected · ${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}`; if (entry.status === 'connecting')
        return 'Connecting…'; if (entry.status === 'error')
        return 'Connection failed'; return 'Connects automatically when a task starts'; }
    function renderMCPList(): void { connectionsPanel?.setConnections(mcpConnections.map(entry => ({ ...entry, args: entry.args || [], envKeys: entry.envKeys || [], statusLabel: mcpStatusLabel(entry) }))); }
    function editMCP(entry?: MCPConnection): void { mcpEditorGeneration++; connectionsPanel?.edit(entry ? { ...entry, args: entry.args || [], envKeys: entry.envKeys || [] } : undefined); }
    function parseConnectionJSON(value: string, label: string): unknown { try {
        return JSON.parse(value);
    }
    catch {
        throw new Error(`Enter valid JSON for ${label}.`);
    } }
    async function saveMCP(draft: MCPConnectionDraft) {
        if (activity.busy || anyRunning())
            return { ok: false as const, error: 'A task is running. Try again when it finishes.' };
        const panel = connectionsPanel, generation = mcpEditorGeneration;
        const isCurrent = () => !destroyed && !!panel?.isOpen() && panel === connectionsPanel && mcpEditorGeneration === generation;
        const { name, type, bearerToken } = draft;
        const args: unknown = type === 'stdio' ? parseConnectionJSON(draft.args || '[]', 'arguments') : [];
        if (!Array.isArray(args) || !args.every(value => typeof value === 'string'))
            throw new Error('Arguments must be a JSON array of strings.');
        const envDraft = draft.env.trim();
        const env: unknown = type === 'stdio' && envDraft ? parseConnectionJSON(envDraft, 'environment overrides') : undefined;
        if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every(value => typeof value === 'string')))
            throw new Error('Environment overrides must be a JSON object with string values.');
        const payload = { name, type, args, oauth: false, enabled: draft.enabled, ...(type === 'http' ? { oauth: draft.oauth, oauthClientId: draft.oauthClientId, oauthScope: draft.oauthScope, url: draft.url, ...(bearerToken ? { bearerToken } : {}), ...(draft.clearBearerToken ? { clearBearerToken: true } : {}) } : { command: draft.command, ...(env !== undefined ? { env: env as Record<string, string> } : {}), ...(draft.clearEnv ? { clearEnv: true } : {}) }) };
        const saved = await mutate('/api/mcp/save', payload);
        if (!isCurrent())
            return saved ? {ok:true as const} : {ok:false as const,error:activity.error};
        // A failed write clears the one-shot bearer token but keeps the env draft.
        panel?.clearBearerToken();
        if (!saved)
            return { ok: false as const, error: activity.error };
        panel?.clearSecrets();
        await loadMCP();
        if (isCurrent())
            editMCP(mcpConnections.find(entry => entry.name === name));
        return { ok: true as const };
    }
    async function openModelPicker(): Promise<void> {
        if (destroyed || anyRunning() || activity.busy)
            return;
        if (!app.state.settings.hasConnections && !app.state.settings.hasApiKey) {
            openSettings();
            return;
        }
        modelPicker?.destroy();
        modelState = { loading: true };
        const picker = api.ui.settings.openModels(modelState, {onSubmit: async (selection) => { if (anyRunning() || activity.busy)
                return { ok: false, error: 'A task is running. Try again when it finishes.' }; const saved = await mutate('/api/model-selection', selection); if (!isCurrent())
                return saved ? {ok:true} : {ok:false,error:activity.error}; if (saved)
                picker.close(); return saved ? { ok: true } : { ok: false, error: activity.error }; } });
        modelPicker = picker;
        const isCurrent = () => !destroyed && picker.isOpen() && modelPicker === picker;
        try {
            const catalog = await request('/api/models');
            if (!isCurrent())
                return;
            if (!(catalog.providers || []).some(entry => entry.hasApiKey)) {
                picker.close();
                openSettings();
                return;
            }
            modelState = { loading: false, editor: { providers: (catalog.providers || []).filter(entry => entry.hasApiKey), models: catalog.models, selection: { provider: app.state.settings.provider, model: app.state.settings.model, thinkingLevel: app.state.settings.thinkingLevel } } };
            picker.update(modelState);
            render();
            picker.focus();
        }
        catch (error) {
            if (isCurrent()) {
                modelState = { ...modelState, error: String(error) };
                picker.update(modelState);
            }
        }
    }
    function openSettings(): void {
        if (destroyed) return;
        settingsUpdates?.dispose();
        closeSidebar();
        connectionProbe?.abort();
        connectionProbe = null;
        settingsPanel?.destroy();
        settingsState = { baseUrl: app.state.settings.baseUrl, hasApiKey: app.state.settings.hasApiKey, ready: false };
        let catalog: ModelCatalog | null = null, providerGeneration = 0;
        const isCurrent = () => !destroyed && panel.isOpen() && settingsPanel === panel;
        const update = (patch: Partial<SettingsPanelState>) => { if (!isCurrent())
            return; settingsState = { ...settingsState, ...patch }; panel.update(settingsState); };
        const keyStatus = () => {
            if (!isCurrent())
                return;
            const draft = panel.read(), provider = catalog?.providers?.find(entry => entry.id === draft.provider), retained = !!provider?.hasSavedKey && provider.baseUrl === draft.baseUrl.replace(/\/+$/, '');
            const useSignIn = !!provider?.oauth && !provider.apiKeySupported || !!provider?.signedIn;
            panel.setCredential({ status: provider?.signedIn ? 'Signed in' : retained ? 'Configured' : 'Not configured', hidden: useSignIn, required: !useSignIn && !retained && !provider?.custom, placeholder: retained ? 'Leave blank to keep this provider’s key' : provider?.custom ? 'Optional API key for this endpoint' : 'Paste this provider’s API key', removeVisible: retained && !provider?.signedIn, hint: useSignIn ? provider?.signedIn ? 'Signed in with your provider account. No API key is needed.' : 'Sign in with your provider account above. No API key is needed.' : undefined, providerActions: provider && (provider.oauth || provider.custom) ? api.providerActions(provider) : undefined });
        };
        const chooseProvider = (changed: boolean) => { const provider = catalog?.providers?.find(entry => entry.id === panel.read().provider); if (!provider)
            return; if (changed) providerGeneration++; panel.resetProvider({ provider: provider.id, baseUrl: provider.baseUrl, clearKey: changed, collapseAdvanced: changed }); if (changed) {
            connectionProbe?.abort();
            update({ testResult: { message: '' } });
        } keyStatus(); };
        const testConnection = async (draft: SettingsDraft) => {
            if (connectionProbe) {
                connectionProbe.abort();
                return;
            }
            if (anyRunning() || activity.busy || !catalog)
                return;
            const controller = new AbortController();
            connectionProbe = controller;
            update({ testing: true, testResult: { message: 'Testing streaming and tool calling…' } });
            try {
                const result = await request('/api/test-provider-connection', draft, { signal: controller.signal });
                if (isCurrent() && connectionProbe === controller)
                    update({ testResult: { message: result.message, ok: result.ok } });
            }
            catch (error) {
                if (isCurrent() && connectionProbe === controller)
                    update({ testResult: { message: controller.signal.aborted ? 'Test cancelled.' : error instanceof Error ? error.message : String(error), ok: false } });
            }
            finally {
                if (connectionProbe === controller) {
                    connectionProbe = null;
                    if (isCurrent()) {
                        update({ testing: false });
                        render();
                    }
                }
            }
        };
        const panel = api.ui.settings.openSettings(settingsState, {onProviderChange: () => chooseProvider(true), onDraftChange: () => { connectionProbe?.abort(); update({ testResult: { message: '' } }); keyStatus(); }, onTest: testConnection, onCancelTest: () => {connectionProbe?.abort();}, onProviderAction: api.providerAction, onCreateConnection: () => api.custom(), onDiagnostics: api.diagnostics, onUpdateAction: action => settingsUpdates?.act(action), onClose: closeSettings, onAppearanceChange: async (value) => { if (activity.busy) {
                renderAppearance();
                return;
            } const mode = appearanceMode(value); update({ appearance: { mode, error: '' } }); if (!await mutate('/api/appearance', { mode }) && isCurrent())
                update({ appearance: { mode, error: activity.error } }); }, onSubmit: async (draft) => {
                if (activity.busy || connectionProbe || !catalog)
                    return { ok: false, error: activity.error };
                const generation = providerGeneration;
                const saved = await mutate('/api/provider-config', { provider: draft.provider, baseUrl: draft.baseUrl, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) });
                if (!isCurrent() || generation !== providerGeneration)
                    return saved ? {ok:true} : {ok:false,error:activity.error};
                panel.clearSecrets();
                render();
                if (saved) {
                    panel.close();
                    if (!app.state.settings.hasApiKey && app.state.settings.hasConnections)
                        await openModelPicker();
                }
                return saved ? { ok: true } : { ok: false, error: activity.error };
            }, onRemoveKey: async (draft) => { if (activity.busy)
                return { ok: false, error: activity.error }; const generation = providerGeneration; const removed = await mutate('/api/provider-config', { provider: draft.provider, baseUrl: draft.baseUrl, clearApiKey: true }); if (!isCurrent() || generation !== providerGeneration)
                return removed ? {ok:true} : {ok:false,error:activity.error}; if (removed)
                panel.close(); return removed ? { ok: true } : { ok: false, error: activity.error }; } });
        settingsPanel = panel;
        renderAppearance();
        if (!api.server) settingsUpdates = mountUpdates(panel, request);
        const providers = (result: ModelCatalog, selected?: string) => panel.setProviders((result.providers || []).map(entry => ({ id: entry.id, name: entry.name, configured: entry.hasApiKey, signedIn: entry.signedIn })), selected);
        refreshSettingsAuth = providerID => { if (!isCurrent())
            return; void request('/api/models').then(result => { if (!isCurrent())
            return; catalog = result; providers(result); if (panel.read().provider === providerID)
            keyStatus(); }).catch(error => update({ error: String(error) })); };
        void request('/api/models').then(result => { if (!isCurrent())
            return; catalog = result; providers(result, app.state.settings.provider); chooseProvider(false); update({ ready: true }); render(); }).catch(error => update({ error: String(error) }));
    }
    function closeSettings(): void { settingsUpdates?.dispose(); settingsUpdates = undefined; connectionProbe?.abort(); connectionProbe = null; settingsPanel?.clearSecrets(); }
    function closeConnections(): void { mcpRequest++; connectionsPanel?.clearSecrets(); }
    return {
        renderAppearance, openConnections, loadMCP, editMCP, thinkingLabel, openModelPicker, openSettings,
        get mcpConnections() { return mcpConnections; },
        setMCPError(error: string) { connectionsState = {...connectionsState,error}; connectionsPanel?.update(connectionsState); },
        isEditingMCP(name: string) { return connectionsPanel?.read().name === name; },
        isConnectionsOpen() { return !!connectionsPanel?.isOpen(); },
        refreshProviderAuth(provider: string) { refreshSettingsAuth?.(provider); },
        async checkUpdates() { openSettings(); await settingsUpdates?.check(); },
        closeSettings, closeConnections,
        destroy() {
            if (destroyed) return; destroyed = true;
            mcpRequest++; mcpEditorGeneration++; refreshSettingsAuth = null;
            connectionProbe?.abort(); connectionProbe = null;
            settingsUpdates?.dispose(); settingsUpdates = undefined;
            settingsPanel?.destroy(); settingsPanel = undefined;
            connectionsPanel?.destroy(); connectionsPanel = undefined;
            modelPicker?.destroy(); modelPicker = undefined;
        }
    };
}
