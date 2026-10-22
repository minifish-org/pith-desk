import type { ActionResult, ConversationAction, MCPConnectionAction, MCPConnectionTarget, WorkspaceAction } from './ui-contract.ts';
import './style.css';
import {createApp} from './app';
import {readAppBootstrap} from './ui-bootstrap';
import {createServerSession} from './server-session';
import {createDraftRecovery} from './draft-recovery';
import {mountApplication} from './ui-mount';
import {installNativeDrop, isForeground} from './ui-native';
import {installAppLifecycle} from './app-lifecycle';
import type {State} from './app-state';
import {createCompletionUI} from './completion';
import {createComposer} from './composer';
import {createConfirmation} from './confirmation';
import {createConversationsUI} from './conversations';
import {createCostUI} from './costs';
import type {UIActivity} from './feature-api';
import {createFilesUI} from './files';
import {createMessagesUI} from './messages';
import {createMessageEditor} from './message-editor';
import {createMutations} from './mutations';
import {installNativeMenu} from './native-menu';
import {createSDKUI} from './sdk-features';
import {createSettingsUI} from './settings';
import {createTaskControls} from './task-controls';
import {installWorkspaceFileDrop} from './workspace-files';
import {createWorkspaceToolsController} from './workspace-tools';
import {localFilePath} from './local-file-links';
import type {MutationInput, MutationPath, MutationResponse} from './api';
import type {AppearanceMode, RunSummary} from './contract.generated';
export type {ProviderChoice} from './contract.generated';

