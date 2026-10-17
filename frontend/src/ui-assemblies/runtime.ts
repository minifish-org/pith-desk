/** Internal consumer assembly. Runtime values, timing and cost fetching stay in Desk. */
import {createDescriptionListPart,createDisclosurePart,createScrollAreaPart,createStackPart,createTextPart,type DescriptionEntry,type DescriptionListPart,type DisclosurePart,type Part} from 'pith-ui';

export interface RuntimeState {visible: boolean;summary: string;duration: string;speed: string;provider?: string;thinkingLevel?: string;inputTokens: string;outputTokens: string;cacheRead: string;cacheWrite: string;contextTokens: string;contextWindow: string;compactions: string;toolFailures: string;recordedCost: string;latestCost: string}
export interface RuntimeComposition {readonly part: DisclosurePart;update(state: Readonly<RuntimeState>): void;updateTiming(state: {summary: string;duration: string;speed: string}): void;updateCostsVisible(visible: boolean): void;readCosts(): {open: boolean;runtimeOpen: boolean};resetCosts(): void;destroy(): void}
const explanation = 'Duration and average speed cover the latest task, including tools and waits. Speed uses reported output tokens, including reasoning, retries and summaries; input, cache and earlier tasks are excluded. An interrupted checkpoint shows only a lower bound for duration. Session token figures come from Pith records. Context excludes system instructions and tool schemas. Costs estimate recorded requests; unknown prices and older unrecorded requests are excluded. This is not a provider bill.';

export function composeRuntime(initial: Readonly<RuntimeState>,options: {costLedger?: Part;onCostsChange?(): void} = {}): RuntimeComposition {
  let alive = true,list: DescriptionListPart|undefined,entries: DescriptionEntry[] = [];
  const values = createStackPart({children: [],onDispose() {alive = false;entries = [];}});
  const costs = createDisclosurePart({purpose: 'breakdown',title: 'Request breakdown',hidden: true,children: [options.costLedger ?? createStackPart({children: []})],onToggle() {if (alive) options.onCostsChange?.();}});
  const part = createDisclosurePart({purpose: 'status',title: initial.summary,hidden: !initial.visible,children: [createScrollAreaPart({purpose: 'metrics',children: [values,costs]})],onToggle() {if (alive) options.onCostsChange?.();}});
  const updateTiming = (state: {summary: string;duration: string;speed: string}) => {
    if (!alive) return;part.update({title: state.summary,hidden: !visible});
    if (list) {entries = entries.map(entry => entry.key === 'duration' ? {...entry,value: state.duration} : entry.key === 'speed' ? {...entry,value: state.speed} : entry);list.update(entries);}
  };
  let visible = initial.visible;
  const update = (state: Readonly<RuntimeState>) => {
    if (!alive) return;visible = state.visible;
    if (visible) {
      const fields: Array<[string,string,string]> = [];
      if (state.provider) fields.push(['provider','Provider',state.provider]);if (state.thinkingLevel) fields.push(['thinking','Thinking effort',state.thinkingLevel]);
      fields.push(['duration','Latest task duration',state.duration],['speed','Avg. output tokens/s',state.speed],['tokens','Session input / output',`${state.inputTokens} / ${state.outputTokens}`],['cache','Cache read / write',`${state.cacheRead} / ${state.cacheWrite}`],['context','Estimated conversation context',`~${state.contextTokens} / ${state.contextWindow} tokens`],['compactions','Context summaries',state.compactions],['failures','Tool failures recorded',state.toolFailures],['recorded','Recorded cost (USD)',state.recordedCost],['latest','Latest task (USD)',state.latestCost],['execution','Execution','Codemode enabled · durable local task journal']);
      entries = fields.map(([key,label,value]) => ({key,label,value}));
      if (!list) {list = createDescriptionListPart({entries});values.replace([list,createTextPart({role: 'paragraph',text: explanation})]);}else list.update(entries);
    }
    updateTiming(state);
  };
  update(initial);
  return {part,update,updateTiming,updateCostsVisible(value) {if (alive) costs.update({title: 'Request breakdown',hidden: !value});},readCosts: () => ({open: alive && costs.isOpen(),runtimeOpen: alive && part.isOpen()}),resetCosts() {if (alive) costs.setOpen(false);},destroy() {alive = false;entries = [];part.destroy();}};
}
