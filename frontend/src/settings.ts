import type { ApiMutate, ApiRequest } from './api.ts';
import type { AppearanceMode, MCPServerView as MCPConnection, ModelCatalog, ProviderChoice } from './contract.generated.ts';
import { setControlPending } from './controls.ts';
import type { AppView, UIActivity } from './feature-api.ts';
import { dialogHeading, escape, icon } from './ui.ts';
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
        $('connections-content').innerHTML = `${dialogHeading('Connections', 'connections-title', 'connections-dialog', 'EXTERNAL TOOLS')}<p class="modal-description">Add an MCP server to give Pith access to its tools. Enabled connections connect automatically when a task starts. Disable a connection to stop using it in tasks. External tools require approval unless this conversation has full access.</p><div class="feature-toolbar"><button class="secondary-button" data-action="refresh-mcp">Refresh</button></div><div id="mcp-list"><p class="feature-hint">Loading connections…</p></div><div id="mcp-error" data-dialog-error class="form-error" role="alert"></div><section class="connection-editor"><div class="section-heading"><span id="mcp-form-title">Add connection</span><button type="button" class="secondary-button" data-action="new-mcp">New connection</button></div><form id="mcp-form"><label class="field-label" for="mcp-name">Name</label><input id="mcp-name" name="name" required autocomplete="off" placeholder="my-tools" /><label class="field-label" for="mcp-type">Connection type</label><select id="mcp-type" name="type" class="feature-select"><option value="http">HTTP</option><option value="stdio">Local command (stdio)</option></select><div id="mcp-http-fields"><label class="field-label" for="mcp-url">Server URL</label><input id="mcp-url" name="url" type="url" placeholder="https://example.com/mcp" autocomplete="off" /><label class="checkbox-field"><input id="mcp-oauth" type="checkbox" />Sign in with OAuth</label><details class="provider-advanced"><summary>OAuth settings (optional)</summary><label class="field-label">Registered client ID<input id="mcp-oauth-client" /></label><label class="field-label">Scopes<input id="mcp-oauth-scope" /></label><p class="field-hint">Uses the server’s OAuth discovery and PKCE. The temporary callback listens on 127.0.0.1:54819.</p></details><label class="field-label" for="mcp-token">Bearer token (optional)</label><input id="mcp-token" name="bearerToken" type="password" autocomplete="new-password" placeholder="Optional token" /><label class="checkbox-field" id="mcp-clear-token-row" hidden><input id="mcp-clear-token" type="checkbox" />Remove saved bearer token</label><p class="field-hint">Saved tokens are never returned to this page. Leave this field blank to keep an existing token.</p></div><div id="mcp-stdio-fields" hidden><label class="field-label" for="mcp-command">Installed executable</label><input id="mcp-command" name="command" placeholder="/path/to/mcp-server" autocomplete="off" /><label class="field-label" for="mcp-args">Arguments (JSON array)</label><textarea id="mcp-args" name="args" rows="3" spellcheck="false">[]</textarea><p class="field-hint">The executable and any runtime it needs must already be installed on your computer. Pith Desk does not bundle external runtimes or a marketplace.</p><div class="secret-label"><label class="field-label" for="mcp-env">Environment overrides (JSON object, optional)</label><button class="secondary-button" type="button" id="mcp-env-visibility" data-action="toggle-env" aria-controls="mcp-env" aria-pressed="false">Show</button></div><textarea id="mcp-env" class="secret-field" name="env" rows="3" spellcheck="false" autocomplete="off" aria-describedby="mcp-env-hint" placeholder='{"API_KEY":"…"}'></textarea><p id="mcp-env-hint" class="field-hint">Values stay private. Leave blank to keep saved overrides. Add a JSON object of string keys and values to set or replace individual overrides.</p><p id="mcp-env-keys" class="field-hint" hidden></p><label class="checkbox-field" id="mcp-clear-env-row" hidden><input id="mcp-clear-env" type="checkbox" />Clear saved environment overrides</label></div><label class="checkbox-field"><input id="mcp-enabled" name="enabled" type="checkbox" checked />Enable this connection</label><div id="mcp-form-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="connections-dialog">Close</button><button class="primary-button" type="submit" data-idle-action data-global-idle>Save connection</button></div></form></section>`;
        showDialog('connections-dialog');
        $<HTMLSelectElement>('mcp-type').addEventListener('change', renderMCPType);
        $('mcp-form').addEventListener('submit', (event) => { event.preventDefault(); void saveMCP(); });
        renderMCPType();
        render();
        void loadMCP();
    }
    function renderMCPType(): void {
        const http = $<HTMLSelectElement>('mcp-type').value === 'http';
        $('mcp-http-fields').hidden = !http;
        $('mcp-stdio-fields').hidden = http;
        $<HTMLInputElement>('mcp-url').required = http;
        $<HTMLInputElement>('mcp-command').required = !http;
    }
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
        $('mcp-list').innerHTML = mcpConnections.map((entry) => `<article class="connection-card"><div class="connection-card-heading"><strong>${escape(entry.name)}</strong></div><p class="file-path">${escape(entry.type === 'http' ? entry.url : [entry.command, ...(entry.args || [])].join(' '))}</p><p class="feature-hint">${entry.enabled ? 'Enabled' : 'Disabled'}${entry.hasBearerToken ? ' · Token configured' : ''}</p><p class="connection-status ${entry.enabled && entry.status === 'error' ? 'is-error' : ''}" role="status">${escape(mcpStatusLabel(entry))}</p>${entry.envKeys?.length ? `<p class="feature-hint">Saved environment keys: ${escape(entry.envKeys.join(', '))}</p>` : ''}${entry.error ? `<p class="form-error">${escape(entry.error)}</p>` : ''}<div class="file-actions">${entry.oauth ? `<button class="secondary-button" data-sdk="mcp-login" data-id="${escape(entry.name)}">${entry.signedIn ? 'Sign in again' : 'Sign in'}</button>${entry.signedIn ? `<button class="secondary-button" data-sdk="mcp-logout" data-id="${escape(entry.name)}">Sign out</button>` : ''}` : ''}<button class="secondary-button" data-mcp-edit="${escape(entry.name)}">Edit</button><button class="secondary-button" data-mcp-toggle="${escape(entry.name)}" data-global-idle data-idle-action>${entry.enabled ? 'Disable' : 'Enable'}</button><button class="secondary-button destructive-button" data-mcp-remove="${escape(entry.name)}" data-global-idle data-idle-action>Delete</button></div></article>`).join('') || '<p class="feature-hint">No connections yet. Add an HTTP server or an installed local MCP command below. Tools are discovered on demand using tool search and Codemode.</p>';
    }
    function editMCP(entry?: MCPConnection): void {
        mcpEditorGeneration++;
        $<HTMLFormElement>('mcp-form').reset();
        $<HTMLTextAreaElement>('mcp-env').classList.remove('revealed');
        $('mcp-env-visibility').setAttribute('aria-pressed', 'false');
        $('mcp-env-visibility').textContent = 'Show';
        $('mcp-form-title').textContent = entry ? `Edit ${entry.name}` : 'Add connection';
        $<HTMLInputElement>('mcp-name').value = entry?.name || '';
        $<HTMLInputElement>('mcp-name').readOnly = !!entry;
        $<HTMLSelectElement>('mcp-type').value = entry?.type || 'http';
        $<HTMLInputElement>('mcp-url').value = entry?.url || '';
        $<HTMLInputElement>('mcp-oauth').checked = entry?.oauth || false;
        $<HTMLInputElement>('mcp-oauth-client').value = entry?.oauthClientId || '';
        $<HTMLInputElement>('mcp-oauth-scope').value = entry?.oauthScope || '';
        $<HTMLInputElement>('mcp-command').value = entry?.command || '';
        $<HTMLTextAreaElement>('mcp-args').value = JSON.stringify(entry?.args || [], null, 2);
        $<HTMLInputElement>('mcp-enabled').checked = entry?.enabled ?? true;
        $<HTMLInputElement>('mcp-token').placeholder = entry?.hasBearerToken ? 'Leave blank to keep your saved token' : 'Optional token';
        $('mcp-clear-token-row').hidden = !entry?.hasBearerToken;
        const envKeys = entry?.envKeys || [];
        $('mcp-clear-env-row').hidden = !envKeys.length;
        $('mcp-env-keys').hidden = !envKeys.length;
        $('mcp-env-keys').textContent = `Saved environment keys: ${envKeys.join(', ')}`;
        $('mcp-form-error').textContent = '';
        renderMCPType();
        $<HTMLInputElement>(entry ? entry.type === 'stdio' ? 'mcp-command' : 'mcp-url' : 'mcp-name').focus();
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
    function thinkingLabel(level: string): string {
        return level === 'off' ? 'Thinking off' : `Thinking: ${level === 'xhigh' ? 'extra high' : level}`;
    }
    function modelEditorMarkup(prefix: string): string {
        return `<label class="field-label" for="${prefix}-provider">Provider</label><select class="feature-select" id="${prefix}-provider" required disabled><option value="">Loading providers…</option></select><label class="field-label" for="${prefix}-search">Model</label><input id="${prefix}-search" type="search" placeholder="Search by model name or ID" autocomplete="off" /><label class="sr-only" for="${prefix}-model">Choose model</label><select id="${prefix}-model" class="model-list" size="6" required disabled></select><p id="${prefix}-capabilities" class="field-hint" aria-live="polite"></p><label class="field-label" id="${prefix}-thinking-label" for="${prefix}-thinking">Thinking effort</label><select id="${prefix}-thinking" class="feature-select" aria-describedby="${prefix}-capabilities" required></select><p class="field-hint">Built-in models come from the Pith SDK catalog. Custom models use your saved definitions. Availability depends on your endpoint and account.</p>`;
    }
    function modelFormSelection(prefix: string): {
        provider: string;
        model: string;
        thinkingLevel: string;
    } {
        return { provider: $<HTMLSelectElement>(`${prefix}-provider`).value, model: $<HTMLSelectElement>(`${prefix}-model`).value, thinkingLevel: $<HTMLSelectElement>(`${prefix}-thinking`).value };
    }
    function setupModelEditor(prefix: string, catalog: ModelCatalog, configuredOnly: boolean): void {
        const providers = configuredOnly ? (catalog.providers || []).filter((entry) => entry.hasApiKey) : (catalog.providers || []);
        const providerSelect = $<HTMLSelectElement>(`${prefix}-provider`);
        const modelSelect = $<HTMLSelectElement>(`${prefix}-model`);
        const search = $<HTMLInputElement>(`${prefix}-search`);
        const effort = $<HTMLSelectElement>(`${prefix}-thinking`);
        providerSelect.innerHTML = providers.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.name)}</option>`).join('');
        providerSelect.disabled = providers.length === 0;
        providerSelect.value = providers.some((entry) => entry.id === app.state.settings.provider) ? app.state.settings.provider! : providers[0]?.id || '';
        let selected = '';
        const capabilities = () => {
            selected = modelSelect.value;
            const model = (catalog.models || []).find((entry) => entry.provider === providerSelect.value && entry.id === selected);
            const previous = effort.value;
            const levels = model?.thinkingLevels || ['off'];
            effort.innerHTML = levels.map((level) => `<option value="${escape(level)}">${escape(thinkingLabel(level))}</option>`).join('');
            effort.value = levels.includes(previous) ? previous : levels.includes('high') ? 'high' : levels.includes('medium') ? 'medium' : levels[0];
            effort.disabled = levels.length < 2;
            effort.hidden = levels.length < 2;
            $(`${prefix}-thinking-label`).hidden = levels.length < 2;
            $(`${prefix}-capabilities`).textContent = model ? `${model.supportsImages ? 'Text + images' : 'Text only'} · ${new Intl.NumberFormat('en').format(model.contextWindow)} context tokens · ${new Intl.NumberFormat('en').format(model.maxTokens)} max output tokens` : 'No matching models.';
        };
        const renderModels = () => {
            const query = search.value.trim().toLowerCase();
            const models = (catalog.models || []).filter((entry) => entry.provider === providerSelect.value && (entry.id === selected || `${entry.name} ${entry.id}`.toLowerCase().includes(query)));
            modelSelect.innerHTML = models.map((entry) => `<option value="${escape(entry.id)}">${escape(entry.name)} — ${escape(entry.id)}</option>`).join('');
            modelSelect.disabled = models.length === 0;
            modelSelect.value = models.some((entry) => entry.id === selected) ? selected : models[0]?.id || '';
            capabilities();
        };
        const chooseProvider = () => {
            const provider = providers.find((entry) => entry.id === providerSelect.value);
            if (!provider)
                return;
            search.value = '';
            selected = provider.model || (provider.id === app.state.settings.provider ? app.state.settings.model : '');
            effort.innerHTML = `<option value="${escape(provider.thinkingLevel || app.state.settings.thinkingLevel || 'high')}"></option>`;
            renderModels();
        };
        providerSelect.addEventListener('change', chooseProvider);
        modelSelect.addEventListener('change', capabilities);
        search.addEventListener('input', renderModels);
        chooseProvider();
    }
    async function openModelPicker(): Promise<void> {
        if (anyRunning() || activity.busy)
            return;
        if (!app.state.settings.hasConnections && !app.state.settings.hasApiKey) {
            openSettings();
            return;
        }
        $('model-content').innerHTML = `${dialogHeading('Choose a model', 'model-title', 'model-dialog', 'PITH MODEL CATALOG')}<form id="model-form">${modelEditorMarkup('picker')}<div id="model-error" class="form-error" role="alert"></div><div class="modal-footer"><button type="button" class="secondary-button" data-close="model-dialog">Cancel</button><button type="submit" class="primary-button" id="choose-model" data-global-idle data-control-pending="true" disabled>Use model</button></div></form>`;
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
        $('settings-content').innerHTML = `
    ${dialogHeading('Settings', 'settings-title', 'settings-dialog', 'MAKE IT YOURS')}
    <section class="settings-section appearance-settings" aria-labelledby="appearance-title">
      <h3 id="appearance-title">Appearance</h3>
      <p class="appearance-hint" id="appearance-hint">A bright white workspace or a calm dark one, both with a blue accent. Follow system matches your computer.</p>
      <label class="sr-only" for="appearance-mode">Appearance</label>
      <select id="appearance-mode" class="appearance-select" aria-describedby="appearance-hint"><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select>
      <div id="appearance-error" class="form-error" role="alert"></div>
    </section>
    <section id="update-settings" class="settings-section update-settings" aria-labelledby="update-title">
      <h3 id="update-title">Updates</h3>
      <div class="settings-copy">
        <p class="field-hint" data-update-version></p>
        <p class="field-hint" role="status" aria-live="polite" data-update-message>Loading update status…</p>
      </div>
      <progress max="100" value="0" aria-label="Update progress" hidden></progress>
      <div class="settings-actions"><button class="secondary-button" type="button" data-update-check disabled>Check for updates</button><button class="primary-button" type="button" data-update-install hidden>Update and restart</button></div>
    </section>
    <form id="settings-form">
      <section class="settings-section" aria-labelledby="provider-title">
        <h3 id="provider-title">Model providers</h3>
        <p class="modal-description">Connect your model providers here. Choose models and thinking effort beside the message box.</p>
        <div class="settings-actions"><button class="secondary-button" type="button" data-sdk="custom">Add independent model connection</button></div>
        <div class="settings-field">
          <label class="field-label" for="settings-provider">Provider</label>
          <select id="settings-provider" class="feature-select" required disabled><option value="">Loading providers…</option></select>
          <div id="provider-actions" hidden></div>
          <p id="provider-auth-hint" class="field-hint" hidden></p>
        </div>
        <details id="provider-advanced" class="provider-advanced">
          <summary>Advanced connection settings</summary>
          <label class="field-label" for="base-url">API base URL</label>
          <div class="input-with-icon">${icon('globe')}<input id="base-url" name="baseUrl" type="url" required value="${escape(app.state.settings.baseUrl)}" autocomplete="off" /></div>
          <p class="field-hint">The provider’s endpoint is filled in automatically. Change it only for a proxy or custom service.</p>
        </details>
        <div id="provider-api-key" class="settings-field">
          <label class="field-label" for="api-key">API key <span id="key-status" class="configured-badge"></span></label>
          <input id="api-key" name="apiKey" type="password" placeholder="${app.state.settings.hasApiKey ? 'Leave blank to keep your current key' : 'Paste your API key'}" autocomplete="new-password" ${app.state.settings.hasApiKey ? '' : 'required'} />
          <p class="field-hint">The saved key is never returned to this page. Model requests go to your configured provider.</p>
          <button class="secondary-button destructive-button" id="remove-key" type="button" hidden>Remove saved API key</button>
        </div>
      </section>
      <section class="settings-section connection-test">
        <p class="field-hint">Uses this provider’s last selected model, or Pith’s default, to check streaming and tool calling. Does not save settings or access files.</p>
        <div class="settings-actions"><button type="button" class="secondary-button" id="test-connection" data-control-pending="true" disabled data-global-idle data-idle-action>Test connection</button></div>
        <div id="connection-test-result" role="status" aria-live="polite"></div>
      </section>
      <div id="settings-error" data-dialog-error class="form-error" role="alert"></div>
      <section class="settings-section diagnostics-setting">
        <p class="field-hint">Version, usage and failure category only; no conversation, file contents, paths or credentials.</p>
        <div class="settings-actions"><button type="button" class="secondary-button" data-action="diagnostics">Save diagnostics</button></div>
      </section>
      <div class="modal-footer"><button class="secondary-button" type="button" data-close="settings-dialog">Cancel</button><button class="primary-button" id="save-settings" data-control-pending="true" disabled data-global-idle type="submit">Save settings</button></div>
    </form>`;
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
                $('connection-test-result').className = result.ok ? 'test-success' : 'form-error';
            }
            catch (error) {
                if (isCurrent() && connectionProbe === controller) {
                    $('connection-test-result').textContent = controller.signal.aborted ? 'Test cancelled.' : error instanceof Error ? error.message : String(error);
                    $('connection-test-result').className = 'form-error';
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
