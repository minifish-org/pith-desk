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
        $('sdk-content').onclick = null;
        $('sdk-content').innerHTML = heading(title) + body + '<p id="sdk-error" data-dialog-error class="form-error" role="alert"></p>';
        if (!$<HTMLDialogElement>('sdk-dialog').open)
            $<HTMLDialogElement>('sdk-dialog').showModal();
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
