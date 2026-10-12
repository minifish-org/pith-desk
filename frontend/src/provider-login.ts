import { sdkHeading as heading } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { escape } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
export function createProviderLoginUI(api: Pick<SDKFeatureAPI, 'state' | 'mutate' | 'error' | 'refreshProviderAuth'>) {
    let loginSignature = '';
    let dismissedLogin = '';
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
        $('oauth-content').innerHTML = heading('Provider sign-in', 'oauth-dialog') + `<p class="provider-login-status${login.phase === 'error' ? ' form-error' : ''}" role="${login.phase === 'error' ? 'alert' : 'status'}">${escape(login.message)}</p>${login.url ? `<p><a href="${escape(login.url)}" target="_blank" rel="noopener noreferrer">Open sign-in page in your browser ↗</a></p>` : ''}${login.code ? `<p>Verification code: <strong>${escape(login.code)}</strong></p>` : ''}${login.phase === 'prompt' ? `<form id="oauth-answer"><label class="field-label" for="oauth-value">${escape(login.prompt)}</label>${login.options?.length ? `<select id="oauth-value" class="feature-select">${login.options.map((o) => `<option value="${escape(o.id)}">${escape(o.label)}</option>`).join('')}</select>` : `<input id="oauth-value" type="${login.promptType === 'secret' ? 'password' : 'text'}" required autocomplete="off" />`}<button type="submit" class="primary-button">Continue</button></form>` : ''}<div id="oauth-error" class="form-error" role="alert"></div><div class="modal-footer">${['complete', 'error'].includes(login.phase) ? '<button class="secondary-button" data-close="oauth-dialog">Close</button>' : '<button class="secondary-button" data-sdk="cancel-login">Cancel sign-in</button>'}</div>`;
        if (!$<HTMLDialogElement>('oauth-dialog').open)
            $<HTMLDialogElement>('oauth-dialog').showModal();
        const form = document.getElementById('oauth-answer');
        if (form)
            form.onsubmit = async (e) => { e.preventDefault(); if (!await api.mutate('/api/oauth/answer', { id: login.id, answer: $<HTMLInputElement>('oauth-value').value }))
                $('oauth-error').textContent = api.error(); };
    }
    $<HTMLDialogElement>('oauth-dialog').addEventListener('close', () => { dismissedLogin = api.state().login?.id || ''; if (api.state().login && !['complete', 'error'].includes(api.state().login!.phase))
        void api.mutate('/api/oauth/cancel', {}); });
    return { render, resetDismissed() { dismissedLogin = ''; } };
}
