/** Internal artifact-control assembly. File discovery and native actions stay in the host. */
import {
  createAnchoredGroupPart, createButtonPart, createCardBodyPart, createCardPart,
  createCompactActionsPart, createContentViewportPart, createCopyButtonPart,
  createFeedbackPart, createIconPart, createInspectorHeadingPart, createInspectorPart,
  createStackPart, createTextPart,
  type AnchoredGroupPart, type AnnouncementPart, type ButtonPart, type CardPart, type DialogPart,
} from 'pith-ui';

export interface ArtifactsState {
  readonly ownerId: string;readonly files: readonly {readonly name: string;readonly path: string}[];
  readonly loading: boolean;readonly error: string;readonly copyMode: 'file' | 'path';readonly disabled?: boolean;
}
export interface ArtifactTarget {readonly owner: {readonly kind: 'artifact';readonly id: string};readonly name: string;readonly path: string}
export type ArtifactActionResult = void | {ok: true} | {ok: false;error: string};
export interface ArtifactsCallbacks {
  onPreview(target: ArtifactTarget): ArtifactActionResult | Promise<ArtifactActionResult>;
  onFileAction(action: 'open' | 'reveal' | 'copy' | 'copy-path',target: ArtifactTarget): ArtifactActionResult | Promise<ArtifactActionResult>;
}
export interface ArtifactsDependencies {readonly announcement: AnnouncementPart;readonly relatedDialogs?: readonly DialogPart[]}
export interface ArtifactsComposition {
  readonly part: AnchoredGroupPart;update(state: Readonly<ArtifactsState>,callbacks?: ArtifactsCallbacks): void;
  setRelatedDialogs(dialogs: readonly DialogPart[]): void;
  close(): void;isOpen(): boolean;destroy(): void;
}

/** The counter, heading, status, viewport and keyed cards are independent parts. */
export function composeArtifacts(initial: Readonly<ArtifactsState>, callbacks: ArtifactsCallbacks, dependencies: ArtifactsDependencies): ArtifactsComposition {
  let state = initial,handlers = callbacks,alive = true;
  type Row = {part: CardPart;name: ReturnType<typeof createTextPart>;path: string;buttons: {part: ButtonPart;label: string | (() => string)}[]};
  const rows = new Map<string,Row>(),list = createStackPart({children: []});
  const fail = (message: string) => {if (alive) {state = {...state,error: message};render();}};
  const trigger = createButtonPart({variant: 'counter',icon: 'file',count: '',label: 'Conversation files',title: 'Conversation files',onAction() {if (inspector.isOpen()) inspector.close();else inspector.open(trigger);}});
  const close = createButtonPart({variant: 'quiet-icon',icon: 'close',label: 'Close files',onAction() {inspector.close(true);}});
  const heading = createInspectorHeadingPart({title: 'Files',count: '',action: close});
  const loading = createTextPart({role: 'surface-status',text: 'Looking for files…',hidden: true});
  const error = createFeedbackPart({presentation: 'paragraph',tone: 'error',message: '',hidden: true});
  const viewport = createContentViewportPart({purpose: 'inspector',content: [list,error]});
  const inspector = createInspectorPart({heading,children: [loading,viewport],relatedDialogs: dependencies.relatedDialogs});
  const part = createAnchoredGroupPart({trigger,surface: inspector,onDispose() {alive = false;rows.clear();}});
  const targetFor = (path: string): ArtifactTarget | undefined => {
    const file = state.files.find(file => file.path === path);
    return file ? Object.freeze({owner: Object.freeze({kind: 'artifact' as const,id: state.ownerId}),name: file.name,path: file.path}) : undefined;
  };
  function makeRow(file: {readonly name: string;readonly path: string}): Row {
    const owner = state.ownerId,key = JSON.stringify([owner,file.path]);let row: Row;
    const valid = () => alive && state.ownerId === owner && rows.get(key) === row;
    const onError = (message: string) => {if (valid()) fail(message);};
    const availableTarget = () => valid() && !state.disabled ? targetFor(file.path) : undefined;
    const preview = createButtonPart({label: 'Preview',variant: 'secondary',async onAction() {const target = availableTarget();if (target) return handlers.onPreview(target);},onError});
    const open = createButtonPart({label: 'Open',variant: 'secondary',async onAction() {const target = availableTarget();if (target) return handlers.onFileAction('open',target);},onError});
    const reveal = createButtonPart({label: 'Reveal',variant: 'secondary',async onAction() {const target = availableTarget();if (target) return handlers.onFileAction('reveal',target);},onError});
    const copyLabel = () => state.copyMode === 'file' ? 'Copy file' : 'Copy path';
    const copy = createCopyButtonPart({label: copyLabel(),variant: 'secondary',announcement: dependencies.announcement,
      successMessage: () => state.copyMode === 'file' ? 'File copied.' : 'Path copied.',
      async onCopy() {const target = availableTarget();if (target) return handlers.onFileAction(state.copyMode === 'file' ? 'copy' : 'copy-path',target);},onError});
    const buttons = [{part: preview,label: 'Preview'},{part: open,label: 'Open'},{part: reveal,label: 'Reveal'},{part: copy,label: copyLabel}];
    const name = createTextPart({role: 'strong',text: file.name});
    const body = createCardBodyPart({children: [name,createTextPart({role: 'path',text: file.path})]});
    row = {part: createCardPart({children: [createIconPart({name: 'file'}),body,createCompactActionsPart({children: buttons.map(button => button.part)})]}),name,path: file.path,buttons};return row;
  }
  function render(): void {
    if (!alive) return;
    const number = `${state.files.length} ${state.files.length === 1 ? 'file' : 'files'}`,label = state.error ? 'Conversation files unavailable' : `Conversation files (${number})`;
    trigger.update({variant: 'counter',icon: 'file',count: state.files.length ? String(state.files.length) : '!',label,title: label});heading.update({title: 'Files',count: number});
    loading.update({text: 'Looking for files…',hidden: !state.loading});error.update({tone: 'error',message: state.error,hidden: !state.error});
    const wanted = new Set(state.files.map(file => JSON.stringify([state.ownerId,file.path])));
    for (const [key,row] of rows) if (!wanted.has(key)) {row.part.destroy();rows.delete(key);}
    const parts: CardPart[] = [];
    for (const file of state.files) {
      const key = JSON.stringify([state.ownerId,file.path]);let row = rows.get(key);if (!row) {row = makeRow(file);rows.set(key,row);}
      row.name.update({text: file.name});for (const button of row.buttons) button.part.update({label: typeof button.label === 'function' ? button.label() : button.label,variant: 'secondary',disabled: !!state.disabled});parts.push(row.part);
    }
    list.replace(parts);part.update({hidden: !state.ownerId || (!state.files.length && !state.error)});
  }
  render();
  return {part,update(next,nextCallbacks) {if (!alive) return;if (state.ownerId !== next.ownerId) inspector.close();state = next;if (nextCallbacks) handlers = nextCallbacks;render();},
    setRelatedDialogs: inspector.setRelatedDialogs,close() {if (alive) inspector.close();},isOpen: () => alive && inspector.isOpen(),destroy() {if (alive) part.destroy();}};
}
