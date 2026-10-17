/** Internal executable recipe. The package exports the small parts, not this scene. */
import {
  createActionsPart,createBadgePart,createButtonPart,createCopyGroupPart,createDialogPart,createDisclosurePart,
  createFeedbackPart,createFieldLabelPart,createFieldStackPart,createFooterPart,createFormLayoutPart,
  createFormPart,createInputAdornmentPart,createInputPart,createProgressPart,createSectionPart,
  createSelectPart,createStatusPart,createTextPart,createToolbarPart,mountParts,
  type ButtonPart,type ButtonPartState,type DialogPart,type DisclosurePart,type FormPart,type MountPartsOptions,
} from 'pith-ui';

export type Appearance = 'light' | 'dark' | 'system';
export type Result = {ok: true} | {ok: false;error: string};
type HostResult = void | Result | Promise<void | Result>;
export interface SettingsState {
  baseUrl: string;hasApiKey: boolean;ready?: boolean;testing?: boolean;disabled?: boolean;error?: string;
  appearance?: {mode: Appearance;disabled?: boolean;error?: string};testResult?: {message: string;ok?: boolean};
}
export interface SettingsDraft {provider: string;baseUrl: string;apiKey: string}
export interface SettingsProvider {id: string;name: string;configured?: boolean;signedIn?: boolean}
export interface ProviderActions {id: string;oauth: boolean;signedIn: boolean;custom: boolean;disabled?: boolean}
export type ProviderAction = 'login' | 'logout' | 'custom' | 'remove-connection';
export interface SettingsCredential {status: string;hidden: boolean;required: boolean;placeholder: string;removeVisible: boolean;hint?: string;providerActions?: ProviderActions}
export interface UpdateState {version: string;enabled: boolean;phase: string;availableVersion: string;progress: number;message: string}
export interface SettingsCallbacks {
  onSubmit?(draft: SettingsDraft): Result | Promise<Result>;
  onRemoveKey?(draft: SettingsDraft): Result | Promise<Result>;
  onTest?(draft: SettingsDraft): HostResult;onCancelTest?(): HostResult;
  onAppearanceChange?(mode: Appearance): HostResult;onProviderChange?(id: string): HostResult;
  onDraftChange?(draft: SettingsDraft): void;
  onProviderAction?(action: ProviderAction,target: Readonly<{id: string}>): HostResult;
  onUpdateAction?(action: 'check' | 'install'): HostResult;
  onCreateConnection?(): HostResult;onDiagnostics?(): HostResult;onClose?(): void;
}
export interface SettingsAssembly {
  read(): SettingsDraft;update(state: Readonly<SettingsState>): void;
  setProviders(items: readonly SettingsProvider[],selected?: string): void;
  resetProvider(value: {provider: string;baseUrl: string;clearKey?: boolean;collapseAdvanced?: boolean}): void;
  setCredential(view: Readonly<SettingsCredential>): void;clearSecrets(): void;
  updateUpdates(state: Readonly<UpdateState>): void;setUpdatePending(pending: boolean): void;
  setUpdateError(message: string,options?: {allowCheckRetry?: boolean}): void;
  fail(message: string): void;close(): void;isOpen(): boolean;destroy(): void;
}
export interface SettingsComposition extends SettingsAssembly {readonly part: DialogPart;open(): void}

/** Standalone internal demo adapter. Applications can use composeSettings under
 * their existing shared part tree and keep one mount/theme owner instead. */
export function mountSettings(mount: HTMLElement,initial: Readonly<SettingsState>,callbacks: SettingsCallbacks = {},appearance: MountPartsOptions = {},productName = 'Application'): SettingsAssembly {
  const settings = composeSettings(initial,callbacks,productName);
  try {mountParts(mount,settings.part,appearance);settings.open();return settings;}
  catch (error) {settings.destroy();throw error;}
}

/**
 * The native form starts after appearance and updates. The library owns all
 * markup, styling and shared controls; this local recipe owns controller state,
 * provider targets, callback wiring and retirement of obsolete UI outcomes.
 */
