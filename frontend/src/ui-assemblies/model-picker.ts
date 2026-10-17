/**
 * Internal, compiled assembly recipe. This file is never a package entry or a
 * public model-picker factory: consumers can copy its small-part composition
 * and keep their own controller state, submit protocol and persistence.
 */
import {
  createButtonPart, createChoiceListPart, createDialogPart, createFeedbackPart,
  createFieldLabelPart, createFooterPart, createFormPart, createInputPart,
  createSelectPart, createTextPart, mountParts,
  type ChoicePart, type FormPart, type DialogPart, type MountPartsOptions,
} from 'pith-ui';

export interface ModelSelection {provider: string; model: string; thinkingLevel: string}
export interface ModelProvider {id: string; name: string; model?: string; thinkingLevel?: string}
export interface ModelEntry {
  id: string; name: string; provider: string; thinkingLevels?: readonly string[] | null;
  supportsImages: boolean; contextWindow: number; maxTokens: number;
}
export interface ModelCatalog {
  providers: readonly ModelProvider[] | null;
  models: readonly ModelEntry[] | null;
  selection: ModelSelection;
  disabled?: boolean;
}
export interface ModelPickerState {editor?: ModelCatalog; loading?: boolean; error?: string; disabled?: boolean}
type SubmitResult = {ok: true} | {ok: false; error: string};
export interface ModelPickerCallbacks {
  onSubmit?(selection: ModelSelection): SubmitResult | Promise<SubmitResult>;
  onClose?(): void;
}
export interface ModelPickerAssembly {
  read(): ModelSelection;
  update(state: Readonly<ModelPickerState>): void;
  reset(selection: Readonly<ModelSelection>): void;
  focus(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export interface ModelPickerComposition extends ModelPickerAssembly {readonly part: DialogPart;open(): void}
const effortLabel = (value: string) => value === 'off' ? 'Thinking off' : `Thinking: ${value === 'xhigh' ? 'extra high' : value}`;
/** Desk's display formatter stays with its local composition. */
export const thinkingLabel = effortLabel;

/**
 * Part tree: Dialog -> Form -> label/provider, label/search, label/native list,
 * capabilities hint, label/effort, catalog hint, inline error, Footer buttons.
 * All field values remain owned drafts; update projects catalog and feedback,
 * while reset deliberately chooses a new target and invalidates old results.
 *
 * The host supplies one checked mount, a full state snapshot, existing submit
 * callback and optional formal appearance. Read returns a fresh value object.
 * Ordinary updates preserve search/model/effort; only reset replaces that
 * selection. Local submit pending merges host availability, and a reset/close
 * revision prevents an earlier success from closing a newer selection. The
 * host still owns writes, persistence, refresh failures and business identity.
 * Close/destroy release the entire owned part tree once, keep a readable last
 * selection and notify onClose once. Retired callbacks cannot mutate new UI.
 */
export function mountModelPicker(mount: HTMLElement, initial: Readonly<ModelPickerState>, callbacks: ModelPickerCallbacks = {}, appearance: MountPartsOptions = {}): ModelPickerAssembly {
  const picker = composeModelPicker(initial,callbacks);
  try {mountParts(mount,picker.part,appearance);picker.open();return picker;}
  catch (error) {picker.destroy();throw error;}
}

/** Build only. The application attaches part to its shared frame before open. */
export function composeModelPicker(initial: Readonly<ModelPickerState>, callbacks: ModelPickerCallbacks = {}): ModelPickerComposition {
  let alive = true, initialized = false, signature = '', selected = '', revision = 0;
  let state = initial;
  let catalog: Readonly<ModelCatalog> = initial.editor ?? {providers: null, models: null, selection: {provider: '', model: '', thinkingLevel: ''}};
  let saved = {...catalog.selection};
  let provider: ChoicePart, model: ChoicePart, effort: ChoicePart, form: FormPart, dialog: DialogPart;
  const capabilities = createTextPart({text: '', role: 'hint', announce: 'polite'});
  const feedback = createFeedbackPart({message: initial.error ?? '', tone: 'error'});
  const search = createInputPart({kind: 'search', label: 'Model', placeholder: 'Search by model name or ID', autocomplete: 'off', onInput() {if (initialized) renderModels();}});
  provider = createSelectPart({label: 'Provider', required: true, disabled: true, catalog: initial.editor ? 'ready' : 'loading', options: initial.editor ? [] : [{value: '', label: 'Loading providers…'}], onChange() {chooseProvider();}});
  model = createChoiceListPart({label: 'Choose model', required: true, disabled: true, options: [], onChange() {renderCapabilities();}});
  effort = createSelectPart({label: 'Thinking effort', required: true, catalog: initial.editor ? 'ready' : 'loading', options: [], describedBy: [capabilities]});
  const providerLabel = createFieldLabelPart({label: 'Provider', control: provider});
  const searchLabel = createFieldLabelPart({label: 'Model', control: search});
  const modelLabel = createFieldLabelPart({label: 'Choose model', control: model, screenReaderOnly: true});
  const effortLabelPart = createFieldLabelPart({label: 'Thinking effort', control: effort});
  const catalogHint = createTextPart({role: 'hint', text: 'Built-in models come from the Pith SDK catalog. Custom models use your saved definitions. Availability depends on your endpoint and account.'});
  const read = (): ModelSelection => alive ? {provider: provider.read(), model: model.read(), thinkingLevel: effort.read()} : {...saved};
  const release = () => {
    if (!alive) return;
    saved = read(); alive = false; revision++;
    form.invalidate();dialog.destroy();
    // The tree is already fully released even if host cleanup throws.
    try {callbacks.onClose?.();} catch {}
  };
  const close = () => {if (alive) {dialog.close(); release();}};
  const submit = createButtonPart({label: 'Use model', type: 'submit', variant: 'primary', pending: true});
  const cancel = createButtonPart({label: 'Cancel', variant: 'secondary', onAction: close});
  const footer = createFooterPart({children: [cancel, submit]});
  const syncSubmit = () => {if (alive) submit.update({label: 'Use model', variant: 'primary', disabled: !!state.disabled, pending: form.isPending() || (state.loading ?? !state.editor)});};
  form = createFormPart({children: [providerLabel, provider, searchLabel, search, modelLabel, model, capabilities, effortLabelPart, effort, catalogHint, feedback, footer], disabled: initial.disabled,
    onPending: syncSubmit,
    onError(message) {if (alive) feedback.update({message, tone: 'error'});},
    async onSubmit() {
      const submittedRevision = revision;
      feedback.update({message: '', tone: 'error'});
      const result = callbacks.onSubmit ? await callbacks.onSubmit(read()) : {ok: false as const, error: 'This action is unavailable.'};
      if (alive && revision === submittedRevision && result.ok && dialog.isOpen()) close();
      return result;
    },
  });
  dialog = createDialogPart({title: 'Choose a model', eyebrow: 'PITH MODEL CATALOG', children: [form], onClose: release, onDispose: release});

  function syncFields(): void {
    const disabled = !!catalog.disabled;
    provider.update({disabled: disabled || !catalog.providers?.length});
    model.update({disabled: disabled || !model.read()});
    const entry = catalog.models?.find(entry => entry.provider === provider.read() && entry.id === model.read());
    const levels = entry?.thinkingLevels?.length ? entry.thinkingLevels : ['off'];
    effort.update({disabled: disabled || levels.length < 2, hidden: levels.length < 2});
    search.update({disabled});
  }
  function renderCapabilities(preferred = effort.read()): void {
    selected = model.read();
    const entry = catalog.models?.find(entry => entry.provider === provider.read() && entry.id === selected);
    const levels = entry?.thinkingLevels?.length ? entry.thinkingLevels : ['off'];
    effort.update({options: levels.map(value => ({value, label: effortLabel(value)})), hidden: levels.length < 2});
    effort.reset(levels.includes(preferred) ? preferred : levels.includes('high') ? 'high' : levels.includes('medium') ? 'medium' : levels[0]);
    effortLabelPart.update({label: 'Thinking effort', hidden: levels.length < 2});
    capabilities.update({text: entry ? `${entry.supportsImages ? 'Text + images' : 'Text only'} · ${new Intl.NumberFormat('en').format(entry.contextWindow)} context tokens · ${new Intl.NumberFormat('en').format(entry.maxTokens)} max output tokens` : 'No matching models.', announce: 'polite'});
    syncFields();
  }
  function renderModels(preferred = effort.read()): void {
    if (!alive) return;
    const query = search.read().trim().toLowerCase();
    const entries = (catalog.models ?? []).filter(entry => entry.provider === provider.read() && (entry.id === selected || `${entry.name} ${entry.id}`.toLowerCase().includes(query)));
    model.update({options: entries.map(entry => ({value: entry.id, label: `${entry.name} — ${entry.id}`}))});
    model.reset(entries.some(entry => entry.id === selected) ? selected : entries[0]?.id ?? '');
    renderCapabilities(preferred);
  }
  function chooseProvider(selection?: Readonly<ModelSelection>): void {
    const entry = catalog.providers?.find(entry => entry.id === provider.read());
    search.reset('');
    selected = selection && selection.provider === provider.read() ? selection.model : entry?.model ?? '';
    renderModels(selection && selection.provider === provider.read() ? selection.thinkingLevel : entry?.thinkingLevel ?? 'high');
  }
  function resetSelection(selection: Readonly<ModelSelection>): void {
    provider.reset(catalog.providers?.some(entry => entry.id === selection.provider) ? selection.provider : catalog.providers?.[0]?.id ?? '');
    chooseProvider(selection);
  }
  function update(next: Readonly<ModelPickerState>): void {
    if (!alive) return;
    const draft = read(); state = next;
    if (next.error !== undefined) feedback.update({message: next.error, tone: 'error'});
    if (next.editor) {
      catalog = next.editor;
      provider.update({catalog: 'ready'}); effort.update({catalog: 'ready'});
      const nextSignature = JSON.stringify([catalog.providers, catalog.models]);
      if (nextSignature !== signature) {
        signature = nextSignature;
        provider.update({options: (catalog.providers ?? []).map(entry => ({value: entry.id, label: entry.name}))});
        if (!initialized || !draft.provider) resetSelection(catalog.selection);
        else {
          provider.reset(catalog.providers?.some(entry => entry.id === draft.provider) ? draft.provider : catalog.providers?.[0]?.id ?? '');
          selected = draft.model; renderModels(draft.thinkingLevel);
        }
        initialized = true;
      }
      syncFields();
    }
    form.update({disabled: !!next.disabled}); syncSubmit();
  }
  update(initial);
  return {
    part: dialog, read, update,
    open() {if (alive) {dialog.open();if (dialog.isOpen()) search.focus();}},
    reset(selection) {if (alive) {revision++; form.reset(); resetSelection(selection);}},
    focus() {if (alive) search.focus();},
    close, isOpen: () => alive && dialog.isOpen(), destroy: close,
  };
}
