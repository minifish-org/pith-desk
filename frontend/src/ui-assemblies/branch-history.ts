/** Internal executable composition; branch identity and continuation are host data. */
import {
  createButtonPart,createCardHeadingPart,createDialogPart,createFeedbackPart,createSelectableCardPart,createStackPart,createTextPart,mountParts,
  type DialogPart,type FeedbackPart,type MountPartsOptions,type Part,type SelectableCardPart,type StackPart,type TextPart,
} from 'pith-ui';

export interface HistoryNode {id: string;role: string;text: string;active: boolean}
export interface HistoryState {nodes: readonly HistoryNode[]|null;loading?: boolean;error?: string}
export type HistoryResult = void|{ok: true}|{ok: false;error: string};
export interface HistoryCallbacks {onContinue?(id: string): HistoryResult|Promise<HistoryResult>;onClose?(): void}
export interface HistoryAssembly {update(state: Readonly<HistoryState>): void;fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void}
export interface HistoryComposition extends HistoryAssembly {readonly part: DialogPart;open(): void}

/** Standard feature dialog -> natural body -> description/list/hidden alert.
 * Every row is an independently composed article, heading, action and paragraph. */
export function composeBranchHistory(initial: Readonly<HistoryState>,callbacks: HistoryCallbacks = {}): HistoryComposition {
  let alive = true,opened = false,mode: 'feedback'|'content'|undefined;
  let dialog: DialogPart,list: StackPart,actionFeedback: FeedbackPart,status: FeedbackPart|undefined,empty: TextPart|undefined;
  const rows = new Map<string,{part: SelectableCardPart;role: TextPart;text: TextPart}>();
  const body = createStackPart({children: []}),frameFeedback = createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error'});
  const fail = (message: string) => {if (alive && dialog.isOpen()) frameFeedback.update({message,tone: 'error'});};
  function release(): void {
    if (!alive) return;const notify = opened;alive = false;opened = false;rows.clear();status = undefined;empty = undefined;dialog.destroy();
    if (notify) {try {callbacks.onClose?.();} catch {}}
  }
  function close(): void {if (alive) {dialog.close();release();}}
  dialog = createDialogPart({purpose: 'feature',title: 'Conversation branches',children: [body,frameFeedback],onClose: release,onDispose: release});
  function update(state: Readonly<HistoryState>): void {
    if (!alive) return;
    if (state.loading || state.error) {
      const feedback = {message: state.loading ? 'Loading history…' : state.error!,tone: state.loading ? 'info' as const : 'error' as const};
      if (mode !== 'feedback') {status = createFeedbackPart({presentation: 'plain',...feedback});body.replace([status]);rows.clear();empty = undefined;mode = 'feedback';}
      else status!.update(feedback);
      return;
    }
    if (mode !== 'content') {
      const description = createTextPart({role: 'description',text: 'Continue from any saved message. Other branches remain available here; files and external actions are not undone.'});
      list = createStackPart({children: []});actionFeedback = createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error',hidden: true});
      body.replace([description,list,actionFeedback]);rows.clear();status = undefined;empty = undefined;mode = 'content';
    }
    const children: Part[] = [],nodes = state.nodes ?? [],keep = new Set(nodes.map(node => node.id));
    for (const [key,row] of rows) if (!keep.has(key)) {row.part.destroy();rows.delete(key);}
    for (const node of nodes) {
      let row = rows.get(node.id);
      if (!row) {
        const role = createTextPart({role: 'strong',text: ''}),text = createTextPart({role: 'paragraph',text: ''});
        const action = createButtonPart({label: 'Continue here',variant: 'secondary',
          onAction: callbacks.onContinue ? async () => {
            if (!alive || !dialog.isOpen()) return;
            actionFeedback.update({message: '',tone: 'error',hidden: true});const result = await callbacks.onContinue!(node.id);
            if (alive && dialog.isOpen() && (!result || result.ok)) close();return result;
          } : undefined,
          onError(message) {if (alive && mode === 'content' && dialog.isOpen()) actionFeedback.update({message,tone: 'error',hidden: !message});},
        });
        const heading = createCardHeadingPart({children: [role,action]}),part = createSelectableCardPart({children: [heading,text]});
        row = {part,role,text};rows.set(node.id,row);
      }
      row.part.update({selected: node.active});row.role.update({text: node.role+(node.active ? ' · current branch' : '')});row.text.update({text: node.text.slice(0,360) || '(Image or empty reply)'});children.push(row.part);
    }
    if (!nodes.length) {empty ??= createTextPart({role: 'paragraph',text: 'No history yet.'});children.push(empty);} else empty = undefined;
    list.replace(children);
  }
  update(initial);
  return {part: dialog,update,fail,close,isOpen: () => alive && dialog.isOpen(),destroy() {dialog.destroy();},open() {if (alive) {dialog.open();opened = dialog.isOpen();}}};
}

/** Standalone example adapter. Integrated callers compose beneath one frame. */
export function mountBranchHistory(mount: HTMLElement,initial: Readonly<HistoryState>,callbacks: HistoryCallbacks = {},appearance: MountPartsOptions = {}): HistoryAssembly {
  const history = composeBranchHistory(initial,callbacks);
  try {mountParts(mount,history.part,appearance);history.open();return history;}
  catch (error) {history.destroy();throw error;}
}
