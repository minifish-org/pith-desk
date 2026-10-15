import { createFeatureDialogFrame, createProviderLoginPanel } from 'pith-ui';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
export function createProviderLoginUI(api: Pick<SDKFeatureAPI, 'state' | 'mutate' | 'error' | 'refreshProviderAuth'>) {
    const frame = createFeatureDialogFrame({dialog: $<HTMLDialogElement>('oauth-dialog'), content: $('oauth-content'), dialogId: 'oauth-dialog', titleId: 'oauth-title', errorId: 'oauth-dialog-error', eyebrow: 'PROVIDER ACCOUNT'});
    let loginSignature = '';
    let dismissedLogin = '';
    let panel: ReturnType<typeof createProviderLoginPanel> | undefined;
    let loginId = '';
    function render() {
        const state = api.state();
        const login = state.login;
        if (!login)
            return;
        const signature = JSON.stringify(login);
        if (signature === loginSignature)
            return;
        loginSignature = signature;
        if (login.phase === 'complete')
            api.refreshProviderAuth(login.provider);
        if (dismissedLogin === login.id)
            return;
        if (panel && loginId === login.id) panel.update(login);
        else {
            panel = createProviderLoginPanel(login, {idPrefix: '', onAnswer: async (answer) => {
                const ok = await api.mutate('/api/oauth/answer', {id: login.id, answer});
                return ok ? {ok: true} : {ok: false, error: api.error()};
            }});
            loginId = login.id;
            frame.open({title: 'Provider sign-in', body: panel});
        }
    }
    $<HTMLDialogElement>('oauth-dialog').addEventListener('close', () => { if ($<HTMLDialogElement>('oauth-dialog').open) return; panel = undefined; dismissedLogin = api.state().login?.id || ''; if (api.state().login && !['complete', 'error'].includes(api.state().login!.phase))
        void api.mutate('/api/oauth/cancel', {}); });
    return { render, resetDismissed() { dismissedLogin = ''; loginSignature = ''; } };
}
