/** Desk-owned presentation models. Page composition and business lifetimes stay in Desk. */
import type { ActionResult, Appearance, ConfirmDialog, Dialog, TextEditDialog } from 'pith-ui';
export type { ActionResult, Appearance, ConfirmDialog, Dialog, TextEditDialog } from 'pith-ui';
export interface AppArtifactsState {
    readonly ownerId: string;
    readonly files: readonly {
        readonly name: string;
        readonly path: string;
    }[];
    readonly loading: boolean;
    readonly error: string;
    readonly copyMode: 'file' | 'path';
    readonly disabled?: boolean;
}
export type AppFileAction = 'open' | 'reveal' | 'copy' | 'copy-path';
export interface AppFileOwner {
    readonly kind: 'artifact';
    readonly id: string;
}
export interface AppFilePreviewState {
    readonly kind: 'text' | 'markdown' | 'diff' | 'image';
    readonly text?: string;
    readonly imageSrc?: string;
    readonly imageAlt?: string;
    readonly truncated?: boolean;
    readonly error?: string;
    readonly disabled?: boolean;
}
export interface AppFileTarget {
    readonly owner: AppFileOwner;
    readonly name: string;
    readonly path: string;
}
export interface Application {
    readonly workspace: WorkspaceScene;
    readonly settings: SettingsScene;
    readonly resources: ResourcesScene;
    readonly files: FilesScene;
    read(): ApplicationState;
    setAppearance(appearance: Appearance): void;
    /** Attach one independently composed small dialog, retaining app modal guards. */
    attachDialog(dialog: ApplicationDialog): {
        destroy(): void;
    };
    downloadFile(file: {
        readonly blob: Blob;
        readonly name: string;
    }): Promise<ActionResult>;
    destroy(): void;
}
export interface ApplicationBrand {
    readonly name: string;
    readonly qualifier?: string;
    readonly mark?: {
        readonly src: string;
        readonly darkSrc?: string;
        readonly alt: string;
        readonly symbol?: never;
    } | {
        readonly symbol: 'pith';
        readonly alt: string;
        readonly src?: never;
        readonly darkSrc?: never;
    };
}
export interface ApplicationConversation {
    readonly id: string;
    readonly title?: string;
    readonly active: boolean;
    readonly status?: NavigationStatus;
    readonly actions?: {
        readonly rename?: boolean;
        readonly history?: boolean;
        readonly export?: boolean;
        readonly delete?: boolean;
    };
}
export type ApplicationDialog = Dialog | TextEditDialog | ConfirmDialog;
export interface ApplicationHost {
    copyText?(text: string): HostResult;
    openExternal?(url: string): HostResult;
}
export interface ApplicationOptions {
    readonly brand?: ApplicationBrand;
    readonly appearance?: Appearance;
    readonly host?: ApplicationHost;
    readonly workspace?: WorkspaceCallbacks;
    readonly onUIStateChange?: (state: ApplicationState) => void;
    readonly onError?: (message: string) => void;
}
export interface ApplicationState {
    readonly hasModal: boolean;
    readonly appearance: Appearance;
}
export interface ApplicationWorkspace {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly selected: boolean;
    readonly children: readonly ApplicationConversation[];
    readonly canRemove?: boolean;
}
export interface AppResourceEditorState {
    readonly workspaceId: string;
    readonly workspacePath: string;
    readonly path?: string;
    readonly kind: AppResourceKind;
    readonly name?: string;
    readonly content: string;
    readonly editable: boolean;
    readonly workspaceBusy: boolean;
    readonly error?: string;
    readonly disabled?: boolean;
}
export interface AppResourceEntry {
    readonly name: string;
    readonly path: string;
    readonly description?: string;
    readonly content?: string;
}
export type AppResourceKind = 'instructions' | 'skill' | 'template';
export interface AppResourceTarget {
    readonly workspaceId: string;
    readonly kind: AppResourceKind;
    readonly name: string;
    readonly path: string;
}
export interface ApprovalPanelState {
    approval: ApprovalView | null;
    disabled?: boolean;
}
export interface ApprovalView {
    id: string;
    toolName: string;
    warning?: string;
    canAlwaysAllow: boolean;
    argsText: string;
    preview?: {
        kind: string;
        path: string;
        error?: string;
        diff?: string;
        truncated?: boolean;
    };
}
export interface ArtifactsCallbacks {
    onPreview?: (target: AppFileTarget) => FileActionResult;
    onFileAction?: (action: AppFileAction, target: AppFileTarget) => FileActionResult;
}
export interface AttachmentItem {
    id: string;
    url: string;
    name: string;
}
export interface AttachmentsState {
    items: readonly AttachmentItem[];
    disabled?: boolean;
}
export interface BranchHistoryNode {
    id: string;
    role: string;
    text: string;
    active: boolean;
}
export interface BranchHistoryState {
    nodes: readonly BranchHistoryNode[] | null;
    error?: string;
    loading?: boolean;
}
export interface CompletionNoticeDisplay {
    id: string;
    runID: string;
    title: string;
    workspace: string;
}
export interface ComposerViewState {
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    action?: 'send' | 'queue' | 'stop';
    actionDisabled?: boolean;
    model?: {
        label: string;
        description: string;
        disabled?: boolean;
    };
    thinking?: {
        options: readonly {
            value: string;
            label: string;
        }[];
        value: string;
        disabled?: boolean;
    };
}
export interface ConfirmationState {
    readonly title: string;
    readonly action: string;
    readonly description: {
        readonly before: string;
        readonly subject?: string;
        readonly after?: string;
    };
    readonly hint?: string;
    readonly error?: string;
    readonly disabled?: boolean;
}
export interface ConversationAction {
    action: 'copy' | 'edit' | 'branch';
    messageId: string;
    branchKey?: string;
}
export interface ConversationActionAvailability {
    copy?: boolean;
    edit?: boolean;
    branch?: boolean;
}
/** UI data only. Hosts decide copy/edit/branch eligibility and resolve images. */
export interface ConversationMessage {
    id: string;
    role: string;
    text: string;
    timestamp?: number;
    toolName?: string;
    toolCallId?: string;
    status?: string;
    images?: Array<{
        index: number;
        mimeType?: string;
    }>;
    command?: {
        text: string;
        cwd: string;
        exitCode?: number;
    };
    actions?: {
        copy?: boolean | string;
        edit?: boolean;
        branch?: {
            key: string;
            label?: string;
        };
    };
}
export type ConversationNavigationAction = 'rename' | 'history' | 'export' | 'delete';
export interface ConversationState {
    readonly id: string;
    readonly messages: readonly ConversationMessage[];
    readonly working: boolean;
}
export interface CostLedgerState {
    unknownRequests: number;
    requests: readonly CostRequestDisplay[] | null;
}
export interface CostRequestDisplay {
    id: string;
    purpose: string;
    status: string;
    provider: string;
    providerName?: string;
    model: string;
    modelName?: string;
    time: string;
    source: string;
    price: unknown;
    known: boolean;
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning?: number;
        cost: {
            total: number;
        };
    };
}
export interface CustomConnectionCallbacks {
    onSubmit?: Submission<CustomConnectionDraft>;
    onClose?: () => void;
}
export interface CustomConnectionDraft {
    name: string;
    baseUrl: string;
    api: string;
    apiKey: string;
    models: CustomModelDraft[];
}
export interface CustomConnectionSession extends SettingsViewSession<CustomConnectionState> {
    read(): CustomConnectionDraft;
    clearSecrets(): void;
}
export interface CustomConnectionState {
    name: string;
    baseUrl: string;
    api: string;
    editing: boolean;
    models: readonly CustomModelValue[];
    error?: string;
    disabled?: boolean;
}
export interface CustomModelDraft {
    sourceIndex: number;
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    images: boolean;
    prices: {
        input: string;
        output: string;
        cacheRead: string;
        cacheWrite: string;
    };
}
export interface CustomModelValue {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: readonly string[];
    cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
export type FileActionResult = void | ActionResult | Promise<void | ActionResult>;
export interface FileCapabilities {
    readonly open?: boolean;
    readonly reveal?: boolean;
    readonly copyMode?: 'file' | 'path' | 'none';
}
export interface FilePreviewCallbacks {
    onFileAction?: (action: AppFileAction, target: AppFileTarget) => FileActionResult;
    onCopyCode?: (text: string) => FileActionResult;
    onClose?: () => void;
}
export interface FilePreviewInput extends AppFileTarget {
    readonly capabilities: FileCapabilities;
    readonly content?: AppFilePreviewState;
}
export interface FilePreviewSession {
    update(state: Readonly<AppFilePreviewState>): void;
    fail(message: string): void;
    close(): void;
    isOpen(): boolean;
    destroy(): void;
}
export interface FilesScene {
    updateArtifacts(state: Readonly<AppArtifactsState>, callbacks?: ArtifactsCallbacks): void;
    closeArtifacts(): void;
    areArtifactsOpen(): boolean;
    openPreview(input: Readonly<FilePreviewInput>, callbacks?: FilePreviewCallbacks): FilePreviewSession;
    destroy(): void;
}
export interface FormFeedback {
    error?: string;
    disabled?: boolean;
}
export interface FullAccessState {
    title?: string;
    error?: string;
    disabled?: boolean;
}
export type HostResult = void | ActionResult | Promise<void | ActionResult>;
export interface ImageTarget {
    readonly conversationId: string;
    readonly messageId: string;
    readonly index: number;
}
export interface LoadingSession {
    update(state: Readonly<LoadingState>): void;
    fail(message: string): void;
    isOpen(): boolean;
    close(): void;
    destroy(): void;
}
export interface LoadingState {
    readonly error?: string;
}
export interface LocalContentLink {
    path: string;
    conversationId: string;
}
export interface MCPCallbacks {
    onSubmit?: Submission<MCPConnectionDraft>;
    onConnectionAction?: (action: MCPConnectionAction, target: MCPConnectionTarget) => HostResult;
    onRefresh?: () => HostResult;
    onNew?: () => HostResult;
    onClose?: () => void;
}
export type MCPConnectionAction = 'mcp-login' | 'mcp-logout' | 'mcp-edit' | 'mcp-toggle' | 'mcp-remove';
export interface MCPConnectionDraft {
    name: string;
    type: 'http' | 'stdio';
    url: string;
    oauth: boolean;
    oauthClientId: string;
    oauthScope: string;
    command: string;
    args: string;
    enabled: boolean;
    bearerToken: string;
    clearBearerToken: boolean;
    env: string;
    clearEnv: boolean;
}
export interface MCPConnectionItem {
    name: string;
    type: string;
    url?: string;
    command?: string;
    args?: readonly string[];
    enabled: boolean;
    hasBearerToken?: boolean;
    status?: string;
    statusLabel: string;
    envKeys?: readonly string[];
    error?: string;
    oauth?: boolean;
    signedIn?: boolean;
}
export interface MCPConnectionsState extends FormFeedback {
    formError?: string;
}
export interface MCPConnectionTarget {
    readonly name: string;
}
export interface MCPEditorValue {
    name: string;
    type: string;
    url?: string;
    oauth?: boolean;
    oauthClientId?: string;
    oauthScope?: string;
    command?: string;
    args?: readonly string[];
    enabled?: boolean;
    hasBearerToken?: boolean;
    envKeys?: readonly string[];
}
export interface MCPSession extends SettingsViewSession<MCPConnectionsState> {
    read(): MCPConnectionDraft;
    edit(value?: Readonly<MCPEditorValue>): void;
    setConnections(entries: readonly MCPConnectionItem[]): void;
    clearBearerToken(): void;
    clearSecrets(): void;
}
export interface MessageEditorSession extends SceneSession<MessageEditorState> {
    read(): string;
    reset(value: string): void;
    focus(): void;
}
export interface MessageEditorState {
    readonly title: string;
    readonly value: string;
    readonly description?: string;
    readonly note?: string;
    readonly submitLabel?: string;
    readonly disabled?: boolean;
    readonly pending?: boolean;
    readonly inputDisabled?: boolean;
    readonly error?: string;
}
export interface ModelCallbacks {
    onSubmit?: Submission<ModelSelection>;
    onClose?: () => void;
}
export interface ModelEditorState {
    providers: readonly ModelProviderOption[] | null;
    models: readonly ModelOption[] | null;
    selection: ModelSelection;
    disabled?: boolean;
}
export interface ModelOption {
    id: string;
    name: string;
    provider: string;
    thinkingLevels?: readonly string[] | null;
    supportsImages: boolean;
    contextWindow: number;
    maxTokens: number;
}
export interface ModelPickerState extends FormFeedback {
    editor?: ModelEditorState;
    loading?: boolean;
}
export interface ModelProviderOption {
    id: string;
    name: string;
    model?: string;
    thinkingLevel?: string;
}
export interface ModelSelection {
    provider: string;
    model: string;
    thinkingLevel: string;
}
export interface ModelSession extends SettingsViewSession<ModelPickerState> {
    read(): ModelSelection;
    reset(selection: Readonly<ModelSelection>): void;
    focus(): void;
}
export interface NavigationState {
    readonly groups: readonly ApplicationWorkspace[];
    readonly empty: 'workspaces' | 'search' | null;
    readonly disabled?: boolean;
}
export interface NavigationStatus {
    readonly kind: 'approval' | 'running' | 'unread' | 'idle';
}
export interface PendingMessage {
    id: string;
    text: string;
    mode: string;
    imageCount?: number;
}
export interface PendingMessagesState {
    items: readonly PendingMessage[];
    running: boolean;
    busy: boolean;
}
export interface PermissionControlState {
    mode: string;
    description: string;
    disabled?: boolean;
}
export type ProviderAction = 'login' | 'logout' | 'custom' | 'remove-connection';
export interface ProviderActionsState {
    id: string;
    oauth: boolean;
    signedIn: boolean;
    custom: boolean;
    disabled?: boolean;
}
export interface ProviderActionTarget {
    readonly id: string;
}
export interface ProviderLoginCallbacks {
    onAnswer?: (answer: string) => HostResult;
    onCancel?: () => HostResult;
    onClose?: () => void;
}
export interface ProviderLoginSession extends SettingsViewSession<ProviderLoginState> {
}
export interface ProviderLoginState {
    phase: string;
    message: string;
    url?: string;
    code?: string;
    prompt?: string;
    promptType?: string;
    options?: readonly {
        id: string;
        label: string;
    }[] | null;
    error?: string;
    disabled?: boolean;
}
export interface RenameConversationDraft {
    id: string;
    title: string;
}
export interface RenameConversationState {
    id: string;
    title: string;
    error?: string;
    disabled?: boolean;
}
export type ResourceActionResult = void | ActionResult | Promise<void | ActionResult>;
export interface ResourceDraft {
    name: string;
    content: string;
}
export interface ResourceEditorCallbacks {
    onSubmit?: (draft: ResourceDraft) => ActionResult | Promise<ActionResult>;
    onDelete?: (target: AppResourceTarget) => ResourceActionResult;
    onClose?: () => void;
}
export interface ResourceEditorSession {
    read(): ResourceDraft;
    update(state: Readonly<AppResourceEditorState>): void;
    fail(message: string): void;
    close(): void;
    isOpen(): boolean;
    destroy(): void;
}
export interface ResourcesCallbacks {
    onRefresh?: () => ResourceActionResult;
    onCreate?: (kind: AppResourceKind) => ResourceActionResult;
    onUse?: (target: AppResourceTarget) => ResourceActionResult;
    onEdit?: (target: AppResourceTarget) => ResourceActionResult;
    onFileAction?: (action: 'open' | 'reveal', target: AppResourceTarget) => ResourceActionResult;
    onClose?: () => void;
}
export interface ResourcesScene {
    openEditorLoading(state: Readonly<LoadingState> & {
        readonly kind: AppResourceKind;
        readonly path?: string;
    }, callbacks?: {
        onClose?: () => void;
    }): LoadingSession;
    open(state: Readonly<ResourcesState>, callbacks?: ResourcesCallbacks): ResourcesSession;
    openEditor(state: Readonly<AppResourceEditorState>, callbacks?: ResourceEditorCallbacks): ResourceEditorSession;
    destroy(): void;
}
export interface ResourcesSession {
    read(): Readonly<ResourcesState>;
    update(state: Readonly<ResourcesState>): void;
    fail(message: string): void;
    close(): void;
    isOpen(): boolean;
    destroy(): void;
}
export interface ResourcesState {
    readonly workspace: {
        readonly id: string;
        readonly name: string;
        readonly path: string;
    };
    readonly instructions: readonly AppResourceEntry[];
    readonly skills: readonly AppResourceEntry[];
    readonly templates: readonly AppResourceEntry[];
    readonly diagnostics: readonly string[];
    readonly canCreateInstructions?: boolean;
    readonly loading?: boolean;
    readonly error?: string;
    readonly busy?: boolean;
}
export interface RuntimePanelState {
    visible: boolean;
    summary: string;
    duration: string;
    speed: string;
    provider?: string;
    thinkingLevel?: string;
    inputTokens: string;
    outputTokens: string;
    cacheRead: string;
    cacheWrite: string;
    contextTokens: string;
    contextWindow: string;
    compactions: string;
    toolFailures: string;
    recordedCost: string;
    latestCost: string;
}
export interface SceneSession<State> {
    update(state: Readonly<State>): void;
    close(): void;
    isOpen(): boolean;
    fail(message: string): void;
    destroy(): void;
}
export interface SettingsCallbacks {
    onSubmit?: Submission<SettingsDraft>;
    onRemoveKey?: Submission<SettingsDraft>;
    onTest?: (draft: SettingsDraft) => HostResult;
    onCancelTest?: () => HostResult;
    onAppearanceChange?: (appearance: Appearance) => HostResult;
    onProviderChange?: (provider: string) => HostResult;
    onDraftChange?: (draft: SettingsDraft) => void;
    onProviderAction?: (action: ProviderAction, target: ProviderActionTarget) => HostResult;
    onUpdateAction?: (action: UpdateAction) => HostResult;
    onCreateConnection?: () => HostResult;
    onDiagnostics?: () => HostResult;
    onClose?: () => void;
}
export interface SettingsCredential extends Omit<SettingsCredentialView, 'actions'> {
    providerActions?: Readonly<ProviderActionsState>;
}
export interface SettingsCredentialView {
    status: string;
    hidden: boolean;
    required: boolean;
    placeholder: string;
    removeVisible: boolean;
    hint?: string;
}
export interface SettingsDraft {
    provider: string;
    baseUrl: string;
    apiKey: string;
}
export interface SettingsPanelState extends FormFeedback {
    baseUrl: string;
    hasApiKey: boolean;
    ready?: boolean;
    testing?: boolean;
    appearance?: {
        mode: 'light' | 'dark' | 'system';
        disabled?: boolean;
        error?: string;
    };
    testResult?: {
        message: string;
        ok?: boolean;
    };
}
export interface SettingsProviderOption {
    id: string;
    name: string;
    configured?: boolean;
    signedIn?: boolean;
}
export interface SettingsScene {
    openConnectionLoading(state: Readonly<LoadingState> & {
        readonly editing: boolean;
    }, callbacks?: {
        onClose?: () => void;
    }): LoadingSession;
    openSettings(state: Readonly<SettingsPanelState>, callbacks?: SettingsCallbacks): SettingsSession;
    openConnections(state?: Readonly<MCPConnectionsState>, callbacks?: MCPCallbacks): MCPSession;
    openModels(state: Readonly<ModelPickerState>, callbacks?: ModelCallbacks): ModelSession;
    openCustomConnection(state: Readonly<CustomConnectionState>, callbacks?: CustomConnectionCallbacks): CustomConnectionSession;
    openProviderLogin(state: Readonly<ProviderLoginState>, callbacks?: ProviderLoginCallbacks): ProviderLoginSession;
    destroy(): void;
}
export interface SettingsSession extends SettingsViewSession<SettingsPanelState> {
    read(): SettingsDraft;
    setProviders(providers: readonly SettingsProviderOption[], selected?: string): void;
    resetProvider(value: {
        provider: string;
        baseUrl: string;
        clearKey?: boolean;
        collapseAdvanced?: boolean;
    }): void;
    setCredential(view: Readonly<SettingsCredential>): void;
    updateUpdates(state: Readonly<UpdatePanelState>): void;
    setUpdatePending(pending: boolean): void;
    setUpdateError(message: string, options?: {
        allowCheckRetry?: boolean;
    }): void;
    clearSecrets(): void;
}
/** Session methods address one owned opening, never a later use of its window. */
export interface SettingsViewSession<State> {
    update(state: Readonly<State>): void;
    fail(message: string): void;
    close(): void;
    isOpen(): boolean;
    destroy(): void;
}
export type Submission<Value> = (value: Value) => ActionResult | Promise<ActionResult>;
export interface TaskFailureState {
    visible: boolean;
    message: string;
    advice: string;
    canContinue: boolean;
    workspaceId?: string;
}
export type UpdateAction = 'check' | 'install';
export interface UpdatePanelState {
    version: string;
    enabled: boolean;
    phase: string;
    availableVersion: string;
    progress: number;
    message: string;
}
export interface WelcomeState {
    workspace?: {
        name: string;
        path: string;
    };
    hasApiKey: boolean;
    hasConnections: boolean;
    modelName: string;
}
export type WorkspaceAction = 'workspace' | 'resources' | 'connections' | 'settings' | 'model' | 'compact' | 'continue' | 'diagnostics';
export interface WorkspaceAvailability {
    /** A host mutation blocks actions in every scope. A running task is scoped below. */
    readonly busy?: boolean;
    /** Global actions only; unrelated inactive targets keep their own availability. */
    readonly global?: boolean;
    readonly active?: boolean;
    readonly conversations?: readonly string[];
    readonly workspaces?: readonly string[];
}
export interface WorkspaceCallbacks {
    onAction?(action: WorkspaceAction): HostResult;
    onSubmit?(text: string): HostResult;
    onStop?(): HostResult;
    onInput?(text: string): void;
    onBlur?(): void;
    onImages?(files: File[]): void;
    onThinkingChange?(value: string): void;
    onBusyAction?(key: string): void;
    onSearch?(query: string): void;
    onSelectConversation?(id: string): void;
    onNewConversation?(workspaceId: string): void;
    onConversationAction?(action: ConversationNavigationAction, id: string): HostResult;
    onWorkspaceAction?(action: 'remove', id: string): HostResult;
    onMessageAction?(action: ConversationAction): HostResult;
    onCopyCode?(text: string): HostResult;
    resolveLocalLink?(href: string, conversationId: string): LocalContentLink | null;
    onLocalFile?(target: LocalContentLink): HostResult;
    onLoadImage?(target: ImageTarget): Promise<Blob | null>;
    onQueueAction?(action: 'edit' | 'delete' | 'steer', id: string): void;
    onRemoveAttachment?(id: string): void;
    onDropReferences?(input: {
        readonly paths: readonly string[];
        readonly uris?: string;
        readonly hasUnidentifiedFiles: boolean;
    }): void;
    onPermissionChange?(value: string): void;
    onApproval?(id: string, action: 'deny' | 'always' | 'allow'): void;
    onCompletionOpen?(id: string): void;
    onCompletionDismiss?(runId: string): void;
    onCostsChange?(): void;
    onError?(message: string): void;
}
export interface WorkspacePickerState {
    workspaces: readonly {
        id: string;
        name: string;
        path: string;
    }[];
    error?: string;
    disabled?: boolean;
}
export interface WorkspaceScene {
    updateShell(state: Readonly<WorkspaceShellState>): void;
    updateComposer(state: Readonly<ComposerViewState>): void;
    readDraft(): string;
    resetDraft(text: string): void;
    focusComposer(): void;
    pickImages(): void;
    insertReferences(paths: readonly string[]): void;
    receiveNativeDrop(input: {
        readonly paths: readonly string[];
        readonly x: number;
        readonly y: number;
    }): void;
    setDropPending(pending: boolean): void;
    updateNavigation(state: Readonly<NavigationState>): void;
    search(query: string): void;
    closeNavigationMenu(): void;
    setSidebarOpen(open: boolean): void;
    updateConversation(state: Readonly<ConversationState>): void;
    updateMessageAvailability(state: Readonly<ConversationActionAvailability>): void;
    pruneConversations(ids: readonly string[]): void;
    updateWelcome(state: Readonly<WelcomeState>): void;
    followLatest(): void;
    openFind(): void;
    closeFind(): void;
    updatePending(state: Readonly<PendingMessagesState>): void;
    updateAttachments(state: Readonly<AttachmentsState>): void;
    updateImageGuidance(message: string): void;
    updatePermission(state: Readonly<PermissionControlState>): void;
    updateApproval(state: Readonly<ApprovalPanelState>): void;
    updateFailure(state: Readonly<TaskFailureState>): void;
    updateRuntime(state: Readonly<RuntimePanelState>): void;
    updateTiming(value: {
        summary: string;
        duration: string;
        speed: string;
    }): void;
    updateNotices(state: readonly CompletionNoticeDisplay[]): void;
    updateAvailability(state: Readonly<WorkspaceAvailability>): void;
    readCosts(): {
        readonly open: boolean;
        readonly runtimeOpen: boolean;
    };
    updateCosts(state: {
        readonly visible: boolean;
        readonly report?: CostLedgerState;
        readonly loading?: boolean;
        readonly error?: string;
    }): void;
    resetCosts(): void;
    openMessageEditor(state: MessageEditorState, callbacks?: {
        onSubmit?(text: string): ActionResult | Promise<ActionResult>;
        onInput?(text: string): void;
        onClose?(): void;
    }): MessageEditorSession;
    openQueueEditor(state: MessageEditorState, callbacks?: {
        onSubmit?(text: string): ActionResult | Promise<ActionResult>;
        onInput?(text: string): void;
        onClose?(): void;
    }): MessageEditorSession;
    openConfirmation(state: ConfirmationState, callbacks: {
        onConfirm(): ActionResult | Promise<ActionResult>;
        onClose?(): void;
    }): SceneSession<ConfirmationState>;
    openWorkspacePicker(state: WorkspacePickerState, callbacks?: {
        onSubmit?(path: string): ActionResult | Promise<ActionResult>;
        onPick?(): Promise<{
            path?: string;
            error?: string;
        }>;
        onSelect?(id: string): void;
        onClose?(): void;
    }): SceneSession<WorkspacePickerState> & {
        read(): {
            path: string;
        };
        reset(path?: string): void;
        focus(): void;
    };
    openRename(state: RenameConversationState, callbacks?: {
        onSubmit?(draft: RenameConversationDraft): ActionResult | Promise<ActionResult>;
        onClose?(): void;
    }): SceneSession<RenameConversationState> & {
        read(): RenameConversationDraft;
        reset(state: RenameConversationState): void;
        focus(): void;
    };
    openFullAccess(state: FullAccessState, callbacks: {
        onConfirm(): ActionResult | Promise<ActionResult>;
        onClose?(): void;
    }): SceneSession<FullAccessState>;
    openHistory(state: BranchHistoryState, callbacks?: {
        onContinue?(nodeId: string): HostResult;
        onClose?(): void;
    }): SceneSession<BranchHistoryState>;
    destroy(): void;
}
export interface WorkspaceShellState {
    workspace?: string;
    conversation?: string;
    reconnecting?: boolean;
    error?: {
        message: string;
        hidden?: boolean;
    };
    busy?: {
        key: string;
        message: string;
        actionLabel: string;
    } | null;
}
