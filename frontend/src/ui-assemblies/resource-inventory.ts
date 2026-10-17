/** Internal compiled recipe; resource loading, commands and writes stay in the app. */
import {
  createButtonPart, createCardBodyPart, createCardPart, createCompactActionsPart,
  createContentSectionPart, createDialogPart, createDisclosurePart, createFeedbackPart,
  createGroupedCardPart, createIconPart, createPreformattedPart, createStackPart,
  createTextPart, createToolbarPart, mountParts,
  type ButtonPart, type DialogPart, type LayoutPart, type MountPartsOptions, type Part,
} from 'pith-ui';

export type ResourceKind = 'instructions' | 'skill' | 'template';
export interface ResourceEntry {readonly name: string; readonly path: string; readonly description?: string; readonly content?: string}
export interface InventoryState {
  readonly workspace: {readonly id: string; readonly name: string; readonly path: string};
  readonly instructions: readonly ResourceEntry[];
  readonly skills: readonly ResourceEntry[];
  readonly templates: readonly ResourceEntry[];
  readonly diagnostics: readonly string[];
  readonly canCreateInstructions?: boolean;
  readonly loading?: boolean;
  readonly error?: string;
  readonly busy?: boolean;
}
export interface ResourceTarget {readonly workspaceId: string; readonly kind: ResourceKind; readonly name: string; readonly path: string}
export type ResourceActionResult = void | {ok: true} | {ok: false; error: string};
export interface InventoryCallbacks {
  onRefresh?(): ResourceActionResult | Promise<ResourceActionResult>;
  onCreate?(kind: ResourceKind): ResourceActionResult | Promise<ResourceActionResult>;
  onUse?(target: ResourceTarget): ResourceActionResult | Promise<ResourceActionResult>;
  onEdit?(target: ResourceTarget): ResourceActionResult | Promise<ResourceActionResult>;
  onFileAction?(action: 'open' | 'reveal', target: ResourceTarget): ResourceActionResult | Promise<ResourceActionResult>;
  onClose?(): void;
}
export interface ResourceInventoryAssembly {
  read(): Readonly<InventoryState>;
  update(state: Readonly<InventoryState>): void;
  fail(message: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface ResourceInventoryComposition extends ResourceInventoryAssembly {readonly part: DialogPart; open(): void}

/** Application operation ownership, independent from a button's presentation. */
function task(available: () => boolean, onError: (message: string) => void, onPending: () => void = () => {}) {
  let alive = true, pending = false, sequence = 0;
  return {
    get pending() {return pending;},
    run(callback: () => ResourceActionResult | Promise<ResourceActionResult>): void {
      if (!alive || pending || !available()) return;
      const operation = ++sequence; pending = true; onPending();
      const current = () => alive && operation === sequence;
      const accept = (result: ResourceActionResult) => {if (current() && result && !result.ok) onError(result.error);};
      const reject = (error: unknown) => {if (current()) onError(error instanceof Error ? error.message : String(error));};
      const finish = () => {if (current()) {pending = false; onPending();}};
      try {
        const result = callback();
        if (result != null && typeof result === 'object' && 'then' in result) void Promise.resolve(result).then(accept).catch(reject).finally(finish);
        else {accept(result); finish();}
      } catch (error) {try {reject(error);} finally {finish();}}
    },
    destroy() {alive = false; sequence++; pending = false;},
  };
}

/** Feature dialog -> description, feature toolbar, keyed sections/cards, feedback. */
export function composeResourcesInventory(initial: Readonly<InventoryState>, callbacks: InventoryCallbacks = {}): ResourceInventoryComposition {
  let state = initial, alive = true, opened = false, rendered = false;
  const owner = initial.workspace.id;
  const description = createTextPart({role: 'description',text: 'Instructions, skills and prompt templates are loaded by Pith for each task. Edit them here or open their Markdown files.'});
  const feedback = createFeedbackPart({message: initial.error ?? '',tone: 'error'});
  const loading = createFeedbackPart({presentation: 'paragraph',message: 'Loading workspace resources…',tone: 'info'});
  const list = createStackPart({children: [loading]});
  const current = () => alive && dialog.isOpen();
  const fail = (message: string) => {if (current()) feedback.update({message,tone: 'error'});};
  const refresh = task(current,fail);
  const creation = task(() => current() && !state.busy,fail,() => updateCreateAvailability());
  const refreshButton = createButtonPart({purpose: 'prompt',variant: 'secondary',label: 'Refresh',onAction() {if (callbacks.onRefresh) refresh.run(callbacks.onRefresh);}});
  const skillButton = createButtonPart({purpose: 'prompt',variant: 'secondary',label: 'Add skill',onAction() {if (callbacks.onCreate) creation.run(() => callbacks.onCreate!('skill'));}});
  const templateButton = createButtonPart({purpose: 'prompt',variant: 'secondary',label: 'Add prompt template',onAction() {if (callbacks.onCreate) creation.run(() => callbacks.onCreate!('template'));}});
  const toolbar = createToolbarPart({purpose: 'feature',label: 'Resource actions',children: [refreshButton,skillButton,templateButton]});
  let instructionButton: ButtonPart | undefined;
  function updateCreateAvailability(): void {
    if (!alive) return;
    const disabled = !!state.busy || creation.pending;
    skillButton.update({variant: 'secondary',label: 'Add skill',disabled});
    templateButton.update({variant: 'secondary',label: 'Add prompt template',disabled});
    instructionButton?.update({variant: 'secondary',label: 'Create AGENTS.md in this workspace',disabled});
  }
  type Row = {
    part: Part; target: ResourceTarget; name: ReturnType<typeof createTextPart>; path: ReturnType<typeof createTextPart>;
    description?: ReturnType<typeof createTextPart>; content?: ReturnType<typeof createPreformattedPart>;
    actions: LayoutPart; signature: string; fileButtons: ButtonPart[]; fileTask: ReturnType<typeof task>;
  };
  type Section = {part: ReturnType<typeof createContentSectionPart>; rows: Map<string,Row>; empty?: Part};
  const sections = new Map<ResourceKind,Section>();
  let notes: ReturnType<typeof createContentSectionPart> | undefined;
  let noteParts: ReturnType<typeof createTextPart>[] = [];
  const target = (kind: ResourceKind,entry: ResourceEntry): ResourceTarget => Object.freeze({workspaceId: owner,kind,name: entry.name,path: entry.path});
  function updateResourceActions(row: Row): void {
    const signature = JSON.stringify(row.target);
    if (signature === row.signature) return;
    const use = row.target.kind !== 'instructions' ? createButtonPart({variant: 'secondary',label: 'Use',onAction: () => current() ? callbacks.onUse?.(row.target) : undefined,onError: fail}) : undefined;
    const edit = createButtonPart({variant: 'secondary',label: 'View / edit',onAction: () => current() ? callbacks.onEdit?.(row.target) : undefined,onError: fail});
    row.actions.replace(use ? [use,edit] : [edit]); row.signature = signature;
  }
  function createRow(kind: ResourceKind,entry: ResourceEntry): Row {
    const name = createTextPart({role: 'strong',text: entry.name}),path = createTextPart({role: 'path',text: entry.path});
    const detail = kind !== 'instructions' ? createTextPart({role: 'paragraph',text: entry.description ?? ''}) : undefined;
    const info = createCardBodyPart({children: detail ? [name,detail,path] : [name,path]});
    const actions = createCompactActionsPart({children: []});
    const fileButtons: ButtonPart[] = [];
    let row: Row;
    const fileTask = task(() => current() && !state.busy,fail,() => updateFileAvailability(row));
    if (kind !== 'template') for (const [action,label] of [['open','Open'],['reveal','Reveal']] as const) fileButtons.push(createButtonPart({variant: 'secondary',label,onAction() {
      if (callbacks.onFileAction) fileTask.run(() => callbacks.onFileAction!(action,row.target));
    }}));
    const files = fileButtons.length ? createCompactActionsPart({children: fileButtons}) : undefined;
    const summary = [kind !== 'template' ? createIconPart({name: 'file'}) : undefined,info,files,actions].filter((part): part is NonNullable<typeof part> => !!part);
    const content = kind === 'instructions' ? createPreformattedPart({text: entry.content ?? ''}) : undefined;
    const preview = content ? createDisclosurePart({purpose: 'preview',title: 'View instructions',children: [content]}) : undefined;
    const part = preview ? createGroupedCardPart({summary,children: [preview]}) : createCardPart({children: summary});
    row = {part,target: target(kind,entry),name,path,description: detail,content,actions,signature: '',fileButtons,fileTask};
    updateResourceActions(row); updateFileAvailability(row); return row;
  }
  function updateFileAvailability(row: Row): void {
    for (const [index,label] of ['Open','Reveal'].entries()) row.fileButtons[index]?.update({variant: 'secondary',label,disabled: !!state.busy || row.fileTask.pending});
  }
  function render(next: Readonly<InventoryState>): void {
    if (!current() || next.workspace.id !== owner) return;
    state = next; updateCreateAvailability(); feedback.update({message: next.error ?? '',tone: 'error'});
    if (!rendered && next.loading && !next.instructions.length && !next.skills.length && !next.templates.length) return;
    const parts: Part[] = [];
    for (const [kind,title,entries,emptyText] of [
      ['instructions','Instructions',next.instructions,'No workspace instructions found.'],
      ['skill','Skills',next.skills,'No skills found. Add .pi/skills/<skill-name>/SKILL.md in this workspace, then refresh.'],
      ['template','Prompt templates',next.templates,'No prompt templates yet.'],
    ] as const) {
      let section = sections.get(kind);
      if (!section) {section = {part: createContentSectionPart({title,children: []}),rows: new Map()}; sections.set(kind,section);}
      const keep = new Set(entries.map(entry => entry.path)),children: Part[] = [];
      for (const [key,row] of section.rows) if (!keep.has(key)) {row.fileTask.destroy();row.part.destroy();section.rows.delete(key);}
      for (const entry of entries) {
        let row = section.rows.get(entry.path);
        if (!row) {row = createRow(kind,entry);section.rows.set(entry.path,row);}
        row.target = target(kind,entry);row.name.update({text: entry.name});row.path.update({text: entry.path});
        row.description?.update({text: entry.description ?? ''});row.content?.update({text: entry.content ?? ''});
        updateResourceActions(row);updateFileAvailability(row);children.push(row.part);
      }
      if (!entries.length) {section.empty ??= createFeedbackPart({presentation: 'paragraph',message: emptyText,tone: 'info'});children.push(section.empty);}
      else section.empty = undefined;
      if (kind === 'instructions') {
        if (next.canCreateInstructions) {
          instructionButton ??= createButtonPart({purpose: 'prompt',variant: 'secondary',label: 'Create AGENTS.md in this workspace',onAction() {if (callbacks.onCreate) creation.run(() => callbacks.onCreate!('instructions'));}});
          children.push(instructionButton);updateCreateAvailability();
        } else instructionButton = undefined;
      }
      section.part.replace(children);parts.push(section.part);
    }
    if (next.diagnostics.length) {
      notes ??= createContentSectionPart({title: 'Resource notes',tone: 'warning',children: []});
      const children = next.diagnostics.map((text,index) => {const part = noteParts[index] ?? createTextPart({role: 'paragraph',text});part.update({text});return part;});
      notes.replace(children);noteParts = children;parts.push(notes);
    } else {notes = undefined;noteParts = [];}
    list.replace(parts);rendered = true;
  }
  function release(): void {
    if (!alive) return;
    const notify = opened;alive = false;opened = false;refresh.destroy();creation.destroy();for (const section of sections.values()) for (const row of section.rows.values()) row.fileTask.destroy();
    sections.clear();try {dialog.destroy();} finally {if (notify) callbacks.onClose?.();}
  }
  function close(): void {if (alive) {dialog.close();release();}}
  const dialog = createDialogPart({purpose: 'feature',title: 'Workspace resources',eyebrow: initial.workspace.name,children: [description,toolbar,list,feedback],onClose: release,onDispose: release});
  return {part: dialog,read: () => state,update: render,fail,close,isOpen: current,destroy: close,
    open() {if (alive && !dialog.isOpen()) {dialog.open();opened = dialog.isOpen();if (opened) render(state);}},
  };
}

/** Standalone validation adapter. Shared application owners mount composed parts. */
export function mountResourcesInventory(mount: HTMLElement, initial: Readonly<InventoryState>, callbacks: InventoryCallbacks = {}, appearance: MountPartsOptions = {}): ResourceInventoryAssembly {
  const inventory = composeResourcesInventory(initial,callbacks);
  mountParts(mount,inventory.part,appearance);inventory.open();return inventory;
}
