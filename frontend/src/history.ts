import type {SDKFeatureAPI} from './sdk-feature-api.ts';

type API = Pick<SDKFeatureAPI, 'ui' | 'state' | 'request' | 'mutate' | 'error'>;
export function createHistoryUI(api: API) {
    let generation = 0;
    async function history(): Promise<void> {
        const id = api.state().activeId;
        if (!id) return;
        const sequence = ++generation;
        const session = api.ui.workspace.openHistory({nodes: null, loading: true}, {onContinue: async nodeId => {
            const saved = await api.mutate('/api/branch', {id, nodeId});
            return saved ? {ok: true} : {ok: false, error: api.error()};
        }});
        const current = () => sequence === generation && session.isOpen() && api.state().activeId === id;
        try {
            const nodes = await api.request('/api/history', {query: {id}});
            if (current()) session.update({nodes: nodes || [], loading: false});
        } catch (error) {if (current()) session.fail(error instanceof Error ? error.message : String(error));}
    }
    return {history, destroy() {generation++;}};
}
