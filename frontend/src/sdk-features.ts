import type { ProviderChoice } from './app-state.ts';
import { createCustomUI } from './custom-connections.ts';
import { createHistoryUI } from './history.ts';
import { createProviderLoginUI } from './provider-login.ts';
import { createResourceUI } from './resource-editor.ts';
import { createSDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI as API } from './sdk-feature-api.ts';
import { escape } from './ui.ts';
type Resource = {
    name: string;
    path: string;
    description?: string;
    content?: string;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
// These are host controls around SDK APIs, not another agent runtime.
export function createSDKUI(api: API) {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="sdk-dialog" class="modal feature-modal" aria-labelledby="sdk-title"><div id="sdk-content"></div></dialog><dialog id="oauth-dialog" class="modal" aria-labelledby="oauth-title"><div id="oauth-content"></div></dialog>');
    const dialog = createSDKDialog(api);
    const { fail, act } = dialog;
    const { custom } = createCustomUI(api, dialog);
    const { resource } = createResourceUI(api, dialog);
    const { history } = createHistoryUI(api, dialog);
    const providerLogin = createProviderLoginUI(api);
    function render() {
        const state = api.state();
        const globalActions = new Set(['custom', 'login', 'logout', 'mcp-login', 'mcp-logout', 'remove-connection']);
        for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sdk]')) {
            if (globalActions.has(button.dataset.sdk || ''))
                button.disabled = api.busy() || state.runs.length > 0;
        }
        for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sdk-idle]'))
            button.disabled = api.busy() || state.running || !state.activeId || (button.dataset.sdk === 'compact' && !state.messages.length);
        providerLogin.render();
    }
    document.addEventListener('click', async (event) => {
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sdk]');
        if (!target || target.disabled)
            return;
        try {
            switch (target.dataset.sdk) {
                case 'custom':
                    await custom(target.dataset.id);
                    break;
                case 'resource':
                    await resource(target.dataset.resourceWorkspace || '', target.dataset.kind || 'instructions', target.dataset.path);
                    break;
                case 'use-resource':
                    api.draft(target.dataset.command || '');
                    $<HTMLDialogElement>('resources-dialog').close();
                    break;
                case 'history':
                    await history();
                    break;
                case 'branch':
                    if (await api.mutate('/api/branch', { id: api.state().activeId, nodeId: target.dataset.node! }))
                        api.draft('');
                    break;
                case 'compact':
                    if (await act('/api/compact', { id: api.state().activeId }))
                        $<HTMLDialogElement>('sdk-dialog').close();
                    break;
                case 'mcp-login':
                    providerLogin.resetDismissed();
                    await act('/api/mcp/oauth/start', { name: target.dataset.id! }, target.closest('dialog')!);
                    break;
                case 'mcp-logout':
                    if (await act('/api/mcp/oauth/logout', { name: target.dataset.id! }, target.closest('dialog')!))
                        await api.refreshMCP();
                    break;
                case 'login':
                    providerLogin.resetDismissed();
                    await act('/api/oauth/start', { provider: target.dataset.id! }, target.closest('dialog')!);
                    break;
                case 'logout':
                    if (await act('/api/oauth/logout', { provider: target.dataset.id! }, target.closest('dialog')!))
                        api.refreshProviderAuth(target.dataset.id!);
                    break;
                case 'cancel-login':
                    await act('/api/oauth/cancel', {}, target.closest('dialog')!);
                    break;
                case 'remove-connection':
                    api.confirm({ title: 'Remove model connection?', action: 'Remove connection', description: `Remove <strong>${escape(target.dataset.id)}</strong> and its saved credentials?`, hint: 'Existing conversations and workspace files stay available.', scope: { global: true }, unavailable: () => api.busy() || api.state().runs.length > 0, error: api.error, run: async () => { if (!await api.mutate('/api/remove-model-connection', { id: target.dataset.id! }))
                            return false; api.settings(); return true; } });
                    break;
            }
        }
        catch (error) {
            fail(String(error), $<HTMLDialogElement>('sdk-dialog').open ? $('sdk-content') : target.closest('dialog') || document.body);
        }
    });
    return {
        render,
        providerActions(provider: ProviderChoice) {
            return `<div class="feature-toolbar">${provider.oauth ? `<button type="button" class="secondary-button" data-sdk="${provider.signedIn ? 'logout' : 'login'}" data-id="${escape(provider.id)}">${provider.signedIn ? 'Sign out' : 'Sign in with provider'}</button>` : ''}${provider.custom ? `<button type="button" class="secondary-button" data-sdk="custom" data-id="${escape(provider.id)}">Edit models and prices</button><button type="button" class="secondary-button destructive-button" data-sdk="remove-connection" data-id="${escape(provider.id)}">Remove connection</button>` : ''}</div>`;
        },
        resourceActions(kind: string, resource: Resource, workspaceId: string) {
            const command = kind === 'skill' ? `/skill:${resource.name} ` : `/${resource.name} `;
            return `<div class="file-actions">${kind !== 'instructions' ? `<button class="secondary-button" data-sdk="use-resource" data-command="${escape(command)}">Use</button>` : ''}<button class="secondary-button" data-sdk="resource" data-resource-workspace="${escape(workspaceId)}" data-kind="${kind}" data-path="${escape(resource.path)}">View / edit</button></div>`;
        },
    };
}
