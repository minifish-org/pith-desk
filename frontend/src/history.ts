import type { SDKDialog } from './sdk-dialog.ts';
import type { SDKFeatureAPI } from './sdk-feature-api.ts';
import { escape } from './ui.ts';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
type API = Pick<SDKFeatureAPI, 'state' | 'request'>;
export function createHistoryUI(api: API, dialog: SDKDialog) {
    const { open, act, fail } = dialog;
    async function history() {
        const id = api.state().activeId;
        if (!id)
            return;
        const seq = open('Conversation branches', '<p>Loading history…</p>');
        const nodes = await api.request('/api/history', { query: { id } });
        if (!dialog.current(seq))
            return;
        open('Conversation branches', `<p class="modal-description">Continue from any saved message. Other branches remain available here; files and external actions are not undone.</p><div class="branch-list">${(nodes || []).map((node) => `<article class="branch-node ${node.active ? 'current-branch' : ''}"><div class="connection-card-heading"><strong>${escape(node.role)}${node.active ? ' · current branch' : ''}</strong><button class="secondary-button" data-branch="${escape(node.id)}">Continue here</button></div><p>${escape(node.text.slice(0, 360) || '(Image or empty reply)')}</p></article>`).join('') || '<p>No history yet.</p>'}</div>`);
        $('sdk-content').onclick = async (event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-branch]'); if (target && await act('/api/branch', { id, nodeId: target.dataset.branch! }))
            $<HTMLDialogElement>('sdk-dialog').close(); };
    }
    return { history };
}
