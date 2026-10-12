import type { MutationInput, MutationPath } from './api.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { dialogHeading, showDialogError } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
export function sdkHeading(title: string, id = 'sdk-dialog') { return dialogHeading(title, id === 'sdk-dialog' ? 'sdk-title' : 'oauth-title', id, id === 'sdk-dialog' ? 'PITH RESOURCES & CONNECTIONS' : 'PROVIDER ACCOUNT'); }
export function createSDKDialog(api: Pick<SDKFeatureAPI, 'mutate' | 'error'>) {
    let generation = 0;
    const heading = sdkHeading;
    const open = (title: string, body: string) => {
        generation++;
        const dialog = $<HTMLDialogElement>('sdk-dialog');
        const content = $('sdk-content');
        const active = document.activeElement;
        const restoreFocus = dialog.open && !!active && (content.contains(active) || active === dialog || active === document.body);
        const activeId = restoreFocus ? active?.id : '';
        content.onclick = null;
        content.innerHTML = heading(title) + body + '<p id="sdk-error" data-dialog-error class="form-error" role="alert"></p>';
        if (!dialog.open)
            dialog.showModal();
        else if (restoreFocus) {
            const previous = activeId ? document.getElementById(activeId) : null;
            const target = previous && content.contains(previous) ? previous : content.querySelector<HTMLElement>('[data-close="sdk-dialog"]');
            target?.focus({ preventScroll: true });
        }
        return generation;
    };
    const fail = (message: string, owner: HTMLElement = $('sdk-content')) => showDialogError(owner, message);
    const act = async <P extends MutationPath>(path: P, payload: MutationInput<P>, owner: HTMLElement = $('sdk-content')) => {
        if (await api.mutate(path, payload))
            return true;
        fail(api.error(), owner);
        return false;
    };
    $<HTMLDialogElement>('sdk-dialog').addEventListener('close', () => { generation++; $('sdk-content').innerHTML = ''; });
    return { open, fail, act, current: (seq: number) => seq === generation };
}
export type SDKDialog = ReturnType<typeof createSDKDialog>;
