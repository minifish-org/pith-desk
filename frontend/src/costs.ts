import type { State } from './main';

export interface CostSummary {
  total: number;
  runTotal: number;
  requestCount: number;
  unknownRequests: number;
  runRequests: number;
  runUnknownRequests: number;
  unavailable?: boolean;
}

type RequestCost = {
  id: string; time: string; provider: string; providerName?: string;
  model: string; modelName?: string; purpose: string; status: string;
  known: boolean; source: string; price: unknown;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; cost: { total: number } };
};
type CostReport = CostSummary & { requests: RequestCost[] };
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
const numbers = new Intl.NumberFormat();
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function formatCost(cost: CostSummary | undefined, latestTask = false): string {
  if (cost?.unavailable) return 'Unavailable';
  const count = latestTask ? cost?.runRequests : cost?.requestCount;
  const unknown = (latestTask ? cost?.runUnknownRequests : cost?.unknownRequests) || 0;
  if (!count) return 'Not recorded';
  if (count === unknown) return 'Unknown';
  return `~${currency.format((latestTask ? cost?.runTotal : cost?.total) || 0)}${unknown ? ' (partial)' : ''}`;
}

// The snapshot carries only totals. Read the ledger when its inline disclosure
// is open, once per saved-request revision rather than on every streamed token.
export function createCostUI(api: { state: () => State; request: <T>(path: string) => Promise<T> }) {
  const section = document.getElementById('cost-requests') as HTMLDetailsElement;
  const runtime = document.getElementById('run-status') as HTMLDetailsElement;
  const content = document.getElementById('cost-ledger')!;
  let conversationId: string | null = null;
  let key = '';
  let generation = 0;
  let loading = false;
  let loaded = false;
  let failed = false;

  function show(report: CostReport) {
    const expanded = new Set(Array.from(content.querySelectorAll<HTMLDetailsElement>('details[data-cost-id][open]'), (row) => row.dataset.costId));
    const n = (value: number) => numbers.format(value || 0);
    content.innerHTML = `<p class="cost-note">USD estimates for recorded requests, not a provider bill. Prices are saved per request; retries and context summaries are included when usage is reported. ${report.unknownRequests ? `${report.unknownRequests} request(s) have unknown prices or usage and are excluded. ` : ''}Older requests made before recording began are not reconstructed.</p><div class="cost-table"><table><thead><tr><th>Request</th><th>Input</th><th>Output</th><th>Cache read / write</th><th>Estimate</th></tr></thead><tbody>${report.requests.map((r) => `<tr><td><strong>${escape(r.purpose)} · ${escape(r.status)}</strong><br>${escape(r.providerName || r.provider)} / ${escape(r.modelName || r.model)}<br><small>${escape(r.time)}</small><details data-cost-id="${escape(r.id)}" ${expanded.has(r.id) ? 'open' : ''}><summary>Price source and rates (USD / million tokens)</summary><p>${escape(r.source)}</p><pre>${escape(JSON.stringify(r.price, null, 2))}</pre>${r.usage.reasoning != null ? `<p>Reasoning tokens: ${n(r.usage.reasoning)} (included in output)</p>` : ''}</details></td><td>${n(r.usage.input)}</td><td>${n(r.usage.output)}</td><td>${n(r.usage.cacheRead)} / ${n(r.usage.cacheWrite)}</td><td>${r.known ? currency.format(r.usage.cost.total) : 'Unknown'}</td></tr>`).join('') || '<tr><td colspan="5">No recorded requests yet.</td></tr>'}</tbody></table></div>`;
  }

  function render() {
    const state = api.state();
    const cost = state.runtime?.cost;
    if (conversationId !== state.activeId) {
      conversationId = state.activeId;
      section.open = false;
      content.replaceChildren();
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
    if (!content.childElementCount) content.textContent = 'Loading request breakdown…';
    void api.request<CostReport>(`/api/costs?id=${encodeURIComponent(state.activeId!)}`).then((report) => {
      if (seq !== generation) return;
      show(report);
    }).catch(() => {
      if (seq !== generation) return;
      failed = true;
      content.textContent = 'Request breakdown could not be loaded. Reopen this section to retry.';
    }).finally(() => {
      if (seq === generation) { loading = false; loaded = true; }
    });
  }

  section.addEventListener('toggle', () => { if (!section.open && failed) loaded = false; render(); });
  runtime.addEventListener('toggle', render);
  return { render };
}
