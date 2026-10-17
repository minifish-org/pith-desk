/** Internal consumer assembly. Desk owns completion history and dismissal. */
import {createButtonPart,createEmblemPart,createTextPart,createToastBodyPart,createToastPart,createToastStackPart,type LayoutPart,type TextPart} from 'pith-ui';

export interface CompletionNoticeDisplay {id: string;runID: string;title: string;workspace: string}
export interface CompletionNoticesComposition {readonly part: LayoutPart;update(notices: readonly CompletionNoticeDisplay[]): void;destroy(): void}
interface Entry {part: LayoutPart;text: TextPart;notice: CompletionNoticeDisplay;alive: boolean}
export function composeCompletionNotices(initial: readonly CompletionNoticeDisplay[] = [],callbacks: {onOpen?(id: string): void;onDismiss?(runID: string): void} = {}): CompletionNoticesComposition {
  let alive = true;const entries = new Map<string,Entry>(),part = createToastStackPart({label: 'Completed tasks',children: [],onDispose() {alive = false;for (const entry of entries.values()) entry.alive = false;entries.clear();}});
  const create = (notice: CompletionNoticeDisplay): Entry => {
    const text = createTextPart({role: 'paragraph',text: ''});let entry: Entry;
    const open = createButtonPart({variant: 'text-action',label: 'Open conversation',onAction() {if (alive && entry.alive && entry.notice.id) callbacks.onOpen?.(entry.notice.id);}}),dismiss = createButtonPart({variant: 'dismiss-icon',icon: 'close',label: 'Dismiss completion notification',onAction() {if (alive && entry.alive && entry.notice.runID) callbacks.onDismiss?.(entry.notice.runID);}});
    entry = {part: createToastPart({children: [createEmblemPart({tone: 'success'}),createToastBodyPart({children: [createTextPart({role: 'strong',text: 'Task completed'}),text,open]}),dismiss]}),text,notice,alive: true};return entry;
  };
  const update = (notices: readonly CompletionNoticeDisplay[]) => {
    if (!alive) return;const current = new Set(notices.map(notice => notice.runID)),ordered: LayoutPart[] = [];
    for (const notice of notices) {let entry = entries.get(notice.runID);if (!entry) {entry = create(notice);entries.set(notice.runID,entry);}entry.notice = notice;entry.text.update({text: `${notice.workspace} · ${notice.title}`});ordered.push(entry.part);}
    for (const [key,entry] of entries) if (!current.has(key)) {entry.alive = false;entries.delete(key);}part.replace(ordered);
  };
  update(initial);return {part,update,destroy() {alive = false;for (const entry of entries.values()) entry.alive = false;entries.clear();part.destroy();}};
}
