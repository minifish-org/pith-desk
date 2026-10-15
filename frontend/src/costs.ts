import type { State } from './app-state';

import { createCostLedger } from 'pith-ui';
export { formatCost } from 'pith-ui';
import type { ApiRequest } from './api';
export type { CostSummary } from './contract.generated';

// The snapshot carries only totals. Read the ledger when its inline disclosure
// is open, once per saved-request revision rather than on every streamed token.
export function createCostUI(api: { state: () => State; request: ApiRequest }) {
  const section = document.getElementById('cost-requests') as HTMLDetailsElement;
  const runtime = document.getElementById('run-status') as HTMLDetailsElement;
  const content = document.getElementById('cost-ledger')!;
  let conversationId: string | null = null;
  let key = '';
  let generation = 0;
  let loading = false;
  let loaded = false;
  let failed = false;

  const ledger = createCostLedger({ container: content });

  function render() {
    const state = api.state();
    const cost = state.runtime?.cost;
    if (conversationId !== state.activeId) {
      conversationId = state.activeId;
      section.open = false;
      ledger.clear();
    }
    const nextKey = JSON.stringify([state.activeId, state.runtime?.runId, cost?.requestCount, cost?.unavailable]);
    if (key !== nextKey) {
      key = nextKey;
      generation++;
      loading = loaded = failed = false;
    }
    section.hidden = !state.activeId || (!cost?.requestCount && !cost?.unavailable);
    if (section.hidden || !section.open || !runtime.open || loading || loaded) return;
    loading = true;
    const seq = generation;
    ledger.loading();
    void api.request('/api/costs', { query: { id: state.activeId } }).then((report) => {
      if (seq !== generation) return;
      ledger.update(report);
    }).catch(() => {
      if (seq !== generation) return;
      failed = true;
      ledger.setError('Request breakdown could not be loaded. Reopen this section to retry.');
    }).finally(() => {
      if (seq === generation) { loading = false; loaded = true; }
    });
  }

  const toggle = () => { if (!section.open && failed) loaded = false; render(); };
  section.addEventListener('toggle', toggle);
  runtime.addEventListener('toggle', render);
  return { render, destroy(): void { generation++; section.removeEventListener('toggle', toggle); runtime.removeEventListener('toggle', render); ledger.destroy(); } };
}
