/** Internal compiled recipe. Provider persistence and model-definition validation stay in the app. */
import {
  createButtonPart,createCheckboxPart,createDialogPart,createDisclosurePart,createFeedbackPart,
  createFieldGridPart,createFieldsetPart,createFooterPart,createFormPart,createInputPart,
  createLabelledFieldPart,createSelectPart,createStackPart,createTextPart,mountParts,
  type ButtonPart,type DialogPart,type FormPart,type MountPartsOptions,
} from 'pith-ui';

export type Result = {ok: true} | {ok: false;error: string};
export interface CustomModel {id: string;name?: string;contextWindow?: number;maxTokens?: number;reasoning?: boolean;input?: readonly string[];cost?: {input: number;output: number;cacheRead: number;cacheWrite: number}}
/** Initial values for a new definition; existing definitions remain untouched. */
export function customModelDefaults(): CustomModel {return {id: '',contextWindow: 128000,maxTokens: 8192};}
export interface CustomConnectionState {name: string;baseUrl: string;api: string;editing: boolean;models: readonly CustomModel[];error?: string;disabled?: boolean}
export interface CustomModelDraft {sourceIndex: number;id: string;name: string;contextWindow: number;maxTokens: number;reasoning: boolean;images: boolean;prices: {input: string;output: string;cacheRead: string;cacheWrite: string}}
export interface CustomConnectionDraft {name: string;baseUrl: string;api: string;apiKey: string;models: CustomModelDraft[]}
export interface CustomConnectionCallbacks {onSubmit?(draft: CustomConnectionDraft): Result | Promise<Result>;onClose?(): void}
export interface CustomConnectionAssembly {read(): CustomConnectionDraft;update(state: Readonly<CustomConnectionState>): void;clearSecrets(): void;fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void}
export interface CustomConnectionComposition extends CustomConnectionAssembly {readonly part: DialogPart;open(): void}
const protocols = ['openai-completions','openai-responses','anthropic-messages','google-generative-ai','mistral-conversations'];
const copyDraft = (draft: CustomConnectionDraft): CustomConnectionDraft => ({...draft,models: draft.models.map(model => ({...model,prices: {...model.prices}}))});

/** Internal standalone adapter; applications compose the opaque part under their shared owner. */
export function mountCustomConnection(mount: HTMLElement,initial: Readonly<CustomConnectionState>,callbacks: CustomConnectionCallbacks = {},appearance: MountPartsOptions = {}): CustomConnectionAssembly {
  const connection = composeCustomConnection(initial,callbacks);
  try {mountParts(mount,connection.part,appearance);connection.open();return connection;}
  catch (error) {connection.destroy();throw error;}
}