export function composeSettings(initial: Readonly<SettingsState>,callbacks: SettingsCallbacks = {},productName = 'Application'): SettingsComposition {
  let alive = true,state = initial,revision = 0,removing = false;
  let saved: SettingsDraft = {provider: '',baseUrl: initial.baseUrl,apiKey: ''};
  let form: FormPart,dialog: DialogPart,advanced: DisclosurePart;
  let credential: Readonly<SettingsCredential> | undefined,updateState: Readonly<UpdateState> | undefined;
  let externalUpdatePending = false,localUpdatePending = false,updateError = '',retryCheck = false;
  const operations = new Map<string,{pending: boolean}>(),providerButtons = new Map<string,ButtonPart>();
  const feedback = createFeedbackPart({message: initial.error ?? '',tone: 'error'});
  const fail = (message: string) => {if (alive) feedback.update({message,tone: 'error'});};
  const read = (): SettingsDraft => alive ? {provider: provider.read(),baseUrl: baseUrl.read().trim(),apiKey: credential?.hidden ? '' : apiKey.read().trim()} : {...saved};
  const draftChanged = () => {if (alive) callbacks.onDraftChange?.(read());};
  const run = (name: string,task: (() => HostResult) | undefined,onError = fail,onPending?: (pending: boolean) => void) => {
    if (!alive || !task || operations.get(name)?.pending) return;
    const operation = {pending: true}; operations.set(name,operation); onPending?.(true);
    const current = () => alive && operations.get(name) === operation;
    const complete = (result: void | Result) => {if (current() && result && !result.ok) onError(result.error);};
    const failed = (error: unknown) => {if (current()) onError(error instanceof Error ? error.message : String(error));};
    const finish = () => {if (current()) {operation.pending = false;onPending?.(false);}};
    try {
      const result = task();
      if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).then(complete).catch(failed).finally(finish);
      else {complete(result);finish();}
    } catch (error) {try {failed(error);} finally {finish();}}
  };
  const release = () => {
    if (!alive) return;
    saved = {...read(),apiKey: ''};alive = false;revision++;operations.clear();providerButtons.clear();
    form.invalidate();remove.invalidate();dialog.destroy();
    try {callbacks.onClose?.();} catch {}
  };
  const close = () => {if (alive) {dialog.close();release();}};

  const appearanceHint = createTextPart({role: 'hint',text: 'A bright white workspace or a calm dark one, both with a blue accent. Follow system matches your computer.'});
  const appearanceError = createFeedbackPart({message: '',tone: 'error'});
  const appearanceChoice = createSelectPart({purpose: 'preference',label: 'Appearance',value: initial.appearance?.mode ?? 'system',describedBy: [appearanceHint],
    options: [{value: 'system',label: 'Follow system'},{value: 'light',label: 'Light'},{value: 'dark',label: 'Dark'}],
    onChange(value) {if (value === 'system' || value === 'light' || value === 'dark') run('appearance',callbacks.onAppearanceChange ? () => callbacks.onAppearanceChange!(value) : undefined);},
  });
  const appearanceLabel = createFieldLabelPart({label: 'Appearance',screenReaderOnly: true,control: appearanceChoice});
  const appearanceSection = createSectionPart({title: 'Appearance',children: [appearanceHint,appearanceLabel,appearanceChoice,appearanceError]});

  const version = createTextPart({role: 'hint',text: ''});
  const updateMessage = createFeedbackPart({presentation: 'paragraph',message: 'Loading update status…',tone: 'info',announce: 'polite'});
  const progress = createProgressPart({label: 'Update progress',value: 0,hidden: true});
  const updateAction = (action: 'check' | 'install') => run('update',callbacks.onUpdateAction ? () => {
    updateError = '';retryCheck = false;syncUpdates();return callbacks.onUpdateAction!(action);
  } : undefined,message => {updateError = message;retryCheck = action === 'check';syncUpdates();},pending => {localUpdatePending = pending;syncUpdates();});
  const check = createButtonPart({label: 'Check for updates',variant: 'secondary',disabled: true,onAction() {updateAction('check');}});
  const install = createButtonPart({label: 'Update and restart',variant: 'primary',hidden: true,onAction() {updateAction('install');}});
  const updateActions = createActionsPart({align: 'start',children: [check,install]});
  const updatesSection = createSectionPart({title: 'Updates',children: [createCopyGroupPart({children: [version,updateMessage]}),progress,updateActions]});

  const provider = createSelectPart({label: 'Provider',required: true,disabled: true,options: [{value: '',label: 'Loading providers…'}],onChange(value) {
    draftChanged();run('provider',callbacks.onProviderChange ? () => callbacks.onProviderChange!(value) : undefined);
  }});
  const providerLabel = createFieldLabelPart({label: 'Provider',control: provider});
  const providerToolbar = createToolbarPart({purpose: 'feature',label: 'Provider actions',children: []});
  const providerActionsHost = createFieldStackPart({hidden: true,children: [providerToolbar]});
  const authHint = createTextPart({role: 'hint',text: '',hidden: true});
  const providerField = createFieldStackPart({children: [providerLabel,provider,providerActionsHost,authHint]});
  const baseUrl = createInputPart({kind: 'url',name: 'baseUrl',value: initial.baseUrl,required: true,autocomplete: 'off',onInput: draftChanged,onInvalid() {advanced.setOpen(true);}});
  const baseUrlLabel = createFieldLabelPart({label: 'API base URL',control: baseUrl});
  advanced = createDisclosurePart({purpose: 'advanced',title: 'Advanced connection settings',children: [baseUrlLabel,createInputAdornmentPart({icon: 'globe',control: baseUrl}),
    createTextPart({role: 'hint',text: 'The provider’s endpoint is filled in automatically. Change it only for a proxy or custom service.'})]});
  const apiKey = createInputPart({kind: 'password',name: 'apiKey',required: !initial.hasApiKey,placeholder: initial.hasApiKey ? 'Leave blank to keep your current key' : 'Paste your API key',autocomplete: 'new-password',onInput: draftChanged});
  const keyStatus = createBadgePart({text: ''});
  const keyLabel = createFieldLabelPart({label: 'API key',control: apiKey,suffix: keyStatus});
  const remove = createButtonPart({label: 'Remove saved API key',variant: 'danger',hidden: true,onError: fail,async onAction() {
    if (!alive || state.disabled || state.testing || state.ready !== true || form.isPending() || removing) return;
    const target = revision;removing = true;feedback.update({message: '',tone: 'error'});syncAvailability();
    try {
      const result = callbacks.onRemoveKey ? await callbacks.onRemoveKey(read()) : {ok: false as const,error: 'This action is unavailable.'};
      if (alive && target === revision && result.ok) close();return result;
    } finally {if (alive && target === revision) {removing = false;syncAvailability();}}
  }});
  const keyField = createFieldStackPart({children: [keyLabel,apiKey,createTextPart({role: 'hint',text: 'The saved key is never returned to this page. Model requests go to your configured provider.'}),remove]});
  const addConnection = createButtonPart({label: 'Add independent model connection',variant: 'secondary',onError: fail,onAction() {if (alive && !state.disabled) return callbacks.onCreateConnection?.();}});
  const providerSection = createSectionPart({title: 'Model providers',children: [
    createTextPart({role: 'description',text: 'Connect your model providers here. Choose models and thinking effort beside the message box.'}),
    createActionsPart({align: 'start',children: [addConnection]}),providerField,advanced,keyField,
  ]});
  const test = createButtonPart({label: 'Test connection',variant: 'secondary',pending: true,onAction() {
    if (!alive || state.disabled || form.isPending() || removing || state.ready !== true) return;
    if (state.testing && callbacks.onCancelTest) run('cancel-test',callbacks.onCancelTest);
    else if (callbacks.onTest && (state.testing || form.reportValidity())) run('test',() => callbacks.onTest!(read()));
  }});
  const testResult = createStatusPart({message: '',tone: 'neutral'});
  const testSection = createSectionPart({children: [createTextPart({role: 'hint',text: 'Uses this provider’s last selected model, or Pith’s default, to check streaming and tool calling. Does not save settings or access files.'}),
    createActionsPart({align: 'start',children: [test]}),testResult]});
  const diagnostics = createButtonPart({label: 'Save diagnostics',variant: 'secondary',onAction() {run('diagnostics',callbacks.onDiagnostics);}});
  const diagnosticsSection = createSectionPart({children: [createTextPart({role: 'hint',text: 'Version, usage and failure category only; no conversation, file contents, paths or credentials.'}),createActionsPart({align: 'start',children: [diagnostics]})]});
  const cancel = createButtonPart({label: 'Cancel',variant: 'secondary',onAction: close});
  const save = createButtonPart({label: 'Save settings',variant: 'primary',type: 'submit',pending: true});
  form = createFormPart({children: [providerSection,testSection,feedback,diagnosticsSection,createFooterPart({children: [cancel,save]})],
    onPending() {syncAvailability();},onError: fail,async onSubmit() {
      const target = revision;feedback.update({message: '',tone: 'error'});
      const result = callbacks.onSubmit ? await callbacks.onSubmit(read()) : {ok: false as const,error: 'This action is unavailable.'};
      if (alive && target === revision && result.ok) close();return result;
    }});
  const layout = createFormLayoutPart({children: [appearanceSection,updatesSection,form]});
  dialog = createDialogPart({title: 'Settings',eyebrow: 'MAKE IT YOURS',children: [layout],onClose: release,onDispose: release});

  function syncProviderButtons(): void {
    if (!alive) return;
    const providerState = credential?.providerActions;
    const descriptions: Array<{action: ProviderAction;label: string;variant: 'secondary' | 'danger'}> = [];
    if (providerState?.oauth) descriptions.push({action: providerState.signedIn ? 'logout' : 'login',label: providerState.signedIn ? 'Sign out' : 'Sign in with provider',variant: 'secondary'});
    if (providerState?.custom) descriptions.push({action: 'custom',label: 'Edit models and prices',variant: 'secondary'},{action: 'remove-connection',label: 'Remove connection',variant: 'danger'});
    const retained = new Set<string>(),children: ButtonPart[] = [];
    for (const description of descriptions) {
      const key = JSON.stringify([providerState!.id,description.action]);retained.add(key);
      const {action,label,variant} = description;
      const content: ButtonPartState = {label,variant,disabled: !!state.disabled || !!providerState!.disabled};
      let button = providerButtons.get(key);
      if (!button) {const target = Object.freeze({id: providerState!.id});button = createButtonPart({...content,onError: fail,onAction() {if (alive && !state.disabled) return callbacks.onProviderAction?.(action,target);}});providerButtons.set(key,button);}
      else button.update(content);
      children.push(button);
    }
    providerToolbar.replace(children);
    for (const key of providerButtons.keys()) if (!retained.has(key)) providerButtons.delete(key);
    providerActionsHost.update({hidden: !providerState});
  }
  function syncAvailability(): void {
    if (!alive) return;
    const saving = form.isPending();
    form.update({disabled: !!state.disabled || !!state.testing || state.ready !== true || removing});
    save.update({label: 'Save settings',variant: 'primary',disabled: !!state.disabled,pending: saving || removing || !!state.testing || state.ready !== true});
    test.update({label: state.testing ? 'Cancel test' : 'Test connection',variant: 'secondary',disabled: !!state.disabled || saving || removing,pending: state.ready !== true});
    remove.update({label: 'Remove saved API key',variant: 'danger',hidden: !credential?.removeVisible,disabled: !!state.disabled || saving || !!state.testing || state.ready !== true,pending: removing});
    addConnection.update({label: 'Add independent model connection',variant: 'secondary',disabled: !!state.disabled});syncProviderButtons();
  }
  function syncUpdates(): void {
    if (!alive) return;
    const pending = externalUpdatePending || localUpdatePending;
    updateMessage.update({message: updateError || updateState?.message || '',tone: 'info',announce: 'polite'});
    if (!updateState) {check.update({label: 'Check for updates',variant: 'secondary',disabled: true,pending});install.update({label: 'Update and restart',variant: 'primary',hidden: true,pending});return;}
    version.update({text: `${productName} ${updateState.version}`});
    const busy = ['checking','installing','restarting'].includes(updateState.phase);
    check.update({label: 'Check for updates',variant: 'secondary',disabled: !updateState.enabled || busy && !retryCheck,pending});
    install.update({label: 'Update and restart',variant: 'primary',hidden: !updateState.availableVersion,disabled: !updateState.enabled || busy,pending});
    progress.update({label: 'Update progress',value: updateState.progress,hidden: updateState.phase !== 'installing'});
  }
  function update(next: Readonly<SettingsState>): void {
    if (!alive) return;
    state = next;if (next.error !== undefined) fail(next.error);
    if (next.appearance) {appearanceChoice.reset(next.appearance.mode);appearanceChoice.update({disabled: !!next.appearance.disabled});appearanceError.update({message: next.appearance.error ?? '',tone: 'error'});}
    if (next.testResult) testResult.update({message: next.testResult.message,tone: next.testResult.ok === undefined ? 'neutral' : next.testResult.ok ? 'success' : 'error'});
    syncAvailability();
  }
  update(initial);
  return {
    part: dialog,open() {if (alive) dialog.open();},read,update,
    setProviders(items,selected) {if (!alive) return;const previous = selected ?? provider.read();provider.update({options: items.map(item => ({value: item.id,label: `${item.name}${item.signedIn ? ' · Signed in' : item.configured ? ' · Configured' : ''}`})),disabled: !items.length});provider.reset(items.some(item => item.id === previous) ? previous : items[0]?.id ?? '');},
    resetProvider(value) {
      if (!alive) return;
      revision++;for (const name of operations.keys()) if (name !== 'update') operations.delete(name);
      removing = false;form.invalidate();remove.invalidate();fail('');provider.reset(value.provider);baseUrl.reset(value.baseUrl);
      if (value.clearKey) apiKey.reset('');if (value.collapseAdvanced) advanced.setOpen(false);syncAvailability();
    },
    setCredential(view) {
      if (!alive) return;
      credential = view;keyStatus.update({text: view.status});keyField.update({hidden: view.hidden});apiKey.update({disabled: view.hidden,required: view.required,placeholder: view.placeholder});
      authHint.update({text: view.hint ?? '',hidden: !view.hint});syncAvailability();
    },
    clearSecrets() {if (alive) apiKey.reset('');saved.apiKey = '';},
    updateUpdates(next) {if (alive) {updateState = next;updateError = '';retryCheck = false;syncUpdates();}},
    setUpdatePending(pending) {if (alive) {externalUpdatePending = pending;syncUpdates();}},
    setUpdateError(message,options = {}) {if (alive) {updateError = message;retryCheck = !!options.allowCheckRetry;syncUpdates();}},
    fail,close,isOpen: () => alive && dialog.isOpen(),destroy: close,
  };
}
