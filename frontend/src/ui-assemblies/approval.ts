/** Internal consumer assembly. Tool identity, approval policy and requests remain in Desk. */
import {
  createBadgePart,createButtonPart,createCalloutActionsPart,createCalloutHeadingPart,createCalloutPart,
  createCodePropertyPart,createFeedbackPart,createFoldingPart,createIconPart,createPaginationPart,
  createPreformattedPart,createStackPart,createTextPart,
  type ButtonPart,type PaginationPart,type StackPart,
} from 'pith-ui';

export interface Approval {id: string;toolName: string;warning?: string;canAlwaysAllow: boolean;argsText: string;preview?: {kind: string;path: string;error?: string;diff?: string;truncated?: boolean}}
export interface ApprovalState {approval: Approval|null;disabled?: boolean}
export interface ApprovalComposition {readonly part: StackPart;update(state: Readonly<ApprovalState>): void;destroy(): void}
const pageBytes = 256 * 1024;
function rangesFor(bytes: Uint8Array): Array<[number,number]> {
  const ranges: Array<[number,number]> = [];
  for (let start = 0;start < bytes.length;) {
    let end = Math.min(start+pageBytes,bytes.length);while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end < bytes.length) for (let index = end-1;index >= start+pageBytes/2-1;index--) if (bytes[index] === 10) {end = index+1;break;}
    ranges.push([start,end]);start = end;
  }
  return ranges.length ? ranges : [[0,0]];
}
function paged(host: StackPart,initial: string,kind: 'text'|'diff',current: () => boolean) {
  let text: string|undefined,bytes = new Uint8Array(),ranges: Array<[number,number]> = [[0,0]],page = 0,pager: PaginationPart|undefined;
  const decoder = new TextDecoder('utf-8',{fatal: true});
  function render(): void {
    const [start,end] = ranges[page]!,value = decoder.decode(bytes.subarray(start,end));
    const content = createPreformattedPart({kind,text: value,...(kind === 'diff' ? {label: 'Proposed file changes'} : {})});
    pager?.update({page,total: ranges.length});host.replace([...(pager ? [pager] : []),content]);
  }
  const update = (next: string) => {
    if (text === next) return;text = next;bytes = new TextEncoder().encode(next);ranges = rangesFor(bytes);page = 0;
    pager = ranges.length > 1 ? createPaginationPart({page,total: ranges.length,onPage(next) {if (current()) {page = next;render();}}}) : undefined;render();
  };
  update(initial);return {update};
}

export function composeApproval(initial: Readonly<ApprovalState>,callbacks: {onAction?(id: string,action: 'deny'|'always'|'allow'): void} = {}): ApprovalComposition {
  let alive = true,current: Approval|null = null,view: ReturnType<typeof createReview>|undefined;
  const part = createStackPart({children: [],onDispose() {alive = false;current = null;view = undefined;}});
  function createReview(approval: Readonly<Approval>) {
    const id = approval.id,isCurrent = () => alive && current?.id === id;
    const badge = createBadgePart({purpose: 'code',text: ''}),warning = createTextPart({role: 'warning-paragraph',text: '',hidden: true});
    const heading = createCalloutHeadingPart({children: [createIconPart({name: 'shield'}),createStackPart({children: [createTextPart({role: 'strong',text: 'Pith needs your permission'}),createTextPart({text: 'Review this action before it runs.'})]}),badge]});
    const file = createCodePropertyPart({purpose: 'location',label: '',value: '',hidden: true}),error = createFeedbackPart({presentation: 'note',message: '',tone: 'info',hidden: true}),diff = createStackPart({children: [],hidden: true});
    const shortened = createTextPart({role: 'footnote',text: 'Preview shortened. Expand Tool arguments for the complete change.',hidden: true});
    const args = createStackPart({children: []});let argsPages: ReturnType<typeof paged>|undefined,diffPages: ReturnType<typeof paged>|undefined;
    function showArgs(): void {if (isCurrent() && !argsPages && (!current!.preview || folding.isOpen())) argsPages = paged(args,current!.argsText,'text',isCurrent);}
    const folding = createFoldingPart({purpose: 'review',title: 'Tool arguments',body: args,collapsible: !!approval.preview,open: !!approval.preview?.error,onToggle: showArgs});
    const scope = createTextPart({role: 'scope-note',text: 'Workspace permission applies to this conversation. Commands and external connection tools still need approval.',hidden: true});
    const buttons = new Map<'deny'|'always'|'allow',ButtonPart>();
    for (const action of ['deny','always','allow'] as const) buttons.set(action,createButtonPart({label: action === 'deny' ? 'Deny' : action === 'always' ? 'Always allow workspace changes' : 'Allow this action',variant: action === 'deny' ? 'secondary' : action === 'always' ? 'caution' : 'primary',...(action === 'allow' ? {icon: 'check' as const} : {}),onAction() {if (isCurrent() && (action !== 'always' || current!.canAlwaysAllow)) callbacks.onAction?.(id,action);}}));
    const card = createCalloutPart({tone: 'warning',label: 'Tool approval required',children: [heading,warning,file,error,diff,shortened,folding,scope,createCalloutActionsPart({children: [...buttons.values()]})]});
    return {card,update(next: Readonly<Approval>,disabled: boolean) {
      badge.update({text: next.toolName});warning.update({text: next.warning ?? '',hidden: !next.warning});
      const preview = next.preview;file.update({label: preview?.kind === 'create' ? 'Create file' : 'Modify file',value: preview?.path ?? '',hidden: !preview});
      error.update({message: preview?.error ?? '',tone: 'info',hidden: !preview?.error});diff.update({hidden: !preview || !!preview.error});shortened.update({text: 'Preview shortened. Expand Tool arguments for the complete change.',hidden: !preview || !!preview.error || !preview.truncated});
      if (preview && !preview.error) {if (diffPages) diffPages.update(preview.diff || 'No content changes.');else diffPages = paged(diff,preview.diff || 'No content changes.','diff',isCurrent);}
      else if (diffPages) {diff.replace([]);diffPages = undefined;}
      folding.update({title: 'Tool arguments',collapsible: !!preview});showArgs();argsPages?.update(next.argsText);scope.update({text: 'Workspace permission applies to this conversation. Commands and external connection tools still need approval.',hidden: !next.canAlwaysAllow});
      buttons.get('deny')!.update({label: 'Deny',variant: 'secondary',disabled});buttons.get('always')!.update({label: 'Always allow workspace changes',variant: 'caution',disabled,hidden: !next.canAlwaysAllow});buttons.get('allow')!.update({label: 'Allow this action',variant: 'primary',icon: 'check',disabled});
    }};
  }
  const update = (next: Readonly<ApprovalState>) => {
    if (!alive) return;const approval = next.approval,changed = approval?.id !== current?.id;
    if (changed || !approval) {part.replace([]);view = undefined;}
    current = approval;if (!approval) return;
    if (!view) {view = createReview(approval);part.replace([view.card]);}
    view.update(approval,!!next.disabled);
  };
  update(initial);return {part,update,destroy() {alive = false;current = null;view = undefined;part.destroy();}};
}
