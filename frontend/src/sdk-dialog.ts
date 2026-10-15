import { createFeatureDialogFrame, type DialogContent } from 'pith-ui';
import type { MutationInput, MutationPath } from './api.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { showDialogError } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
export function createSDKDialog(api: Pick<SDKFeatureAPI, 'mutate' | 'error'>) {
    let generation = 0;
    const frame = createFeatureDialogFrame({dialog: $<HTMLDialogElement>('sdk-dialog'), content: $('sdk-content'), dialogId: 'sdk-dialog', titleId: 'sdk-title', errorId: 'sdk-error', eyebrow: 'PITH RESOURCES & CONNECTIONS'});
    const open = (title: string, body: Node | DialogContent) => {generation++; frame.open({title, body}); return generation;};
    const fail = (message: string, owner: HTMLElement = $('sdk-content')) => showDialogError(owner, message);
    const act = async <P extends MutationPath>(path: P, payload: MutationInput<P>, owner: HTMLElement = $('sdk-content')) => {
        if (await api.mutate(path, payload)) return true;
        fail(api.error(), owner); return false;
    };
    $<HTMLDialogElement>('sdk-dialog').addEventListener('close', () => {if (!$<HTMLDialogElement>('sdk-dialog').open) generation++;});
    return {open, fail, act, current: (seq: number) => seq === generation && $<HTMLDialogElement>('sdk-dialog').open};
}
export type SDKDialog = ReturnType<typeof createSDKDialog>;
