import type { ProviderLoginSession } from './ui-contract.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
export function createProviderLoginUI(api: Pick<SDKFeatureAPI, 'ui' | 'state' | 'mutate' | 'error' | 'refreshProviderAuth'>, onDialogClose?: () => void) {
    let loginSignature = '';
    let dismissedLogin = '';
    let panel: ProviderLoginSession | undefined;
    let loginId = '';
    let destroyed = false;
    function render() {
        if (destroyed) return;
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
        if (panel?.isOpen() && loginId === login.id) panel.update(login);
        else {
            const id = login.id;
            panel = api.ui.settings.openProviderLogin(login, {onAnswer: async (answer) => {
                const ok = await api.mutate('/api/oauth/answer', {id: login.id, answer});
                return ok ? {ok: true} : {ok: false, error: api.error()};
            }, onClose() {
                if (loginId === id) panel = undefined;
                const active = api.state().login;
                if (destroyed || active?.id !== id) return;
                dismissedLogin = id;
                if (!['complete','error'].includes(active.phase)) void api.mutate('/api/oauth/cancel',{});
                onDialogClose?.();
            }});
            loginId = login.id;
        }
    }
    return { render, resetDismissed() { dismissedLogin = ''; loginSignature = ''; }, destroy() {if (destroyed) return; destroyed = true; panel?.destroy(); panel = undefined;} };
}
