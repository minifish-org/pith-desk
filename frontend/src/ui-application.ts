/** Connect shared UI regions to Desk business state and callbacks. */
import {
  createDownloadPart,createFeedbackPart,createStatusActionsPart,createTextPart,
  createButtonPart,createDialogPart,createFormPart,createInputPart,createFieldLabelPart,
  createFormLayoutPart,createFooterPart,createOptionGroupPart,createOptionActionPart,createTextareaPart,mountParts,type BrandMarkOptions
} from 'pith-ui';
import {
  composeFrame,type FrameState,type FrameCallbacks,type FrameContent,composeConversationReader,type Appearance,type RecipeResult,
  type ConversationBodyState,ConversationBodyCallbacks,composeComposer,type ComposerCallbacks,
  type ComposerState,composeWelcome,type WelcomeState,composePendingMessages,
  composeApproval,composeTaskFailure,composeRuntime,type RuntimeState,
  composeCostLedger,type CostLedgerState,composeCompletionNotices,composeImageViewer,
  composeArtifacts,type ArtifactsState,type ArtifactsCallbacks,composeFilePreview,
  composeFileBrowser,type FileBrowserState,type FileBrowserCallbacks,
  type PreviewInput,type PreviewCallbacks,composeSettings,composeMCPConnections,
  composeModelPicker,composeCustomConnection,composeCustomConnectionLoading,composeProviderLogin,
  composeResourcesInventory,composeResourceEditor,composeResourceLoading,composeWorkspacePicker,
  composeRename,composeFullAccess,composeBranchHistory,composeTextEditor,
  type TextEditorState,composeConfirmation,createDialogHost
} from 'pith-ui/recipes';

type HostResult = void|RecipeResult|Promise<void|RecipeResult>;
export interface DeskWorkspaceCallbacks extends Omit<FrameCallbacks,'onAction'|'onModalChange'|'onDispose'>,Omit<ComposerCallbacks,'onAction'|'onOpenImage'>,ConversationBodyCallbacks {
  onAction?(action: 'workspace'|'resources'|'connections'|'settings'|'model'|'compact'|'continue'|'diagnostics'): HostResult;
  onBusyAction?(key: string): void;onQueueAction?(action: 'steer'|'edit'|'delete',id: string): void;
  onApproval?(id: string,action: 'deny'|'always'|'allow'): void;onCostsChange?(): void;
  onCompletionOpen?(id: string): void;onCompletionDismiss?(runId: string): void;
}
export interface DeskOptions {
  titlebar?: FrameContent['titlebar'];
  brand?: {name: string;qualifier?: string;mark?: BrandMarkOptions};appearance?: Appearance;
  workspace?: DeskWorkspaceCallbacks;host?: {copyText?(text: string): HostResult;openExternal?(url: string): HostResult};
  fileBrowser?: FileBrowserCallbacks;
  onUIStateChange?(state: {hasModal: boolean;appearance: Appearance}): void;onError?(message: string): void;
  server?: boolean;onLogout?(): Promise<void>;
}
export interface ServerAccessState {phase: 'login'|'blocked'|'offline';error?: string;recoveryText?: string}
export interface ServerAccessCallbacks {onLogin(token: string): Promise<void>;onReconnect(): Promise<void>;onTakeover(): Promise<void>}
export interface DeskShellState extends Pick<FrameState,'workspace'|'conversation'|'reconnecting'> {error?: {message: string;hidden?: boolean};busy?: {key: string;message: string;actionLabel: string}|null}
export interface DeskAvailability extends NonNullable<FrameState['availability']> {global?: boolean;active?: boolean}

