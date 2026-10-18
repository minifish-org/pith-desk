import type { State } from './app-state';

import type { Application } from './ui-contract.ts';
export { formatCost } from 'pith-ui/recipes';
import type { ApiRequest } from './api';
export type { CostSummary } from './contract.generated';

// The snapshot carries only totals. Read the ledger when its inline disclosure
// is open, once per saved-request revision rather than on every streamed token.
export function createCostUI(api: { ui: Application; state: () => State; request: ApiRequest }) {
  let conversationId: string | null = null;
  let key = '';
  let generation = 0;
  let loading = false;
  let loaded = false;
  let failed = false;

  function render() {
    const state = api.state();
    const cost = state.runtime?.cost;
    if (conversationId !== state.activeId) {
      conversationId = state.activeId;
      api.ui.workspace.resetCosts();
    }
    const nextKey = JSON.stringify([state.activeId, state.runtime?.runId, cost?.requestCount, cost?.unavailable]);
    if (key !== nextKey) {
      key = nextKey;
      generation++;
      loading = loaded = failed = false;
    }
    const visible = !!state.activeId && !!(cost?.requestCount || cost?.unavailable);
    const disclosure = api.ui.workspace.readCosts();
    if (!disclosure.open && failed) loaded = false;
    api.ui.workspace.updateCosts({ visible });
    if (!visible || !disclosure.open || !disclosure.runtimeOpen || loading || loaded) return;
    loading = true;
    const seq = generation;
    api.ui.workspace.updateCosts({ visible, loading: true });
    void api.request('/api/costs', { query: { id: state.activeId } }).then((report) => {
      if (seq !== generation) return;
      api.ui.workspace.updateCosts({ visible, report });
    }).catch(() => {
      if (seq !== generation) return;
      failed = true;
      api.ui.workspace.updateCosts({ visible, error: 'Request breakdown could not be loaded. Reopen this section to retry.' });
    }).finally(() => {
      if (seq === generation) { loading = false; loaded = true; }
    });
  }

  return { render, destroy(): void { generation++; } };
}
