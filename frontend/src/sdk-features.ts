import type {ActionResult, ProviderAction, ProviderActionsState, ProviderActionTarget} from './ui-contract.ts';
import type {ProviderChoice} from './app-state.ts';
import type {MutationInput, MutationPath} from './api.ts';
import {createCustomUI} from './custom-connections.ts';
import {createHistoryUI} from './history.ts';
import {createProviderLoginUI} from './provider-login.ts';
import {createResourceUI} from './resource-editor.ts';
import type {SDKFeatureAPI as API} from './sdk-feature-api.ts';

// Requests and transactions stay here; scenes own every control and error view.
export function createSDKUI(api: API, onDialogClose?: () => void) {
    let destroyed = false;
    const customUI = createCustomUI(api);
    const resourceUI = createResourceUI(api);
    const historyUI = createHistoryUI(api);
    const providerLogin = createProviderLoginUI(api, onDialogClose);
    const unavailable = (): ActionResult => ({ok: false, error: 'This action is no longer available.'});
    const globalUnavailable = () => destroyed || api.busy() || api.state().runs.length > 0;
    const failure = (error: unknown): ActionResult => ({ok: false, error: error instanceof Error ? error.message : String(error)});
    async function act<P extends MutationPath>(path: P, payload: MutationInput<P>): Promise<ActionResult> {
        if (destroyed) return unavailable();
        try {return await api.mutate(path, payload) ? {ok: true} : {ok: false, error: api.error()};}
        catch (error) {return failure(error);}
    }
    async function custom(id?: string): Promise<void> {
        if (!globalUnavailable()) await customUI.custom(id);
    }
    async function providerAction(action: ProviderAction, target: ProviderActionTarget): Promise<ActionResult> {
        if (globalUnavailable()) return unavailable();
        const id = target.id;
        try {
            switch (action) {
                case 'custom':
                    await custom(id);
                    return {ok: true};
                case 'login':
                    providerLogin.resetDismissed();
                    return await act('/api/oauth/start', {provider: id});
                case 'logout': {
                    const result = await act('/api/oauth/logout', {provider: id});
                    if (result.ok && !destroyed) {
                        // Credential reads own their feedback after this write.
                        try {api.refreshProviderAuth(id);} catch {}
                    }
                    return result;
                }
                case 'remove-connection':
                    api.confirm({title: 'Remove model connection?', action: 'Remove connection',
                        description: {before: 'Remove ', subject: id, after: ' and its saved credentials?'},
                        hint: 'Existing conversations and workspace files stay available.', scope: {global: true},
                        unavailable: globalUnavailable, error: api.error,
                        run: async () => {
                            if (globalUnavailable()) return false;
                            if (!await api.mutate('/api/remove-model-connection', {id})) return false;
                            if (!destroyed) api.settings();
                            return true;
                        },
                    });
                    return {ok: true};
            }
        } catch (error) {return failure(error);}
    }
    async function mcpAuth(action: 'mcp-login' | 'mcp-logout', name: string): Promise<ActionResult> {
        if (globalUnavailable()) return unavailable();
        if (action === 'mcp-login') {
            providerLogin.resetDismissed();
            return act('/api/mcp/oauth/start', {name});
        }
        const result = await act('/api/mcp/oauth/logout', {name});
        if (result.ok && !destroyed) {
            // The logout is committed. Its following read reports its own error
            // in the Connections controller and must never replay this write.
            try {await api.refreshMCP();} catch {}
        }
        return result;
    }
    async function compact(): Promise<ActionResult> {
        const state = api.state();
        if (destroyed || api.busy() || state.running || !state.activeId || !state.messages.length) return unavailable();
        return act('/api/compact', {id: state.activeId});
    }
    return {
        render() {if (!destroyed) providerLogin.render();},
        custom,
        async resource(...args: Parameters<typeof resourceUI.resource>) {if (!destroyed) await resourceUI.resource(...args);},
        async history() {if (!destroyed) await historyUI.history();},
        compact,
        providerAction,
        mcpAuth,
        providerActions(provider: ProviderChoice): ProviderActionsState {
            return {id: provider.id, oauth: provider.oauth, signedIn: provider.signedIn, custom: provider.custom, disabled: globalUnavailable()};
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            providerLogin.destroy(); customUI.destroy(); resourceUI.destroy(); historyUI.destroy();
        },
    };
}
