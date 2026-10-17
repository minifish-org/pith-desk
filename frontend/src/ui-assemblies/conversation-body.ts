/** Internal conversation composition. Image loading and reader coordination
 * have separate acceptance tranches. */
import {
  createReadingColumnPart,createBubblePart,createTextPart,createReadingNotePart,createMarkdownPart,
  createTimestampPart,createMessageFooterPart,createMessageActionsPart,createButtonPart,createCopyButtonPart,createAnnouncementPart,createWorkingIndicatorPart,
  type MarkdownPart,type Part,type ButtonPart,type LayoutPart,type TimestampPart,type WorkingIndicatorPart,type AnnouncementPart,type ReadingColumnPart,type LocalContentLink,
} from 'pith-ui';
import {composeToolGroup,type ToolGroupComposition} from './tool-disclosures.js';
import {createConversationImageScope,type ImageReference,type GalleryCallbacks,type ImageGalleryComposition} from './conversation-images.js';

export interface BodyMessage {id: string;role: string;text: string;timestamp?: number;status?: string;toolName?: string;toolCallId?: string;command?: {text: string;cwd: string;exitCode?: number};images?: readonly ImageReference[];actions?: {copy?: boolean|string;edit?: boolean;branch?: {key: string;label?: string}}}
export interface ConversationBodyState {id: string;messages: readonly BodyMessage[];working: boolean;folds?: ReadonlyMap<string,boolean>}
export interface MessageAction {action: 'copy'|'edit'|'branch';messageId: string;branchKey?: string}
export type BodyResult = void|{ok: true}|{ok: false;error: string};
export interface ConversationBodyCallbacks extends GalleryCallbacks {onMessageAction?(target: Readonly<MessageAction>): BodyResult|Promise<BodyResult>;onCopyCode?(text: string): BodyResult|Promise<BodyResult>;resolveLocalLink?(href: string,conversationId: string): LocalContentLink|null;onLocalFile?(target: Readonly<LocalContentLink>): BodyResult|Promise<BodyResult>;onError?(message: string): void}
export interface ConversationHostAvailability {busy?: boolean;conversations?: readonly string[]}
export interface ConversationBodyComposition {readonly part: ReadingColumnPart;readonly announcement: AnnouncementPart;update(state: Readonly<ConversationBodyState>): void;updateAvailability(state: Readonly<Partial<Record<MessageAction['action'],boolean>>>): void;updateHostAvailability(state: Readonly<ConversationHostAvailability>): void;prune(ids: readonly string[]): void;destroy(): void}
interface Entry {part: Part;kind: string;update(message: BodyMessage): void;availability(): void}

/** Reading column -> caller-keyed bubbles/notes and optional working indicator.
 * Each bubble explicitly composes its text, timestamp, footer and actions. */
