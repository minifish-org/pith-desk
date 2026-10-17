/** Desk-local semantic aliases derived from the verified part assemblies.
 * No old package scene, generated DOM or library-private type is imported. */
import type {mountDesk} from './ui-assemblies/desk.js';

export type Application = ReturnType<typeof mountDesk>;
export type ApplicationOptions = NonNullable<Parameters<typeof mountDesk>[1]>;
export type WorkspaceCallbacks = NonNullable<ApplicationOptions['workspace']>;
export type ActionResult = Awaited<ReturnType<Application['downloadFile']>>;

type Workspace = Application['workspace'];
type Settings = Application['settings'];
type Resources = Application['resources'];
type Files = Application['files'];

export type MessageEditorSession = Omit<ReturnType<Workspace['openMessageEditor']>, 'part'|'open'>;
export type ConfirmationState = Parameters<Workspace['openConfirmation']>[0];
export type FullAccessState = Parameters<Workspace['openFullAccess']>[0];
export type RenameConversationState = Parameters<Workspace['openRename']>[0];
export type WorkspacePickerState = Parameters<Workspace['openWorkspacePicker']>[0];
/** Shared business-controller lifecycle, with each controller's own state. */
export type SceneSession<State> = Pick<ReturnType<Workspace['openConfirmation']>, 'isOpen'|'close'|'fail'|'destroy'> & {
  update(state: Readonly<State>): void;
};
export type NavigationStatus = NonNullable<Parameters<Workspace['updateNavigation']>[0]['groups'][number]['children'][number]['status']>;
export type ConversationActionAvailability = Parameters<Workspace['updateMessageAvailability']>[0];
export type ConversationAction = Parameters<NonNullable<WorkspaceCallbacks['onMessageAction']>>[0];
export type WorkspaceAction = Parameters<NonNullable<WorkspaceCallbacks['onAction']>>[0];
export type ImageTarget = Parameters<NonNullable<WorkspaceCallbacks['onLoadImage']>>[0];

export type SettingsSession = Omit<ReturnType<Settings['openSettings']>, 'part'|'open'>;
export type SettingsPanelState = Parameters<SettingsSession['update']>[0];
export type SettingsDraft = ReturnType<SettingsSession['read']>;
export type SettingsCallbacks = NonNullable<Parameters<Settings['openSettings']>[1]>;
export type ProviderActionsState = NonNullable<Parameters<SettingsSession['setCredential']>[0]['providerActions']>;
export type ProviderAction = Parameters<NonNullable<SettingsCallbacks['onProviderAction']>>[0];
export type ProviderActionTarget = Parameters<NonNullable<SettingsCallbacks['onProviderAction']>>[1];
export type UpdateAction = Parameters<NonNullable<SettingsCallbacks['onUpdateAction']>>[0];
export type MCPSession = Omit<ReturnType<Settings['openConnections']>, 'part'|'open'>;
export type MCPConnectionsState = Parameters<MCPSession['update']>[0];
export type MCPConnectionDraft = ReturnType<MCPSession['read']>;
export type MCPCallbacks = NonNullable<Parameters<Settings['openConnections']>[1]>;
export type MCPConnectionAction = Parameters<NonNullable<MCPCallbacks['onConnectionAction']>>[0];
export type MCPConnectionTarget = Parameters<NonNullable<MCPCallbacks['onConnectionAction']>>[1];
export type ModelSession = Omit<ReturnType<Settings['openModels']>, 'part'|'open'>;
export type ModelPickerState = Parameters<ModelSession['update']>[0];
export type CustomConnectionState = Parameters<Settings['openCustomConnection']>[0];
export type CustomConnectionSession = Omit<ReturnType<Settings['openCustomConnection']>, 'part'|'open'>;
export type LoadingSession = Omit<ReturnType<Settings['openConnectionLoading']>, 'part'|'open'>;
export type ProviderLoginSession = Omit<ReturnType<Settings['openProviderLogin']>, 'part'|'open'>;

export type FilePreviewSession = Omit<ReturnType<Files['openPreview']>, 'part'|'open'>;
export type AppFilePreviewState = Parameters<FilePreviewSession['update']>[0];
type FileCallbacks = NonNullable<Parameters<Files['openPreview']>[1]>;
export type AppFileAction = Parameters<NonNullable<FileCallbacks['onFileAction']>>[0];
export type AppFileTarget = Parameters<NonNullable<FileCallbacks['onFileAction']>>[1];
export type ResourcesSession = Omit<ReturnType<Resources['open']>, 'part'|'open'>;
export type ResourcesState = Parameters<ResourcesSession['update']>[0];
type ResourceCallbacks = NonNullable<Parameters<Resources['open']>[1]>;
export type AppResourceTarget = Parameters<NonNullable<ResourceCallbacks['onUse']>>[0];
export type AppResourceKind = AppResourceTarget['kind'];
export type ResourceDraft = ReturnType<ReturnType<Resources['openEditor']>['read']>;

// These are application data helpers, never npm component/scene exports.
export {thinkingLabel} from './ui-assemblies/model-picker.ts';
export {customModelDefaults} from './ui-assemblies/custom-connection.ts';
export {formatCost} from './ui-assemblies/cost-ledger.ts';
