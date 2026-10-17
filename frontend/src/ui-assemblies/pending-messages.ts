import {
  createScrollListPart,createCompactRowPart,createCompactRowBodyPart,createCompactRowActionsPart,createRowTextPart,createBadgePart,createTextPart,createButtonPart,
  type ScrollListPart,type LayoutPart,type ButtonPart,type BadgePart,type RowTextPart,
} from 'pith-ui';

export interface PendingItem {id: string;text: string;mode: string;imageCount?: number}
export interface PendingState {items: readonly PendingItem[];running: boolean;busy: boolean}
export interface PendingCallbacks {onQueueAction?(action: 'steer'|'edit'|'delete',id: string): void}
export interface PendingComposition {readonly part: ScrollListPart;update(state: Readonly<PendingState>): void;destroy(): void}
interface Entry {part: LayoutPart;badge: BadgePart;text: RowTextPart;count: RowTextPart;steer: ButtonPart;edit: ButtonPart;remove: ButtonPart}

/** All pending-message policy and prose is local caller code. The library
 * supplies only the bounded list, native row, text, badge and button parts. */
export function composePendingMessages(initial: Readonly<PendingState>,callbacks: PendingCallbacks = {}): PendingComposition {
  let alive = true;const entries = new Map<string,Entry>(),heading = createTextPart({role: 'section-title',text: 'Pending messages'});
  const root = createScrollListPart({label: 'Pending messages',children: [heading],onDispose() {alive = false;entries.clear();}});
  const make = (id: string): Entry => {
    const badge = createBadgePart({purpose: 'filled',text: 'Instruction'}),text = createRowTextPart({purpose: 'preview',text: ''}),count = createRowTextPart({purpose: 'count',text: ''});
    const steer = createButtonPart({variant: 'quiet-action',icon: 'steer',label: 'Steer',title: 'Steer the current task at its next turn',onAction() {if (alive) callbacks.onQueueAction?.('steer',id);}});
    const edit = createButtonPart({variant: 'quiet-icon',icon: 'edit',label: 'Edit pending message',title: 'Edit message',onAction() {if (alive) callbacks.onQueueAction?.('edit',id);}});
    const remove = createButtonPart({variant: 'quiet-icon',icon: 'trash',label: 'Delete pending message',title: 'Delete message',onAction() {if (alive) callbacks.onQueueAction?.('delete',id);}});
    const body = createCompactRowBodyPart({children: [text,count]}),actions = createCompactRowActionsPart({children: [steer,edit,remove]}),part = createCompactRowPart({children: [badge,body,actions]});return {part,badge,text,count,steer,edit,remove};
  };
  const update = (state: Readonly<PendingState>) => {
    if (!alive) return;
    const keys = new Set(state.items.map(item => item.id));if (keys.size !== state.items.length) throw new TypeError('Pending IDs must be unique.');
    for (const [key,entry] of entries) if (!keys.has(key)) {entry.part.destroy();entries.delete(key);}
    for (const item of state.items) {
      let entry = entries.get(item.id);if (!entry) {entry = make(item.id);entries.set(item.id,entry);}
      entry.badge.update({text: 'Instruction',hidden: item.mode !== 'steer'});entry.text.update({text: item.text || 'Image attachment',title: item.text});
      entry.count.update({text: item.imageCount ? `${item.imageCount} image${item.imageCount === 1 ? '' : 's'}` : '',hidden: !item.imageCount});
      entry.steer.update({variant: 'quiet-action',icon: 'steer',label: 'Steer',title: 'Steer the current task at its next turn',disabled: state.busy,hidden: item.mode !== 'follow-up' || !state.running});
      entry.edit.update({variant: 'quiet-icon',icon: 'edit',label: 'Edit pending message',title: 'Edit message',disabled: state.busy});entry.remove.update({variant: 'quiet-icon',icon: 'trash',label: 'Delete pending message',title: 'Delete message',disabled: state.busy});
    }
    root.replace([heading,...state.items.map(item => entries.get(item.id)!.part)]);root.update({hidden: !state.items.length});
  };
  update(initial);return {part: root,update,destroy() {root.destroy();}};
}