const {token, server, nativeBrowser, nativeClipboard, nativeFileDrop, nativeMenus, titlebar, appearance} = readAppBootstrap();
const recovery = server ? createDraftRecovery() : undefined;
const recoveredText = recovery?.text();
const session = server ? createServerSession({recoveryText: () => recovery?.text() || ''}) : undefined;
const appearanceMode = (value: unknown): AppearanceMode => value === 'light' || value === 'dark' ? value : 'system';
const activity: UIActivity = {busy: false, error: ''};
let disposed = false, suspended = false, ready = false, flushingDrafts = false;
let sidebarSave: Promise<unknown> = Promise.resolve();
let nativeMenu: ReturnType<typeof installNativeMenu> | undefined;
const app = createApp({
  token, session, origin: window.location.href, appearance: appearanceMode(appearance), onSnapshot: snapshotChanged,
  onConnection(status) {if (status === 'connected' && !app.loaded) activity.error = ''; render();},
  onError(message) {activity.error = message; render();},
});
const {request, download, refresh} = app;
const ui = mountApplication({
  titlebar, server, async onLogout() {
    try {
      if (!await flushDrafts()) throw new Error('Drafts could not be saved. Try logging out again.');
      await session?.logout();
    } finally {flushingDrafts = false; render();}
  },
  brand: {name: 'Pith', qualifier: 'Desk', mark: {symbol: 'pith', alt: ''}},
  appearance: appearanceMode(appearance), host: {copyText: text => files.copyText(text)},
  onUIStateChange() {if (ready && !disposed) {nativeMenu?.update(); completionUI.acknowledgeViewed();}},
  onError(message) {activity.error = message; render();},
  tools: {onSelect: id => toolTabs.select(id),onNew: kind => toolTabs.create(kind),onClose: id => {void toolTabs.close(id);}},
  workspace: {
    onError(message) {activity.error = message; render();},
    onAction: workspaceAction,
    onSubmit: () => composer.send(),
    onStop: async () => {if (app.state.running && !activity.busy) await mutate('/api/abort', {id: app.state.activeId});},
    onInput() {composer.rememberDraft(); render();},
    onBlur() {composer.rememberDraft(); void composer.drafts.flush(composer.composerScope).catch(() => {});},
    onImages: images => {void composer.addImageFiles(images);},
    onThinkingChange(thinkingLevel) {
      if (anyRunning() || activity.busy) {render(); return;}
      void mutate('/api/model-selection', {provider: app.state.settings.provider, model: app.state.settings.model, thinkingLevel});
    },
    onBusyAction: id => selectConversation(id),
    onSelectConversation: id => {void selectConversation(id);},
    onNewConversation: id => {void conversations.newConversation(id);},
    onConversationAction(action, id) {
      if (action === 'rename') conversations.openRename(id);
      else if (action === 'export') return conversations.exportConversation(id);
      else if (action === 'delete') conversations.openDeletion('conversation', id);
      else if (id === app.state.activeId && !conversationRunning(id)) return sdkUI.history();
    },
    onWorkspaceAction: (_action, id) => conversations.openDeletion('workspace', id),
    onMessageAction: messageAction,
    onCopyCode: text => files.copyText(text),
    resolveLocalLink(href, conversationId) {const path = localFilePath(href); return path ? {conversationId, path} : null;},
    onLocalFile: target => files.downloadConversationFile(target.conversationId, target.path),
    onLoadImage: target => messages.loadImage(target),
    onQueueAction: (action, id) => {void queueAction(action, id);},
    onRemoveAttachment(id) {
      if (!activity.busy && !composer.readingImages) {composer.clearDraftImages(new Set([id])); composer.rememberDraft(); render();}
    },
    onDropReferences: input => fileDrop.references(input),
    onPermissionChange: value => {void tasks.changePermission(value);},
    onApproval: (id, action) => {void approve(id, action);},
    onCompletionOpen: id => {void selectConversation(id);},
    onCompletionDismiss: id => completionUI.dismiss(id),
    onCostsChange: () => costUI.render(),
    onToolsToggle() {if (ready) toolTabs.sync();},
    onSidebarResize(widths) {
      if (!ready || !app.loaded || disposed || suspended) return;
      // Serialize committed preferences; pointer moves never write snapshots.
      // Retired pages neither save queued changes nor replay failed writes.
      sidebarSave=sidebarSave.then(async()=>{if (!disposed && !suspended) await request('/api/sidebar-widths',widths,{keepalive:true});}).catch(error=>{if (!disposed && !suspended) {activity.error=String(error);render();}});
    },
  },
});
const mutations = createMutations({request, refresh, busy: () => activity.busy, setBusy: value => {activity.busy = value;}, error: message => {activity.error = message;}, render});
const confirmRemoval = createConfirmation(ui);
const costUI = createCostUI({ui, state: () => app.state, request});
const completionUI = createCompletionUI({ui, state: () => app.state, request, confirmRead: app.confirmRead, renderHistory: () => conversations.renderHistory(), foreground: isForeground});
const sdkUI = createSDKUI({ui, confirm: confirmRemoval, state: () => app.state, request, mutate, error: () => activity.error,
  busy: () => activity.busy || composer.draftLoading || !app.loaded,
  workspaceBusy: id => !!workspaceRun(id), settings: () => settings.openSettings(),
  refreshProviderAuth: provider => settings.refreshProviderAuth(provider), draft: prependDraft,
  refreshResources: () => files.loadResources(), refreshMCP: () => settings.loadMCP(),
}, () => completionUI.acknowledgeViewed());
const messages = createMessagesUI({ui, view: app, download, disposed: () => disposed,
  messageActionAvailability: () => ({edit: activity.busy || app.state.running, branch: activity.busy || app.state.running || !app.state.activeId}),
});
const tasks = createTaskControls({ui, view: app, activity, request, download, mutate, render, selectedWorkspace: () => conversations.selectedWorkspace(), renderCosts: () => costUI.render()});
const messageEditor = createMessageEditor({ui, view: app, activity, mutate, followLatest: () => messages.followLatest()});
const composer = createComposer({ui, view: app, activity, request, mutate, refresh, render,
  selectedWorkspace: () => conversations.selectedWorkspace(), openWorkspace: () => conversations.openWorkspace(), openSettings: () => settings.openSettings(), followLatest: () => messages.followLatest(), disposed: () => disposed || suspended, recovery,
});
const files = createFilesUI({ui, view: app, activity, request, mutate, download, render, draft: prependDraft,
  selectedWorkspace: () => conversations.selectedWorkspace(), openWorkspace: () => conversations.openWorkspace(), conversationRunning, workspaceBusy: id => !!workspaceRun(id), nativeClipboard, server, editResource: (...args) => sdkUI.resource(...args),
});
const settings = createSettingsUI({ui, view: app, activity, request, mutate, render, closeSidebar, anyRunning, appearanceMode,
  applyAppearance: mode => ui.setAppearance(mode), server, providerActions: provider => sdkUI.providerActions(provider),
  providerAction: (action, target) => sdkUI.providerAction(action, target), mcpAction,
  custom: id => sdkUI.custom(id), diagnostics: () => tasks.exportDiagnostics(),
});
const conversations = createConversationsUI({ui, view: app, activity, request, download, mutate, render, closeSidebar, workspaceRun, conversationRunning,
  historyStatus: entry => completionUI.historyStatus(entry), confirmRemoval, removeWorkspaceResources: id => files.removeWorkspace(id), clearHistoryImages: () => messages.clearHistoryImages(), loadComposerDraft: () => composer.loadComposerDraft(),
});
const toolTabs = createWorkspaceToolsController({ui,request,workspace: () => conversations.selectedWorkspace(),workspaces: () => app.state.workspaces ?? [],
  disabled: () => suspended || !app.loaded,filesDisabled: () => suspended || activity.busy || !app.loaded,referenceDisabled: () => composer.draftLoading || composer.readingImages || composer.resolvingReferences || flushingDrafts,
  server,nativeBrowser,native: nativeClipboard,clearPreview: files.clearFilePreview,fileAction: files.workspaceAction,
  changedDraft() {composer.rememberDraft();render();},
  copy: files.copyText,
  protocols: () => session?.protocols() ?? ['pith-desk',`bearer.${token}`],checkAccess: () => session?.check() ?? Promise.resolve(),
});
const fileDrop = installWorkspaceFileDrop({ui, native: nativeFileDrop, server,
  busy: () => activity.busy || composer.draftLoading || !app.loaded,
  context: () => `${conversations.selectedWorkspace()?.id}/${app.state.activeId}/${composer.draftGeneration}`,
  workspaceID: () => conversations.selectedWorkspace()?.id, disposed: () => disposed,
  resolve: async (workspaceId, paths) => (await request('/api/workspace-references', {workspaceId, paths})).paths || [],
  pending(pending) {composer.resolvingReferences = pending; render();},
  changed() {activity.error = ''; composer.rememberDraft(); render();},
  error(message) {activity.error = message; render();},
});
const removeNativeDrop = installNativeDrop(nativeFileDrop, drop => ui.workspace.receiveNativeDrop(drop));