export function composeConversationBody(initial: Readonly<ConversationBodyState>,callbacks: ConversationBodyCallbacks = {},sharedAnnouncement?: AnnouncementPart): ConversationBodyComposition {
  let alive = true,id = initial.id,disabled: Readonly<Partial<Record<MessageAction['action'],boolean>>> = {},working: WorkingIndicatorPart|undefined;
  let hostAvailability: Readonly<ConversationHostAvailability> = {};
  const entries = new Map<string,Entry>();
  let groups = new Map<string,Set<string>>();
  const toolGroups = new Map<string,ToolGroupComposition>(),savedFolds = new Map<string,Map<string,boolean>>();
  const announcement = sharedAnnouncement ?? createAnnouncementPart({message: ''});
  const images = createConversationImageScope(() => id,callbacks);
  const fail = (message: string) => {if (alive) callbacks.onError?.(message);};
  const root = createReadingColumnPart({children: [],onDispose() {alive = false;images.destroy();entries.clear();toolGroups.clear();groups.clear();savedFolds.clear();working = undefined;if (!sharedAnnouncement) announcement.destroy();}});
  const kindOf = (message: BodyMessage) => message.role === 'system' ? 'system' : message.role === 'user' ? 'user' : message.role === 'tool' ? 'tool' : 'assistant';
  function make(message: BodyMessage): Entry {
    const kind = kindOf(message);
    if (kind === 'system') {const part = createReadingNotePart({key: message.id,text: message.text});return {part,kind,update(next) {part.update({text: next.text});},availability() {}};}
    let current = message,footer: LayoutPart|undefined,actions: LayoutPart|undefined,time: TimestampPart|undefined,gallery: ImageGalleryComposition|undefined;
    const buttons = new Map<MessageAction['action'],ButtonPart>();
    const invoke = (action: MessageAction['action']) => {
      if (!alive || disabled[action]) return;
      const target = Object.freeze({action,messageId: current.id,...(action === 'branch' ? {branchKey: current.actions!.branch!.key} : {})});
      return callbacks.onMessageAction?.(target);
    };
    const dispatch = (action: MessageAction['action']) => {
      try {void Promise.resolve(invoke(action)).then(result => {if (result && !result.ok) fail(result.error);},error => fail(error instanceof Error ? error.message : String(error)));}
      catch (error) {fail(error instanceof Error ? error.message : String(error));}
    };
    const text = kind === 'user' ? createTextPart({role: 'bubble',text: message.text,hidden: !message.text}) : createMarkdownPart({text: message.text,onCopyCode: callbacks.onCopyCode,resolveLocalLink: href => callbacks.resolveLocalLink?.(href,id) ?? null,onLocalFile: callbacks.onLocalFile,onError: fail});
    let interrupted: ReturnType<typeof createTextPart>|undefined;
    const bubble = createBubblePart({key: message.id,speaker: kind === 'user' ? 'self' : 'agent',children: []});
    const availability = () => {for (const [action,button] of buttons) {
      const label = action === 'copy' ? typeof current.actions?.copy === 'string' ? current.actions.copy : 'Copy message' : action === 'edit' ? 'Edit message' : current.actions?.branch?.label || 'Branch from this message';
      button.update({variant: 'quiet-icon',icon: action === 'copy' ? 'copy' : action === 'edit' ? 'edit' : 'branch',label,title: label,disabled: !!disabled[action]});
    }
      if (kind !== 'user') (text as MarkdownPart).update({text: current.text,localFileDisabled: !!hostAvailability.busy || !!hostAvailability.conversations?.includes(id),copyBusy: !!hostAvailability.busy});
    };
    const update = (next: BodyMessage) => {
      current = next;
      text.update({text: next.text,...(kind === 'user' ? {hidden: !next.text} : {})});
      if (kind === 'assistant' && next.status === 'error') interrupted ??= createTextPart({role: 'interrupted',text: 'Response interrupted'});
      else {interrupted?.destroy();interrupted = undefined;}
      if (kind === 'user' && next.images?.length) {if (!gallery) gallery = images.gallery(next.id,next.images);else gallery.update(next.images);}else {gallery?.part.destroy();gallery = undefined;}
      const desired: MessageAction['action'][] = [ ...(next.actions?.copy ? ['copy' as const] : []),...(next.actions?.edit ? ['edit' as const] : []),...(next.actions?.branch ? ['branch' as const] : []) ];
      for (const [action,button] of buttons) if (!desired.includes(action)) {button.destroy();buttons.delete(action);}
      for (const action of desired) if (!buttons.has(action)) buttons.set(action,action === 'copy'
        ? createCopyButtonPart({variant: 'quiet-icon',icon: 'copy',label: 'Copy message',announcement,successMessage: 'Message copied',onCopy() {return invoke('copy');},onError: fail})
        : createButtonPart({variant: 'quiet-icon',icon: action === 'edit' ? 'edit' : 'branch',label: action,onAction() {dispatch(action);}}));
      if (desired.length) {if (!actions) actions = createMessageActionsPart({children: []});actions.replace(desired.map(action => buttons.get(action)!));}
      else {actions?.destroy();actions = undefined;}
      if (next.timestamp && Number.isFinite(new Date(next.timestamp).getTime())) {if (!time) time = createTimestampPart({value: next.timestamp});else time.update({value: next.timestamp});}
      else {time?.destroy();time = undefined;}
      if (time || actions) {if (!footer) footer = createMessageFooterPart({children: []});footer.replace([...(time ? [time] : []),...(actions ? [actions] : [])]);}
      else {footer?.destroy();footer = undefined;}
      bubble.replace([...(gallery ? [gallery.part] : []),text,...(interrupted ? [interrupted] : []),...(footer ? [footer] : [])]);availability();
    };
    update(message);return {part: bubble,kind,update,availability};
  }
  const update = (state: Readonly<ConversationBodyState>) => {
    if (!alive) return;
    const keys = new Set(state.messages.filter(message => kindOf(message) !== 'tool').map(message => message.id));
    const allKeys = new Set<string>();for (const message of state.messages) {if (allKeys.has(message.id)) throw new TypeError('Message IDs must be unique.');allKeys.add(message.id);}
    if (id) savedFolds.set(id,new Map([...toolGroups.values()].flatMap(group => [...group.folds()])));
    if (state.id !== id) {root.replace([]);images.reset();entries.clear();toolGroups.clear();groups.clear();working = undefined;id = state.id;}
    const folds = state.folds ?? savedFolds.get(id) ?? new Map<string,boolean>();
    for (const [key,entry] of entries) if (!keys.has(key)) {entry.part.destroy();entries.delete(key);}
    const children: Part[] = [];
    const nextGroups = new Map<string,Set<string>>();let groupIndex = 0;
    for (let index = 0;index < state.messages.length;) {
      const message = state.messages[index]!;
      if (kindOf(message) === 'tool') {
        const start = index;while (index < state.messages.length && kindOf(state.messages[index]!) === 'tool') index++;
        const tools = state.messages.slice(start,index),members = new Set(tools.map(tool => tool.id));
        const retained = [...groups].find(([key,previous]) => !nextGroups.has(key) && [...members].some(member => previous.has(member)));
        const baseKey = `group-${tools[0]!.id}`;let key = retained?.[0] ?? baseKey;
        if (!retained) for (let suffix = 2;groups.has(key) || nextGroups.has(key);suffix++) key = `${baseKey}-${suffix}`;
        nextGroups.set(key,members);const legacyKey = `group-${groupIndex++}`;
        let group = toolGroups.get(key);if (!group) {group = composeToolGroup(key,legacyKey,tools,folds,images.gallery);toolGroups.set(key,group);}else group.update(tools,folds);
        children.push(group.part);continue;
      }
      index++;let entry = entries.get(message.id);if (entry && entry.kind !== kindOf(message)) {entry.part.destroy();entries.delete(message.id);entry = undefined;}
      if (!entry) {entry = make(message);entries.set(message.id,entry);}else entry.update(message);children.push(entry.part);
    }
    for (const [key,group] of toolGroups) if (!nextGroups.has(key)) {group.part.destroy();toolGroups.delete(key);}groups = nextGroups;
    if (state.working) {working ??= createWorkingIndicatorPart({label: 'Working…'});children.push(working);}else {working?.destroy();working = undefined;}
    root.replace(children);root.update({hidden: !state.messages.length});
  };
  update(initial);
  return {part: root,announcement,update,updateAvailability(state) {if (alive) {disabled = {...state};for (const entry of entries.values()) entry.availability();}},updateHostAvailability(state) {if (alive) {hostAvailability = {...state};for (const entry of entries.values()) entry.availability();}},prune(ids) {if (alive) {const keep = new Set(ids);for (const key of savedFolds.keys()) if (!keep.has(key)) savedFolds.delete(key);}},destroy() {root.destroy();}};
}
