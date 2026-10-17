import { createText, createSecretInput, createURLInput, createSelect, createButton, createSlot, createStack, createForm, createDisclosure, createList, createNotice, createProgress, createToolbar } from 'pith-ui';
import type { Control, ButtonState } from 'pith-ui';
import type { SettingsScene, SettingsSession, SettingsPanelState, SettingsCallbacks, SettingsDraft, SettingsCredential, SettingsProviderOption, ProviderAction, UpdatePanelState, UpdateAction } from './ui-types';
import { resultOf, type SessionHub, type Surface } from './ui-sessions';
import { openModels, openCustomConnection } from './ui-model-view';
import { openConnections } from './ui-mcp-view';
import { openProviderLogin } from './ui-provider-view';
export function createSettingsView(hub: SessionHub, productName: string): SettingsScene {
    return {
        openConnectionLoading(state, callbacks = {}) { return hub.loading('feature', state.editing ? 'Edit model connection' : 'Add model connection', state, callbacks.onClose); },
        openSettings(state, callbacks = {}) { return openSettings(hub, productName, state, callbacks); },
        openConnections: (state = {}, callbacks = {}) => openConnections(hub, state, callbacks),
        openModels: (state, callbacks = {}) => openModels(hub, state, callbacks),
        openCustomConnection: (state, callbacks = {}) => openCustomConnection(hub, state, callbacks),
        openProviderLogin: (state, callbacks = {}) => openProviderLogin(hub, state, callbacks), destroy() { },
    };
}
function openSettings(hub: SessionHub, productName: string, initial: SettingsPanelState, callbacks: SettingsCallbacks): SettingsSession {
    let state = initial, surface: Surface, revision = 0, writeToken = 0, writing = false, localError = '', disposed = false;
    let providers: readonly SettingsProviderOption[] = [], credential: SettingsCredential = { status: '', hidden: false, required: false, placeholder: 'API key', removeVisible: initial.hasApiKey };
    let closed: SettingsDraft = { provider: '', baseUrl: initial.baseUrl, apiKey: '' };
    const active = () => !disposed && !!surface?.isOpen();
    const appearance = createSelect({ label: 'Appearance', value: initial.appearance?.mode ?? 'system', options: [{ value: 'system', label: 'Follow system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], onChange: value => { void resultOf(() => callbacks.onAppearanceChange?.(value === 'light' || value === 'dark' ? value : 'system')).then(result => { if (active() && !result.ok)
            surface.fail(result.error); }); } });
    const provider = createSelect({ label: 'Provider', options: [], onChange: value => { void resultOf(() => callbacks.onProviderChange?.(value)).then(result => { if (active() && !result.ok)
            surface.fail(result.error); }); } });
    const key = createSecretInput({ label: 'API key', autocomplete: 'off', onInput: () => callbacks.onDraftChange?.(draft()) });
    const baseURL = createURLInput({ label: 'API base URL', value: initial.baseUrl, onInput: () => callbacks.onDraftChange?.(draft()) });
    const advanced = createDisclosure({ title: 'Advanced', content: baseURL }), keySlot = createSlot({ content: key }), status = createText({ text: '', role: 'description' }), hint = createText({ text: '', role: 'description' });
    const providerActions = createList({ items: [] }), remove = createButton({ label: 'Remove saved key', intent: 'danger', onAction: () => write('remove') }), removeSlot = createSlot({ content: remove, hidden: !initial.hasApiKey });
    const form = createForm({ children: [status, keySlot, hint, advanced, removeSlot], submitLabel: 'Save settings', onSubmit: () => write('submit'), onCancel: () => surface.close() });
    const testResult = createNotice({ message: '', tone: 'info' }), test = createButton({ label: 'Test connection', onAction: async () => {
            if (state.testing)
                return resultOf(callbacks.onCancelTest);
            if (!form.validate())
                return { ok: true };
            return resultOf(() => callbacks.onTest?.(draft()));
        }, onError: message => { if (active())
            surface.fail(message); } });
    const add = createButton({ label: 'Add model connection', onAction: () => callbacks.onCreateConnection?.(), onError: message => { if (active())
            surface.fail(message); } });
    const diagnostics = createButton({ label: 'Save diagnostics', onAction: () => callbacks.onDiagnostics?.(), onError: message => { if (active())
            surface.fail(message); } });
    let updateState: UpdatePanelState = { version: '', enabled: false, phase: '', availableVersion: '', progress: 0, message: '' }, updateError = '', externalPending = false, localPending = false, retryCheck = false;
    const updateVersion = createText({ text: productName }), updateMessage = createNotice({ message: '', tone: 'info' }), progress = createProgress({ label: 'Update download', max: 100, value: 0 }), progressSlot = createSlot({ content: progress, hidden: true });
    const check = createButton({ label: 'Check for updates', onAction: () => runUpdate('check') }), install = createButton({ label: 'Update and restart', onAction: () => runUpdate('install') }), installSlot = createSlot({ content: install, hidden: true });
    const updates = createStack({ children: [updateVersion, updateMessage, progressSlot, createToolbar({ label: 'Updates', children: [check, installSlot] })] });
    const actionRows = new Map<string, {
        control: Control<ButtonState>;
        label: string;
        action: ProviderAction;
    }>();
    function renderProviderActions(): void {
        const data = credential.providerActions, items: Array<{
            key: string;
            content: Control;
        }> = [], keep = new Set<string>();
        const actions: Array<{
            action: ProviderAction;
            label: string;
        }> = [];
        if (data?.oauth)
            actions.push({ action: data.signedIn ? 'logout' : 'login', label: data.signedIn ? 'Sign out' : 'Sign in with provider' });
        if (data?.custom)
            actions.push({ action: 'custom', label: 'Edit models and prices' }, { action: 'remove-connection', label: 'Remove connection' });
        for (const item of actions) {
            const id = JSON.stringify([data!.id, item.action]);
            keep.add(id);
            let row = actionRows.get(id);
            if (!row) {
                const target = Object.freeze({ id: data!.id });
                row = { ...item, control: createButton({ label: item.label, intent: item.action === 'remove-connection' ? 'danger' : 'neutral', onAction: () => active() ? callbacks.onProviderAction?.(item.action, target) : undefined, onError: message => { if (active())
                            surface.fail(message); } }) };
                actionRows.set(id, row);
            }
            row.control.update({ label: item.label, intent: item.action === 'remove-connection' ? 'danger' : 'neutral', disabled: !!state.disabled || !!data?.disabled || writing });
            items.push({ key: id, content: row.control });
        }
        providerActions.update({ items });
        for (const key of actionRows.keys())
            if (!keep.has(key))
                actionRows.delete(key);
    }
    function draft(): SettingsDraft { return { provider: provider.read(), baseUrl: baseURL.read().trim(), apiKey: credential.hidden ? '' : key.read().trim() }; }
    function renderUpdates(): void {
        updateVersion.update({ text: `${productName} ${updateState.version}` });
        updateMessage.update({ message: updateError || updateState.message, tone: updateError ? 'error' : 'info' });
        const busy = ['checking', 'installing', 'restarting'].includes(updateState.phase), pending = externalPending || localPending;
        check.update({ label: 'Check for updates', disabled: !updateState.enabled || (busy && !retryCheck), pending });
        install.update({ label: 'Update and restart', disabled: !updateState.enabled || busy, pending });
        installSlot.update({ hidden: !updateState.availableVersion });
        progressSlot.update({ hidden: updateState.phase !== 'installing' });
        progress.update({ label: 'Update download', max: 100, value: updateState.progress });
    }
    async function runUpdate(action: UpdateAction) { if (!active() || localPending || externalPending)
        return { ok: true } as const; localPending = true; updateError = ''; renderUpdates(); const result = await resultOf(() => callbacks.onUpdateAction?.(action)); if (active()) {
        localPending = false;
        if (!result.ok) {
            updateError = result.error;
            retryCheck = action === 'check';
        }
        renderUpdates();
    } return result; }
    function render(): void {
        if (disposed)
            return;
        const unavailable = !!state.disabled || writing;
        appearance.update({ label: 'Appearance', options: [{ value: 'system', label: 'Follow system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], disabled: !!state.appearance?.disabled || writing, error: state.appearance?.error });
        if (state.appearance)
            appearance.reset(state.appearance.mode);
        provider.update({ label: 'Provider', options: providers.map(item => ({ value: item.id, label: item.name + (item.signedIn ? ' · Signed in' : item.configured ? ' · Configured' : '') })), disabled: !providers.length });
        keySlot.update({ hidden: credential.hidden });
        key.update({ label: 'API key', disabled: credential.hidden, required: credential.required, placeholder: credential.placeholder });
        status.update({ text: credential.status, role: 'description' });
        hint.update({ text: credential.hint ?? '', role: 'description' });
        baseURL.update({ label: 'API base URL', disabled: false });
        form.update({ submitLabel: 'Save settings', submitDisabled: state.ready !== true || !!state.testing || writing || !!state.disabled, error: localError || state.error, pending: writing });
        removeSlot.update({ hidden: !credential.removeVisible });
        remove.update({ label: 'Remove saved key', intent: 'danger', disabled: unavailable || !!state.testing || state.ready !== true });
        test.update({ label: state.testing ? 'Cancel test' : 'Test connection', disabled: unavailable || state.ready !== true });
        testResult.update({ message: state.testResult?.message ?? '', tone: state.testResult?.ok === false ? 'error' : state.testResult?.ok ? 'success' : 'info' });
        add.update({ label: 'Add model connection', disabled: unavailable });
        diagnostics.update({ label: 'Save diagnostics', disabled: unavailable });
        renderProviderActions();
    }
    async function write(kind: 'submit' | 'remove') {
        if (!active() || writing || state.disabled || state.testing || state.ready !== true)
            return { ok: false as const, error: 'This action is unavailable.' };
        const token = ++writeToken, submittedRevision = revision;
        writing = true;
        localError = '';
        render();
        const value = draft();
        const result = await resultOf(() => kind === 'submit' ? callbacks.onSubmit?.(value) : callbacks.onRemoveKey?.(value));
        if (active() && token === writeToken) {
            writing = false;
            if (!result.ok)
                localError = result.error;
            render();
            if (result.ok && submittedRevision === revision)
                surface.close();
        }
        return result;
    }
    surface = hub.open('settings', 'Settings', createStack({ children: [appearance, providerActions, provider, form, createToolbar({ label: 'Connection actions', children: [test, add] }), testResult, updates, diagnostics] }), callbacks.onClose, () => { closed = { ...draft(), apiKey: '' }; key.reset(''); disposed = true; writeToken++; });
    render();
    renderUpdates();
    return {
        ...surface, update(next) { if (active()) {
            state = next;
            render();
        } }, read: () => active() ? draft() : { ...closed },
        setProviders(items, selected) { if (!active())
            return; providers = items; render(); if (selected !== undefined)
            provider.reset(selected); },
        resetProvider(value) { if (!active())
            return; revision++; writeToken++; writing = false; localError = ''; form.resetSubmission(); provider.reset(value.provider); baseURL.reset(value.baseUrl); if (value.clearKey)
            key.reset(''); if (value.collapseAdvanced)
            advanced.setOpen(false); render(); },
        setCredential(view) { if (active()) {
            credential = view;
            render();
        } }, clearSecrets() { key.reset(''); closed.apiKey = ''; },
        updateUpdates(value) { if (active()) {
            updateState = value;
            updateError = '';
            retryCheck = false;
            renderUpdates();
        } }, setUpdatePending(value) { if (active()) {
            externalPending = value;
            renderUpdates();
        } }, setUpdateError(message, options) { if (active()) {
            updateError = message;
            retryCheck = !!options?.allowCheckRetry;
            renderUpdates();
        } },
        fail(message) { if (active()) {
            localError = message;
            render();
        } },
    };
}