function anyRunning(): boolean {return app.state.runs.length > 0;}
function conversationRunning(id: string | null): boolean {return app.state.runs.some(run => run.conversationId === id);}
function workspaceRun(id?: string): RunSummary | undefined {
  const workspace = app.state.workspaces.find(entry => entry.id === id);
  if (!workspace) return;
  const contains = (a: string, b: string) => a === b || b.startsWith(a.replace(/\/$/, '') + '/');
  return app.state.runs.find(run => {
    const other = app.state.workspaces.find(entry => entry.id === run.workspaceId);
    return other && (contains(workspace.path, other.path) || contains(other.path, workspace.path));
  });
}
function mutate<P extends MutationPath>(path: P, payload: MutationInput<P>, onResponse?: (response: MutationResponse<P>) => void): Promise<boolean> {return mutations(path, payload, onResponse);}
function closeSidebar(): void {ui.workspace.closeNavigationOverlay();}
function prependDraft(text: string): void {
  ui.workspace.resetDraft(text + ui.workspace.readDraft()); composer.rememberDraft(); ui.workspace.focusComposer(); render();
}
async function selectConversation(id: string): Promise<void> {
  if (await mutate('/api/open', {id})) completionUI.acknowledgeViewed();
  render(); closeSidebar();
}
async function messageAction(action: ConversationAction): Promise<void> {
  const message = app.state.messages.find(entry => entry.id === action.messageId);
  if (!message) return;
  if (action.action === 'copy' && (message.role === 'assistant' || message.role === 'user') && message.text && message.status !== 'streaming') await files.copyText(message.text);
  if (action.action === 'edit' && message.role === 'user') messageEditor.open(message);
  if (action.action === 'branch' && action.branchKey && message.role === 'assistant' && action.branchKey === message.branchNodeId && await mutate('/api/branch', {id: app.state.activeId, nodeId: action.branchKey})) {
    composer.rememberDraft(); ui.workspace.focusComposer(); render();
  }
}
async function queueAction(action: 'edit' | 'delete' | 'steer', id: string): Promise<void> {
  if (activity.busy || !app.state.activeId) return;
  const entry = app.state.queuedMessages.find(message => message.id === id);
  if (!entry) return;
  if (action === 'edit') composer.openQueueEditor(entry);
  else await mutate(`/api/queue/${action}`, {id: app.state.activeId, messageId: entry.id});
}
async function approve(id: string, action: 'deny' | 'always' | 'allow'): Promise<void> {
  const approval = app.state.pendingApproval;
  if (!approval) return;
  if (id !== approval.id) {activity.error = 'This tool request has changed. Review the current request before allowing it.'; render(); return;}
  const alwaysAllow = action === 'always';
  if (alwaysAllow && approval.toolName !== 'write_file' && approval.toolName !== 'edit_file') return;
  await mutate('/api/approval', {id, allow: action !== 'deny', ...(alwaysAllow ? {alwaysAllow: true} : {})});
}
async function workspaceAction(action: WorkspaceAction): Promise<void | ActionResult> {
  if (action === 'settings') settings.openSettings();
  else if (action === 'model') await settings.openModelPicker();
  else if (action === 'workspace') conversations.openWorkspace();
  else if (action === 'resources') files.openResources();
  else if (action === 'connections') settings.openConnections();
  else if (action === 'diagnostics') await tasks.exportDiagnostics();
  else if (action === 'compact') return sdkUI.compact();
  else if (!app.state.running && app.state.activeId && app.state.failure?.canContinue) await mutate('/api/continue', {id: app.state.activeId});
}
async function mcpAction(action: MCPConnectionAction, target: MCPConnectionTarget): Promise<void | ActionResult> {
  if (activity.busy || anyRunning()) return;
  const entry = settings.mcpConnections.find(item => item.name === target.name);
  if (!entry) return;
  if (action === 'mcp-edit') {settings.editMCP(entry); return;}
  if (action === 'mcp-login' || action === 'mcp-logout') return sdkUI.mcpAuth(action, entry.name);
  settings.setMCPError('');
  const remove = action === 'mcp-remove';
  const save = async () => {
    const ok = remove ? await mutate('/api/mcp/remove', {name: entry.name}) : await mutate('/api/mcp/save', {name: entry.name, type: entry.type, oauth: entry.oauth, url: entry.url, command: entry.command, args: entry.args || [], enabled: !entry.enabled});
    if (ok) {await settings.loadMCP(); if (remove && settings.isEditingMCP(entry.name)) settings.editMCP();}
    else settings.setMCPError(activity.error);
    return ok;
  };
  if (remove) confirmRemoval({title: 'Delete connection?', action: 'Delete connection', description: {before: 'Remove ', subject: entry.name, after: ' and its saved credentials from Pith Desk?'}, hint: server ? 'Workspace files and existing conversations stay on the server.' : 'Workspace files and existing conversations stay on your computer.', scope: {global: true}, unavailable: () => activity.busy || anyRunning(), run: save, error: () => activity.error});
  else await save();
}

