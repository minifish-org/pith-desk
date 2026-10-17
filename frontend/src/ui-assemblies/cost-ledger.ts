/** Internal consumer assembly. Saved requests and price estimates remain Desk data. */
import {createContentViewportPart,createDisclosurePart,createLineBreakPart,createPreformattedPart,createTablePart,createTableRowPart,createTextPart,type ContentViewportPart,type DisclosurePart,type PreformattedPart,type TablePart,type TableRowPart,type TextPart} from 'pith-ui';

export interface CostRequestDisplay {id: string;purpose: string;status: string;provider: string;providerName?: string;model: string;modelName?: string;time: string;source: string;price: unknown;known: boolean;usage: {input: number;output: number;cacheRead: number;cacheWrite: number;reasoning?: number;cost: {total: number}}}
export interface CostLedgerState {unknownRequests: number;requests: readonly CostRequestDisplay[]|null}
export interface CostSummaryDisplay {unavailable?: boolean;requestCount: number;unknownRequests: number;runRequests: number;runUnknownRequests: number;total: number;runTotal: number}
export interface CostLedgerComposition {readonly part: ContentViewportPart;update(report: Readonly<CostLedgerState>): void;loading(): void;setError(message: string): void;clear(): void;destroy(): void}
const currency = new Intl.NumberFormat('en-US',{style: 'currency',currency: 'USD',minimumFractionDigits: 2,maximumFractionDigits: 6}),numbers = new Intl.NumberFormat(),n = (value: number) => numbers.format(value || 0);
/** Local business formatter retained beside the Desk assembly, not a UI export. */
export function formatCost(cost: CostSummaryDisplay|undefined,latestTask = false): string {
  if (cost?.unavailable) return 'Unavailable';const count = latestTask ? cost?.runRequests : cost?.requestCount,unknown = (latestTask ? cost?.runUnknownRequests : cost?.unknownRequests) || 0;
  if (!count) return 'Not recorded';if (count === unknown) return 'Unknown';return `~${currency.format((latestTask ? cost?.runTotal : cost?.total) || 0)}${unknown ? ' (partial)' : ''}`;
}
interface Row {part: TableRowPart;purpose: TextPart;identity: TextPart;time: TextPart;details: DisclosurePart;source: TextPart;price: PreformattedPart;reasoning: TextPart}
export function composeCostLedger(): CostLedgerComposition {
  let alive = true,table: TablePart|undefined,note: TextPart|undefined;
  const rows = new Map<string,Row>(),part = createContentViewportPart({purpose: 'plain',content: '',onDispose() {alive = false;rows.clear();table = undefined;note = undefined;}});
  const clear = () => {if (!alive) return;part.replace([]);rows.clear();table = undefined;note = undefined;};
  const createRow = (): Row => {
    const purpose = createTextPart({role: 'strong',text: ''}),identity = createTextPart({text: ''}),time = createTextPart({role: 'small',text: ''}),source = createTextPart({role: 'paragraph',text: ''}),price = createPreformattedPart({kind: 'plain',text: ''}),reasoning = createTextPart({role: 'paragraph',text: '',hidden: true}),details = createDisclosurePart({title: 'Price source and rates (USD / million tokens)',children: [source,price,reasoning]});
    return {part: createTableRowPart({cells: [[purpose,createLineBreakPart(),identity,createLineBreakPart(),time,details],'','','','']}),purpose,identity,time,details,source,price,reasoning};
  };
  const update = (report: Readonly<CostLedgerState>) => {
    if (!alive) return;
    if (!table) {note = createTextPart({role: 'paragraph',text: ''});table = createTablePart({headers: ['Request','Input','Output','Cache read / write','Estimate'],rows: [],emptyLabel: 'No recorded requests yet.'});part.replace([note,table]);}
    note!.update({text: `USD estimates for recorded requests, not a provider bill. Prices are saved per request; retries and context summaries are included when usage is reported. ${report.unknownRequests ? `${report.unknownRequests} request(s) have unknown prices or usage and are excluded. ` : ''}Older requests made before recording began are not reconstructed.`});
    const requests = report.requests || [],current = new Set(requests.map(request => request.id)),ordered: TableRowPart[] = [];
    for (const request of requests) {
      let row = rows.get(request.id);if (!row) {row = createRow();rows.set(request.id,row);}
      row.purpose.update({text: `${request.purpose} · ${request.status}`});row.identity.update({text: `${request.providerName || request.provider} / ${request.modelName || request.model}`});row.time.update({text: request.time});row.source.update({text: request.source});row.price.update({text: JSON.stringify(request.price,null,2) ?? ''});row.reasoning.update({text: request.usage.reasoning == null ? '' : `Reasoning tokens: ${n(request.usage.reasoning)} (included in output)`,hidden: request.usage.reasoning == null});
      row.part.update({cells: [undefined,n(request.usage.input),n(request.usage.output),`${n(request.usage.cacheRead)} / ${n(request.usage.cacheWrite)}`,request.known ? currency.format(request.usage.cost.total) : 'Unknown']});ordered.push(row.part);
    }
    table.replaceRows(ordered);for (const key of rows.keys()) if (!current.has(key)) rows.delete(key);
  };
  return {part,update,clear,loading() {if (alive && !table) part.replace('Loading request breakdown…');},setError(message) {if (!alive) return;clear();part.replace(message);},destroy() {alive = false;rows.clear();part.destroy();}};
}