export function composeCustomConnection(initial: Readonly<CustomConnectionState>,callbacks: CustomConnectionCallbacks = {}): CustomConnectionComposition {
  let alive = true,state = initial,nextIndex = 0,form: FormPart,dialog: DialogPart;
  let saved: CustomConnectionDraft = {name: initial.name,baseUrl: initial.baseUrl,api: initial.api,apiKey: '',models: []};
  const name = createInputPart({label: 'Connection name',value: initial.name,required: true});
  const url = createInputPart({label: 'API base URL',kind: 'url',value: initial.baseUrl,required: true,placeholder: 'https://example.com/v1'});
  const api = createSelectPart({label: 'API protocol',value: protocols.includes(initial.api) ? initial.api : protocols[0],options: protocols.map(value => ({value,label: value}))});
  const key = createInputPart({label: 'API key',kind: 'password',autocomplete: 'new-password',placeholder: initial.editing ? 'Leave blank to keep the key at the same endpoint' : 'API key (optional for local endpoints)'});
  const models = createStackPart({children: []}),error = createFeedbackPart({presentation: 'paragraph',message: initial.error ?? '',tone: 'error'}),frameError = createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error'});
  type Row = {part: ReturnType<typeof createStackPart>;remove: ButtonPart;read(): CustomModelDraft};
  const rows = new Map<number,Row>();
  const renderRows = () => models.replace([...rows.values()].map(row => row.part));
  function makeRow(model: Readonly<CustomModel>,index: number): Row {
    const id = createInputPart({label: 'Model ID',name: 'id',value: model.id,required: true});
    const display = createInputPart({label: 'Display name',name: 'name',value: model.name ?? ''});
    const context = createInputPart({label: 'Context tokens',name: 'contextWindow',kind: 'number',min: 1,required: true,value: model.contextWindow === undefined ? '' : String(model.contextWindow)});
    const max = createInputPart({label: 'Max output tokens',name: 'maxTokens',kind: 'number',min: 1,required: true,value: model.maxTokens === undefined ? '' : String(model.maxTokens)});
    const reasoning = createCheckboxPart({label: 'Thinking effort',name: 'reasoning',checked: !!model.reasoning}),images = createCheckboxPart({label: 'Images',name: 'images',checked: !!model.input?.includes('image')});
    const priceKeys = ['input','output','cacheRead','cacheWrite'] as const,labels = {input: 'Input',output: 'Output',cacheRead: 'Cache read',cacheWrite: 'Cache write'};
    const prices = Object.fromEntries(priceKeys.map(rate => [rate,createInputPart({label: labels[rate],name: `price-${rate}`,kind: 'number',min: 0,step: 'any',value: model.cost?.[rate] === undefined ? '' : String(model.cost[rate])})])) as Record<typeof priceKeys[number],ReturnType<typeof createInputPart>>;
    const remove = createButtonPart({label: 'Remove model',variant: 'danger',onAction() {if (alive && !state.disabled && !form.isPending()) {rows.delete(index);renderRows();}}});
    const fields = createFieldsetPart({legend: `Model ${index+1}`,children: [
      createLabelledFieldPart({label: 'Model ID',control: id}),createLabelledFieldPart({label: 'Display name',control: display}),
      createFieldGridPart({children: [createLabelledFieldPart({label: 'Context tokens',control: context}),createLabelledFieldPart({label: 'Max output tokens',control: max})]}),
      createFieldGridPart({children: [reasoning,images]}),
      createDisclosurePart({purpose: 'advanced',title: 'Price estimate (optional)',children: [createFieldGridPart({children: priceKeys.map(rate => createLabelledFieldPart({label: labels[rate],control: prices[rate]}))})]}),remove,
    ]});
    const part = createStackPart({children: [fields,createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error'})]});
    return {part,remove,read: () => ({sourceIndex: index,id: id.read().trim(),name: display.read().trim(),contextWindow: Number(context.read()),maxTokens: Number(max.read()),reasoning: reasoning.read(),images: images.read(),prices: {input: prices.input.read(),output: prices.output.read(),cacheRead: prices.cacheRead.read(),cacheWrite: prices.cacheWrite.read()}})};
  }
  const addRow = (model: Readonly<CustomModel>) => {const index = nextIndex++;rows.set(index,makeRow(model,index));renderRows();};
  initial.models.forEach(addRow);
  const read = (): CustomConnectionDraft => alive ? {name: name.read(),baseUrl: url.read(),api: api.read(),apiKey: key.read(),models: [...rows.values()].map(row => row.read())} : copyDraft(saved);
  const release = () => {
    if (!alive) return;
    saved = {...read(),apiKey: ''};alive = false;rows.clear();form.invalidate();dialog.destroy();try {callbacks.onClose?.();} catch {}
  };
  const close = () => {if (alive) {dialog.close();release();}};
  const add = createButtonPart({label: 'Add model',variant: 'secondary',onAction() {if (alive && !state.disabled && !form.isPending()) {addRow(customModelDefaults());syncButtons();}}});
  const cancel = createButtonPart({label: 'Cancel',variant: 'secondary',onAction: close}),save = createButtonPart({label: 'Save connection',variant: 'primary',type: 'submit'});
  function syncButtons(): void {
    if (!alive) return;
    const pending = form.isPending();add.update({label: 'Add model',variant: 'secondary',disabled: !!state.disabled,pending});save.update({label: 'Save connection',variant: 'primary',disabled: !!state.disabled,pending});cancel.update({label: 'Cancel',variant: 'secondary',disabled: !!state.disabled});
    for (const row of rows.values()) row.remove.update({label: 'Remove model',variant: 'danger',disabled: !!state.disabled,pending});
  }
  form = createFormPart({children: [createLabelledFieldPart({label: 'Connection name',control: name}),createLabelledFieldPart({label: 'API base URL',control: url}),
    createLabelledFieldPart({label: 'API protocol',control: api}),createLabelledFieldPart({label: 'API key',control: key}),models,add,
    createTextPart({role: 'hint',text: 'Limits and capabilities are provided by you. Prices are USD per million tokens. Fill all four rates (0 for free/unused), or leave all four blank for unknown prices.'}),error,createFooterPart({children: [cancel,save]})],disabled: !!initial.disabled,
    onPending: syncButtons,onError(message) {if (alive) error.update({message,tone: 'error'});},async onSubmit() {
      error.update({message: '',tone: 'error'});const result = callbacks.onSubmit ? await callbacks.onSubmit(read()) : {ok: false as const,error: 'This action is unavailable.'};if (alive && result.ok) close();return result;
    },
  });
  const body = createStackPart({children: [createTextPart({role: 'description',text: 'Give this endpoint its own name. It can coexist with official providers and other compatible endpoints.'}),form]});
  dialog = createDialogPart({purpose: 'feature',title: initial.editing ? 'Edit model connection' : 'Add model connection',children: [body,frameError],onClose: release,onDispose: release});
  const update = (next: Readonly<CustomConnectionState>) => {if (alive) {state = next;if (next.error !== undefined) error.update({message: next.error,tone: 'error'});form.update({disabled: !!next.disabled});syncButtons();}};
  update(initial);
  return {part: dialog,open() {if (alive) dialog.open();},read,update,clearSecrets() {if (alive) key.reset('');saved.apiKey = '';},fail(message) {if (alive) frameError.update({message,tone: 'error'});},close,isOpen: () => alive && dialog.isOpen(),destroy: close};
}

export interface CustomLoadingState {editing: boolean;error?: string}
export interface CustomLoadingAssembly {update(state: Readonly<{error?: string}>): void;fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void}
export interface CustomLoadingComposition extends CustomLoadingAssembly {readonly part: DialogPart;open(): void}
export function composeCustomConnectionLoading(initial: Readonly<CustomLoadingState>,callbacks: {onClose?(): void} = {}): CustomLoadingComposition {
  let alive = true,dialog: DialogPart;
  const message = createFeedbackPart({presentation: 'paragraph',message: initial.error || 'Loading…',tone: initial.error ? 'error' : 'info'}),error = createFeedbackPart({presentation: 'paragraph',message: '',tone: 'error'});
  const release = () => {if (alive) {alive = false;dialog.destroy();try {callbacks.onClose?.();} catch {}}};
  const close = () => {if (alive) {dialog.close();release();}};
  dialog = createDialogPart({purpose: 'feature',title: initial.editing ? 'Edit model connection' : 'Add model connection',children: [message,error],onClose: release,onDispose: release});
  return {part: dialog,open() {if (alive) dialog.open();},update(state) {if (alive) message.update({message: state.error || 'Loading…',tone: state.error ? 'error' : 'info'});},fail(text) {if (alive) error.update({message: text,tone: 'error'});},close,isOpen: () => alive && dialog.isOpen(),destroy: close};
}
export function mountCustomConnectionLoading(mount: HTMLElement,initial: Readonly<CustomLoadingState>,callbacks: {onClose?(): void} = {},appearance: MountPartsOptions = {}): CustomLoadingAssembly {
  const loading = composeCustomConnectionLoading(initial,callbacks);
  try {mountParts(mount,loading.part,appearance);loading.open();return loading;}
  catch (error) {loading.destroy();throw error;}
}