/** One ownership/theme mount. Every dialog is a direct child of this frame. */
export function mountDesk(mount: HTMLElement,options: DeskOptions = {}) {
  let disposed = false,appearance = options.appearance ?? 'system',lastModal = false,activeId = '';
  const callbacks = options.workspace ?? {};
  let frameState: FrameState = {navigation: {groups: [],empty: 'workspaces'}},availability: DeskAvailability = {},composerState: ComposerState = {},messageAvailability: Partial<Record<'copy'|'edit'|'branch',boolean>> = {};
  let composerModel = {label: 'Choose model',description: '',disabled: false};
  let currentMessages: ConversationBodyState['messages'] = [],working = false,busyKey = '';
  let welcomeState: WelcomeState = {hasApiKey: false,hasConnections: false,modelName: '',hidden: true};
  const report = (error: unknown) => {try {(options.onError ?? callbacks.onError)?.(error instanceof Error ? error.message : String(error));} catch {}};
  const notify = (callback?: () => void) => {try {callback?.();} catch (error) {report(error);}};
  const copyText = (text: string): HostResult => options.host?.copyText ? options.host.copyText(text) : navigator.clipboard.writeText(text);
  const read = () => Object.freeze({hasModal: !disposed && frame.part.hasModal(),appearance});
  function changed(): void {const state = read();if (state.hasModal !== lastModal) {lastModal = state.hasModal;notify(() => options.onUIStateChange?.(state));}}
  const viewer = composeImageViewer({onClose: changed}),downloads = createDownloadPart();
  const composer = composeComposer({}, {...callbacks,onOpenImage: image => {if (!disposed) {viewer.open(image);changed();}}});
  const welcome = composeWelcome(welcomeState,{onAction: callbacks.onAction,onError: report,canPrompt: () => !disposed && !composerState.disabled && !composerState.readOnly && !availability.busy && !read().hasModal,
    onPrompt(text) {composer.resetDraft(text);composer.focusComposer();callbacks.onInput?.(text);}},options.brand?.mark);
  const reader = composeConversationReader({id: '',messages: [],working: false},{...callbacks,onError: report,onCopyCode: callbacks.onCopyCode ?? copyText,
    onMessageAction: callbacks.onMessageAction ?? (target => target.action === 'copy' ? copyText(currentMessages.find(message => message.id === target.messageId)?.text || '') : undefined),
    onImage(image) {if (!disposed) {viewer.open(image);changed();}}},{before: [welcome.part]});
  let busyText: ReturnType<typeof createTextPart>|undefined,busyAction: ReturnType<typeof createButtonPart>|undefined;
  const busy = createStatusActionsPart({children: [],hidden: true}),error = createFeedbackPart({presentation: 'banner',tone: 'error',message: '',hidden: true});
  const pending = composePendingMessages({items: [],running: false,busy: false},{onQueueAction: callbacks.onQueueAction});
  const approval = composeApproval({approval: null},{onAction: callbacks.onApproval});
  let failureState: Parameters<typeof composeTaskFailure>[0] = {visible: false,message: '',advice: '',canContinue: false};
  const failure = composeTaskFailure(failureState,{onAction: action => callbacks.onAction?.(action),onError: report});
  const emptyRuntime: RuntimeState = {visible: false,summary: '',duration: '',speed: '',inputTokens: '',outputTokens: '',cacheRead: '',cacheWrite: '',contextTokens: '',contextWindow: '',compactions: '',toolFailures: '',recordedCost: '',latestCost: ''};
  const ledger = composeCostLedger(),runtime = composeRuntime(emptyRuntime,{costLedger: ledger.part,onCostsChange: callbacks.onCostsChange});
  const notices = composeCompletionNotices([],{onOpen: callbacks.onCompletionOpen,onDismiss: callbacks.onCompletionDismiss});
  composer.panels.replace([approval.part,busy,error,failure.part,runtime.part,pending.part]);
  let artifactsState: ArtifactsState = {ownerId: '',files: [],loading: false,error: '',copyMode: 'path'};
  let artifactsCallbacks: ArtifactsCallbacks = {onPreview() {},onFileAction() {}};
  const artifacts = composeArtifacts(artifactsState,artifactsCallbacks,{announcement: reader.announcement,relatedDialogs: [viewer.part]});
  const fileBrowser = composeFileBrowser({workspaceId: '',location: '',query: '',directories: []},options.fileBrowser);
  const logout = options.server ? createButtonPart({label: 'Log out',title: 'Log out',variant: 'quiet-icon',icon: 'logout',onAction: options.onLogout,onError: report}) : undefined;
  const frame = composeFrame(frameState,{...callbacks,onError: report,onModalChange: changed,onDispose() {disposed = true;changed();}},
    {titlebar: options.titlebar,main: [reader.find,reader.region,composer.part],siblings: [notices.part,reader.announcement,downloads],dialogs: [viewer.part],topbarActions: [artifacts.part,...(logout ? [logout] : [])],tools: {label: 'Workspace files',children: [fileBrowser.part]},brand: options.brand ?? {name: 'Pith'}});
  const mounted = mountParts(mount,frame.part,{appearance});
  const dialogs = createDialogHost(frame,{persistentDialogs: [viewer.part],onChange: changed,onError: report});
  const opening = dialogs.open;
  function recoveredTextPart(text: string) {
    return createTextareaPart({purpose: 'text',label: 'Unsent text on this page',value: text,readOnly: true});
  }
  function openRecoveredDrafts(text: string,onDiscard: () => void) {
    return opening('recovered-drafts',onClose => {
      const part = createDialogPart({title: 'Recovered unsent text',children: [
        createTextPart({role: 'description',text: 'This page kept text that could not be confirmed as saved. Copy or download it before discarding. Check the current conversation and queue before submitting again; nothing is sent automatically.'}),
        recoveredTextPart(text),createFooterPart({children: [
          createButtonPart({label: 'Download text',variant: 'secondary',onAction: () => downloads.download({blob: new Blob([text],{type: 'text/plain;charset=utf-8'}),name: 'pith-desk-unsent-text.txt'}),onError: report}),
          createButtonPart({label: 'Discard copy',variant: 'secondary',onAction() {onDiscard();part.close();}}),
          createButtonPart({label: 'Close',variant: 'primary',onAction() {part.close();}}),
        ]}),
      ],onClose,onDispose: onClose});
      return {part,open: part.open,close: part.close,isOpen: part.isOpen,destroy: part.destroy};
    },local => local.open());
  }
  function openServerAccess(state: ServerAccessState,actions: ServerAccessCallbacks) {
    return opening('server-session',onClose => {
      const login = state.phase === 'login';
      const token = createInputPart({kind: 'password',label: 'Server token',name: 'server-token',autocomplete: 'current-password',required: login,hidden: !login});
      const label = createFieldLabelPart({label: 'Server token',control: token,hidden: !login});
      const feedback = createFeedbackPart({message: state.error ?? '',tone: 'error'});
      const description = createTextPart({role: 'description',text: login ? 'Sign in with the token configured on your Pith Desk server.' : 'Another page may control Pith Desk. Reconnect after it disconnects, or take over now. Tasks keep running.'});
      const fail = (message: string) => feedback.update({message,tone: 'error'});
      const submit = createButtonPart({label: login ? 'Sign in' : 'Reconnect',variant: 'primary',type: 'submit'});
      const takeover = createButtonPart({label: 'Take over',variant: 'secondary',hidden: login,onAction: actions.onTakeover,onError: fail});
      const form = createFormPart({children: [createFormLayoutPart({children: [description,label,token,feedback,...(state.recoveryText ? [createTextPart({role: 'hint',text: 'Unsent text is kept on this page. Copy it below, or reconnect to download it. It will not be submitted automatically.'}),recoveredTextPart(state.recoveryText)] : [])]}),createFooterPart({children: [takeover,submit]})],onError: fail,
        async onSubmit() {const value = token.read();token.reset('');if (login) await actions.onLogin(value);else await actions.onReconnect();}});
      const part = createDialogPart({title: login ? 'Pith Desk Server' : 'Reconnect to Pith Desk',closeDisabled: true,closeOnBackdrop: false,children: [form],onClose,onDispose: onClose});
      return {part,open() {part.open();if (login) token.focus();},close: part.close,isOpen: part.isOpen,destroy: part.destroy};
    },local => local.open());
  }
  function openServerWorkspace(initial: Parameters<typeof composeWorkspacePicker>[0],actions: Parameters<typeof composeWorkspacePicker>[1] = {}) {
    return opening('workspace',onClose => {
      let state = initial;
      const path = createInputPart({purpose: 'path',label: 'Server folder path',placeholder: '/srv/workspace',required: true});
      const label = createFieldLabelPart({label: 'Server folder path',control: path});
      const feedback = createFeedbackPart({message: state.error ?? '',tone: 'error'});
      const fail = (message: string) => feedback.update({message,tone: 'error'});
      const rows = state.workspaces.map(workspace => ({workspace,part: createOptionActionPart({label: workspace.name,description: workspace.path,icon: 'folder',onAction() {part.close();actions.onSelect?.(workspace.id);},onError: fail})}));
      const submit = createButtonPart({label: 'Add workspace',variant: 'primary',type: 'submit'});
      const cancel = createButtonPart({label: 'Cancel',variant: 'secondary',onAction() {part.close();}});
      const form = createFormPart({children: [createFormLayoutPart({children: [label,path,feedback]}),createFooterPart({children: [cancel,submit]})],onError: fail,onSubmit: () => actions.onSubmit?.(path.read().trim())});
      const part = createDialogPart({title: 'Server workspaces',description: 'Choose an existing absolute directory on the server. Browser-local folders are not uploaded.',children: [createOptionGroupPart({children: rows.map(row => row.part)}),form],onClose,onDispose: onClose});
      const update = (next: typeof state) => {state = next;form.update({disabled: !!state.disabled});for (const row of rows) row.part.update({label: row.workspace.name,description: row.workspace.path,icon: 'folder',disabled: !!state.disabled});if (state.error) fail(state.error);};
      update(state);
      return {part,open() {part.open();path.focus();},read: () => ({path: path.read()}),reset(value = '') {path.reset(value);},focus: path.focus,update,fail,close: part.close,isOpen: part.isOpen,destroy: part.destroy};
    },local => local.open(),actions.onClose);
  }
  const compactDisabled = () => !!availability.busy || !!availability.active || working || !activeId || !currentMessages.length;
  const syncFrame = () => {frameState = {...frameState,availability,compactDisabled: compactDisabled()};frame.update(frameState);};
  const syncFailure = () => failure.update({...failureState,disabled: !!availability.busy || (failureState.workspaceId ? !!availability.workspaces?.includes(failureState.workspaceId) : !!availability.active)});
  let syncResourceEditor = () => {};
  const syncComposer = () => composer.updateComposer({...composerState,model: {...composerModel,disabled: composerModel.disabled || !!availability.global || !!availability.busy}});
  function openEditor(slot: 'message'|'queue',initial: TextEditorState & {value: string},actions: Parameters<typeof composeTextEditor>[1] = {}) {
    let state = initial;
    const local = opening(slot,onClose => composeTextEditor(initial,{...actions,purpose: slot === 'message' ? 'message' : 'queue-message',onClose}),value => value.open({value: initial.value}),actions.onClose);
    return {...local,update(next: TextEditorState & {value: string}) {if (local.isOpen()) {state = next;local.update(next);}},reset(value: string) {if (local.isOpen()) {state = {...state,value};local.reset(value);}},fail(message: string) {if (local.isOpen()) local.update({...state,error: message});}};
  }
  const workspace = {
    updateShell(state: Readonly<DeskShellState>) {if (disposed) return;frameState = {...frameState,...(state.workspace !== undefined ? {workspace: state.workspace} : {}),...(state.conversation !== undefined ? {conversation: state.conversation} : {}),reconnecting: state.reconnecting};syncFrame();
      if (state.error) error.update({message: state.error.message,tone: 'error',hidden: !!state.error.hidden || !state.error.message});
      if (state.busy !== undefined) {busy.update({hidden: !state.busy});if (state.busy) {
        if (!busyText || !busyAction) {busyText = createTextPart({text: ''});busyAction = createButtonPart({variant: 'text-action',label: '',onAction() {if (!disposed && busyKey) callbacks.onBusyAction?.(busyKey);}});busy.replace([busyText,busyAction]);}
        busyKey = state.busy.key;busyText.update({text: state.busy.message});busyAction.update({variant: 'text-action',label: state.busy.actionLabel});}}},
    updateNavigation(state: FrameState['navigation']) {if (!disposed) {frameState = {...frameState,navigation: state};syncFrame();}},
    updateComposer(state: Readonly<ComposerState>) {if (!disposed) {composerState = state;if (state.model) composerModel = {...state.model,disabled: !!state.model.disabled};syncComposer();}},
    readDraft: composer.readDraft,resetDraft: composer.resetDraft,focusComposer: composer.focusComposer,pickImages: composer.pickImages,insertReferences: composer.insertReferences,
    updatePermission: composer.updatePermission,updateAttachments: composer.updateAttachments,updateImageGuidance: composer.updateImageGuidance,setDropPending: composer.setDropPending,receiveNativeDrop: composer.receiveNativeDrop,
    updateConversation(state: Readonly<ConversationBodyState>) {if (disposed) return;if (state.id !== activeId) {viewer.close();runtime.resetCosts();ledger.clear();}activeId = state.id;currentMessages = state.messages;working = state.working;reader.update(state);welcome.update({...welcomeState,hidden: !!state.messages.length});syncFrame();},
    updateWelcome(state: Readonly<WelcomeState>) {if (!disposed) {welcomeState = state;welcome.update({...state,hidden: !!currentMessages.length});}},
    updateMessageAvailability(state: typeof messageAvailability) {if (!disposed) {messageAvailability = {...state};reader.updateAvailability(state);}},
    updateAvailability(state: Readonly<DeskAvailability>) {if (!disposed) {availability = state;composer.updateAvailability(state);reader.updateHostAvailability(state);syncComposer();syncFailure();syncResourceEditor();syncFrame();artifacts.update({...artifactsState,disabled: !!artifactsState.disabled || !!state.busy || state.conversations?.includes(artifactsState.ownerId)},artifactsCallbacks);}},
    updatePending: pending.update,updateApproval: approval.update,updateFailure(state: Readonly<Parameters<typeof composeTaskFailure>[0]>) {if (!disposed) {failureState = state;syncFailure();}},updateRuntime: runtime.update,updateTiming: runtime.updateTiming,
    updateNotices: notices.update,
    readCosts: runtime.readCosts,resetCosts() {if (!disposed) {runtime.resetCosts();ledger.clear();}},
    updateCosts(state: {visible: boolean;error?: string;loading?: boolean;report?: CostLedgerState}) {if (disposed) return;runtime.updateCostsVisible(state.visible);if (state.error) ledger.setError(state.error);else if (state.loading) ledger.loading();else if (state.report) ledger.update(state.report);},
    followLatest: reader.followLatest,openFind: reader.openFind,closeFind: reader.closeFind,pruneConversations: reader.prune,
    search: frame.search,closeNavigationMenu: frame.closeNavigationMenu,setSidebarOpen: frame.setSidebarOpen,closeNavigationOverlay: frame.closeNavigationOverlay,
    openWorkspacePicker(state: Parameters<typeof composeWorkspacePicker>[0],actions: Parameters<typeof composeWorkspacePicker>[1] = {}) {return options.server ? openServerWorkspace(state,actions) : opening('workspace',onClose => composeWorkspacePicker(state,{...actions,onClose}),local => local.open(),actions.onClose);},
    openRename(state: Parameters<typeof composeRename>[0],actions: Parameters<typeof composeRename>[1] = {}) {let current = state;const local = opening('rename',onClose => composeRename(state,{...actions,onClose}),value => value.open(),actions.onClose);return {...local,update(next: typeof state) {if (local.isOpen()) {current = next;local.update(next);}},fail(error: string) {if (local.isOpen()) {current = {...current,error};local.update(current);}}};},
    openFullAccess(state: Parameters<typeof composeFullAccess>[0],actions: Parameters<typeof composeFullAccess>[1]) {let current = state;const local = opening('permissions',onClose => composeFullAccess(state,{...actions,onClose}),value => value.open(),actions.onClose);return {...local,update(next: typeof state) {if (local.isOpen()) {current = next;local.update(next);}},fail(error: string) {if (local.isOpen()) {current = {...current,error};local.update(current);}}};},
    openHistory(state: Parameters<typeof composeBranchHistory>[0],actions: Parameters<typeof composeBranchHistory>[1] = {}) {return opening('feature',onClose => composeBranchHistory(state,{...actions,onClose}),local => local.open(),actions.onClose);},
    openMessageEditor(state: TextEditorState & {value: string},actions: Parameters<typeof composeTextEditor>[1] = {}) {return openEditor('message',state,actions);},
    openQueueEditor(state: TextEditorState & {value: string},actions: Parameters<typeof composeTextEditor>[1] = {}) {return openEditor('queue',state,actions);},
    openConfirmation(state: {title: string;action: string;description: {before: string;subject?: string;after?: string};hint?: string;error?: string;disabled?: boolean},actions: Parameters<typeof composeConfirmation>[1]) {
      let current = state;const presentation = (value: typeof state) => ({title: value.title,confirmLabel: value.action,message: value.description,hint: value.hint,error: value.error,disabled: value.disabled});
      const local = opening('confirmation',onClose => composeConfirmation(presentation(state),{...actions,onClose}),value => value.open(),actions.onClose);
      return {...local,update(next: typeof state) {if (local.isOpen()) {current = next;local.update(presentation(next));}},fail(error: string) {if (local.isOpen()) {current = {...current,error};local.update(presentation(current));}}};},
  };
  const settings = {
    openSettings(state: Parameters<typeof composeSettings>[0],actions: Parameters<typeof composeSettings>[1] = {}) {return opening('settings',onClose => composeSettings(state,{...actions,onClose},[options.brand?.name ?? 'Pith',options.brand?.qualifier].filter(Boolean).join(' ')),local => local.open(),actions.onClose);},
    openConnections(state: Parameters<typeof composeMCPConnections>[0] = {},actions: Parameters<typeof composeMCPConnections>[1] = {}) {return opening('connections',onClose => composeMCPConnections(state,{...actions,onClose}),local => local.open(),actions.onClose);},
    openModels(state: Parameters<typeof composeModelPicker>[0],actions: Parameters<typeof composeModelPicker>[1] = {}) {let current = state;const local = opening('model',onClose => composeModelPicker(state,{...actions,onClose}),value => value.open(),actions.onClose);return {...local,update(next: typeof state) {if (local.isOpen()) {current = next;local.update(next);}},fail(error: string) {if (local.isOpen()) {current = {...current,error};local.update(current);}}};},
    openConnectionLoading(state: Parameters<typeof composeCustomConnectionLoading>[0],actions: Parameters<typeof composeCustomConnectionLoading>[1] = {}) {return opening('feature',onClose => composeCustomConnectionLoading(state,{...actions,onClose}),local => local.open(),actions.onClose);},
    openCustomConnection(state: Parameters<typeof composeCustomConnection>[0],actions: Parameters<typeof composeCustomConnection>[1] = {}) {return opening('feature',onClose => composeCustomConnection({...state,...(options.server ? {connectionHint: 'Model requests run on the server. localhost in a Base URL refers to that server. The saved API key is never returned to this page.'} : {})},{...actions,onClose}),local => local.open(),actions.onClose);},
    openProviderLogin(state: Parameters<typeof composeProviderLogin>[0],actions: Parameters<typeof composeProviderLogin>[1] = {}) {return opening('oauth',onClose => composeProviderLogin(state,{...actions,
      ...(options.host?.openExternal ? {onOpenExternal: options.host.openExternal} : {}),onClose}),local => local.open(),actions.onClose);},
  };
  const resources = {
    open(state: Parameters<typeof composeResourcesInventory>[0],actions: Parameters<typeof composeResourcesInventory>[1] = {}) {return opening('resources',onClose => composeResourcesInventory(state,{...actions,onClose}),local => local.open(),actions.onClose);},
    openEditorLoading(state: Parameters<typeof composeResourceLoading>[0],actions: Parameters<typeof composeResourceLoading>[1] = {}) {return opening('feature',onClose => composeResourceLoading(state,{...actions,onClose}),local => local.open(),actions.onClose);},
    openEditor(state: Parameters<typeof composeResourceEditor>[0],actions: Parameters<typeof composeResourceEditor>[1] = {}) {
      let current = state,local: ReturnType<typeof composeResourceEditor>;
      const project = (value: typeof state) => ({...value,saveDisabled: !!availability.busy || (value.workspaceId ? !!availability.workspaces?.includes(value.workspaceId) : !!availability.active)});
      const sync = () => {if (local?.isOpen()) local.update(project(current));};
      local = opening('feature',onClose => composeResourceEditor(project(state),{...actions,onClose() {if (syncResourceEditor === sync) syncResourceEditor = () => {};onClose();}}),value => value.open(),actions.onClose);
      if (local.isOpen()) syncResourceEditor = sync;
      return {...local,update(next: typeof state) {if (local.isOpen()) {current = next;sync();}},fail(message: string) {if (local.isOpen()) {current = {...current,error: message};local.fail(message);}}};
    },
  };
  const files = {
    updateWorkspace: fileBrowser.update,areToolsOpen: frame.isToolsOpen,setToolsOpen: frame.setToolsOpen,closeToolsOverlay: frame.closeToolsOverlay,
    updateArtifacts(state: ArtifactsState,actions: ArtifactsCallbacks) {if (!disposed) {artifactsState = state;artifactsCallbacks = actions;artifacts.update({...state,disabled: !!state.disabled || !!availability.busy || availability.conversations?.includes(state.ownerId)},actions);}},
    closeArtifacts: artifacts.close,areArtifactsOpen: artifacts.isOpen,
    openPreview(state: PreviewInput,actions: PreviewCallbacks = {}) {return opening('preview',onClose => composeFilePreview(state,{...actions,onCopyCode: actions.onCopyCode ?? callbacks.onCopyCode ?? copyText,onImage(image) {viewer.open(image);changed();},onClose},reader.announcement),local => {artifacts.setRelatedDialogs([viewer.part,local.part]);local.open();},actions.onClose);},
  };
  return {workspace,settings,resources,files,read,openServerAccess,openRecoveredDrafts,downloadFile: downloads.download,setAppearance(next: typeof appearance) {if (!disposed) {appearance = next;mounted.setAppearance(next);notify(() => options.onUIStateChange?.(read()));}},
    destroy() {if (disposed) return;disposed = true;frame.destroy();changed();}};
}