function render(): void {
  if (!ready || disposed) return;
  confirmRemoval.render(); settings.renderAppearance();
  const workspace = conversations.selectedWorkspace();
  if (workspace) conversations.selectedWorkspaceId = workspace.id;
  toolTabs.sync();
  const active = app.state.conversations.find(entry => entry.id === app.state.activeId), levels = app.state.settings.thinkingLevels || ['off'];
  tasks.renderPermissions(); conversations.renderHistory(); messages.renderMessages(workspace); messageEditor.render();
  tasks.renderApproval(); files.renderArtifacts(); files.renderResourceAvailability(); composer.renderQueue(); tasks.renderRuntime(); sdkUI.render(); composer.renderDraftImages();
  const blocked = !app.state.running && workspaceRun(workspace?.id), error = activity.error || app.state.error || '';
  ui.workspace.updateShell({workspace: workspace?.name ?? 'No workspace', conversation: active?.title || 'New conversation', reconnecting: app.connection === 'reconnecting', busy: blocked ? {key: blocked.conversationId, message: 'A task is running in this workspace or an overlapping folder.', actionLabel: 'Open running conversation'} : null, error: {message: error, hidden: !activity.error && !!app.state.failure}});
  const hasDraft = !!ui.workspace.readDraft().trim() || composer.draftImages.length > 0, stopping = app.state.running && !hasDraft;
  ui.workspace.updateComposer({action: stopping ? 'stop' : app.state.running ? 'queue' : 'send', readOnly: suspended || composer.draftLoading || flushingDrafts,
    actionDisabled: suspended || (stopping ? activity.busy : !app.loaded || activity.busy || composer.draftLoading || composer.readingImages || composer.resolvingReferences || !hasDraft || (!!composer.draftImages.length && !app.state.settings.supportsImages) || !workspace || !app.state.settings.hasApiKey || (!app.state.running && !!workspaceRun(workspace?.id))),
    placeholder: !app.loaded ? 'Connecting to Pith…' : !app.state.settings.hasApiKey ? app.state.settings.hasConnections ? 'Choose a model beside the message box' : 'Connect a provider in Settings to get started' : !workspace ? 'Choose a workspace to get started' : app.state.running ? 'Send a message to queue it…' : workspaceRun(workspace?.id) ? 'Another task is running in this workspace. Open its conversation to queue a message.' : 'Ask Pith to help with your work…',
    model: {label: app.state.settings.modelName || app.state.settings.model || 'Choose model', description: `${app.state.settings.provider || 'deepseek'} / ${app.state.settings.model}`, disabled: activity.busy || anyRunning()},
    thinking: {options: levels.map(level => ({value: level, label: settings.thinkingLabel(level)})), value: app.state.settings.thinkingLevel || 'off', disabled: anyRunning() || activity.busy || levels.length < 2},
  });
  ui.workspace.updateAvailability({busy: suspended || activity.busy, global: anyRunning(), active: app.state.running,
    conversations: app.state.conversations.filter(entry => activity.busy || conversationRunning(entry.id)).map(entry => entry.id),
    workspaces: app.state.workspaces.filter(entry => activity.busy || workspaceRun(entry.id)).map(entry => entry.id),
  });
  nativeMenu?.update();
}
function snapshotChanged(next: State, previous: State, initialized: boolean): void {
  if (!initialized) ui.layout.setSidebarWidths({navigation:next.settings.navigationWidth || undefined,tools:next.settings.toolsWidth || undefined});
  const shouldLoadArtifacts = !next.running && (!initialized || next.activeId !== previous.activeId || previous.running);
  const activeChanged = next.activeId !== previous.activeId, runFinished = previous.runs.length > 0 && !next.runs.length;
  if (activeChanged) {activity.error = ''; messages.clearHistoryImages(); files.activeChanged();}
  composer.loadComposerDraft(); completionUI.observe(initialized); render();
  if (shouldLoadArtifacts && next.activeId) void files.loadArtifacts(next.activeId);
  if (runFinished && settings.isConnectionsOpen()) void settings.loadMCP();
}
nativeMenu = installNativeMenu({native: nativeMenus,
  context: () => ({ready: app.loaded, busy: activity.busy || composer.draftLoading || composer.readingImages || composer.resolvingReferences, modal: ui.read().hasModal, workspaceId: conversations.selectedWorkspace()?.id, activeId: app.state.activeId}), request,
  canExport: () => !!app.state.conversations.find(entry => entry.id === app.state.activeId) && !conversationRunning(app.state.activeId),
  actions: {newConversation: () => conversations.newConversation(), chooseWorkspace: () => conversations.openWorkspace(), exportConversation: () => conversations.exportConversation(), settings: () => settings.openSettings(), checkUpdates: () => settings.checkUpdates()},
  error(message) {activity.error = message; render();},
});
const runtimeClock = window.setInterval(() => tasks.tick(), 1000);
function preserveText(): void {
  composer.rememberDraft();
  recovery?.keepText('Unassigned message', !composer.composerScope.id && !composer.composerScope.workspaceId ? ui.workspace.readDraft() : '');
  recovery?.keepText('Message edit', messageEditor.unsentText());
  recovery?.keepText('Pending message edit', composer.unsentQueueEdit());
}
function saveDraftsOnLeave(): void {if (!suspended) {preserveText(); void composer.drafts.flushAll({keepalive: true});}}
function retireControllers(): void {
  nativeMenu?.dispose(); removeNativeDrop(); fileDrop.destroy(); window.clearInterval(runtimeClock);
  toolTabs.destroy();messages.destroy(); composer.destroy(); files.destroy(); completionUI.destroy(); costUI.destroy(); messageEditor.destroy(); confirmRemoval.destroy(); conversations.destroy(); settings.destroy(); tasks.destroy(); sdkUI.destroy();
}
function suspend(): void {
  if (disposed || suspended) return;
  preserveText(); suspended = true; app.dispose();
  retireControllers(); render();
}
async function flushDrafts(): Promise<boolean> {
  composer.rememberDraft(); flushingDrafts = true; render();
  await sidebarSave;
  const results = await composer.drafts.flushAll(), saved = results.every(result => result.status === 'fulfilled');
  if (!saved) {flushingDrafts = false; render();}
  return saved;
}
const removeLifecycle = installAppLifecycle({acknowledge: () => completionUI.acknowledgeViewed(), saveOnLeave: saveDraftsOnLeave, flushDrafts,
  dispose() {
    if (disposed) return;
    disposed = true; app.dispose(); session?.dispose(); removeLifecycle();
    retireControllers(); composer.clearDraftImages(); ui.destroy();
  },
});
ready = true; render();
if (session) void session.start(ui, () => {void app.start().then(async () => {
  if (!recoveredText || !recovery) return;
  const text = await recovery.recover(scope => request('/api/draft', {query: scope}));
  if (!disposed && !suspended && text) ui.openRecoveredDrafts(text, () => recovery.discard());
});}, suspend);
else void app.start();
