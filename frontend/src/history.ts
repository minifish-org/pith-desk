import { createBranchHistory, createFeatureStatus } from 'pith-ui';
import type { SDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type API = Pick<SDKFeatureAPI, 'state' | 'request'>;
export function createHistoryUI(api: API, dialog: SDKDialog) {
    const { open, act, fail } = dialog;
    async function history() {
        const id = api.state().activeId;
        if (!id)
            return;
        const seq = open('Conversation branches', createFeatureStatus({message: 'Loading history…'}));
        const nodes = await api.request('/api/history', { query: { id } });
        if (!dialog.current(seq))
            return;
        open('Conversation branches', createBranchHistory({nodes: nodes || []}, {onContinue: async (nodeId) => {
            if (await act('/api/branch', {id, nodeId})) $<HTMLDialogElement>('sdk-dialog').close();
        }}));
    }
    return { history };
}
