import { createFeatureDialogFrame, type DialogContent } from 'pith-ui';
import type { MutationInput, MutationPath } from './api.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { showDialogError } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
export function createSDKDialog(api: Pick<SDKFeatureAPI, 'mutate' | 'error'>, onClose?: () => void) {
    let generation = 0;
    const frame = createFeatureDialogFrame({dialog: $<HTMLDialogElement>('sdk-dialog'), content: $('sdk-content'), dialogId: 'sdk-dialog', titleId: 'sdk-title', errorId: 'sdk-error', eyebrow: 'PITH RESOURCES & CONNECTIONS', onClose() {generation++; onClose?.();}});
    const open = (title: string, body: Node | DialogContent) => {generation++; frame.open({title, body}); return generation;};
    const fail = (message: string, owner?: HTMLElement) => owner ? showDialogError(owner, message) : frame.fail(message);
    const act = async <P extends MutationPath>(path: P, payload: MutationInput<P>, owner: HTMLElement = $('sdk-content')) => {
        const seq = generation;
        const ownerDialog = owner.closest<HTMLDialogElement>('dialog');
        const errorScope = owner.querySelector<HTMLElement>('[data-dialog-error]') || owner;
        if (await api.mutate(path, payload)) return true;
        // Provider and MCP actions report to their own dialog, even while the
        // SDK resource dialog is closed. Replaced forms cannot receive old errors.
        const currentOwner = owner.isConnected && errorScope.isConnected && owner.contains(errorScope) && (!ownerDialog || ownerDialog.open);
        const currentSDK = ownerDialog !== frame.element || seq === generation;
        if (currentOwner && currentSDK) fail(api.error(), owner);
        return false;
    };
    return {open, fail, act, close: frame.close, destroy() {generation++; frame.destroy();}, current: (seq: number) => seq === generation && frame.isOpen()};
}
export type SDKDialog = ReturnType<typeof createSDKDialog>;
