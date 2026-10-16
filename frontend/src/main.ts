import { createWorkspaceShell, setAppearance, type WorkspaceDialogName } from 'pith-ui';
import { createApp,readAppBootstrap } from './app';
import { installAppLifecycle } from './app-lifecycle';
import type { State } from './app-state';
import { createCompletionUI } from './completion';
import { createComposer } from './composer';
import { createConfirmation } from './confirmation';
import { createConversationsUI } from './conversations';
import { createCostUI } from './costs';
import type { UIActivity } from './feature-api';
import { createFilesUI } from './files';
import { installImageViewer } from './image-viewer';
import { createMessagesUI } from './messages';
import { createMessageEditor } from './message-editor';
import { createMutations } from './mutations';
import { installNativeMenu } from './native-menu';
import { createSDKUI } from './sdk-features';
import { createSettingsUI } from './settings';
import './style.css';
import { createTaskControls } from './task-controls';
import { escape,icon } from './ui';
import { installWorkspaceFileDrop } from './workspace-files';

import type { MutationInput,MutationPath,MutationResponse } from './api';
import type { AppearanceMode,Conversation,RunSummary } from './contract.generated';
export type { ProviderChoice } from './contract.generated';

function anyRunning(): boolean { return app.state.runs.length > 0; }
function conversationRunning(id: string | null): boolean { return app.state.runs.some((run) => run.conversationId === id); }
function workspaceRun(id?: string): RunSummary | undefined {
 const workspace = app.state.workspaces.find((entry) => entry.id === id);
 if (!workspace) return;
 const contains = (a: string, b: string) => a === b || b.startsWith(a.replace(/\/$/, '') + '/');
 return app.state.runs.find((run) => {
  const other = app.state.workspaces.find((entry) => entry.id === run.workspaceId);
  return other && (contains(workspace.path, other.path) || contains(other.path, workspace.path));
 });
}

const { token, nativeClipboard, nativeFileDrop, nativeMenus } = readAppBootstrap(document);

const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
const appearanceMode = (value: unknown): AppearanceMode => value === 'light' || value === 'dark' ? value : 'system';
const initialAppearance = appearanceMode(document.documentElement.dataset.appearance);

function applyAppearance(mode: AppearanceMode): void {
  setAppearance(document.documentElement, mode);
  document.documentElement.dataset.appearance = mode;
  document.documentElement.dataset.theme = mode === 'system' ? (systemAppearance.matches ? 'dark' : 'light') : mode;
}

applyAppearance(initialAppearance);

const app = createApp({
  token, origin: window.location.href, appearance: initialAppearance,
  onSnapshot: snapshotChanged,
  onConnection: (status) => { if (status === 'connected' && !app.loaded) activity.error = ''; render(); },
  onError: (message) => { activity.error = message; render(); },
});
const { request, download, refresh } = app;
const activity: UIActivity = { busy: false, error: '' };
let nativeMenu: ReturnType<typeof installNativeMenu> | undefined;

let disposed = false;

const logo = '<span class="pui-logo-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

const brand = document.createElement('span');
brand.innerHTML = logo + '<span>Pith<span class="pui-brand-light"> Desk</span></span>';
brand.style.display = 'contents';
const workspaceShell: ReturnType<typeof createWorkspaceShell> = createWorkspaceShell({ brand, prefix: '',
  composer: {
    onSubmit: () => send(),
    onStop: async () => { if (app.state.running && !activity.busy) await mutate('/api/abort', { id: app.state.activeId }); },
    onInput: () => { rememberDraft(); render(); },
    onModel: () => { void openModelPicker(); },
    onAttach: () => { if (!activity.busy && !composer.readingImages) workspaceShell.composer.pickImages(); },
    onImages: (files) => { void addImageFiles(files); },
    onThinkingChange: (thinkingLevel) => { if (anyRunning() || activity.busy) { render(); return; } void mutate('/api/model-selection', { provider: app.state.settings.provider, model: app.state.settings.model, thinkingLevel }); },
  },
  onSearch: (query) => conversations.search(query),
  onBusyAction: async (id) => { if (await mutate('/api/open', { id })) acknowledgeViewedCompletion(); render(); closeSidebar(); },
  onDialogClose: (name) => {
    if (name === 'permissions') tasks.closePermissions();
    if (name === 'preview') clearFilePreview();
    acknowledgeViewedCompletion();
    if (name === 'queue-edit') composer.closeQueueEditor();
    if (name === 'message-edit') messageEditor.close();
    if (name === 'settings') settings.closeSettings();
    if (name === 'connections') settings.closeConnections();
    if (name === 'resources') files.closeResources();
  },
});
$('app').replaceChildren(workspaceShell.element);


const input = $<HTMLTextAreaElement>('composer-input');
const imageViewer = installImageViewer($<HTMLDialogElement>('image-dialog'), { triggerRoot: document.body });
const costUI = createCostUI({ state: () => app.state, request });
const completionUI = createCompletionUI({ state: () => app.state, request, confirmRead: app.confirmRead, renderHistory: () => conversations.renderHistory(), escape, icon });
const historyStatus = (entry: Conversation) => completionUI.historyStatus(entry);
const updateCompletions = (initialized: boolean) => completionUI.observe(initialized);
const acknowledgeViewedCompletion = () => completionUI.acknowledgeViewed();
const dismissCompletion = (runID: string) => completionUI.dismiss(runID);
const mutations = createMutations({ request, refresh, busy: () => activity.busy, setBusy: (value) => { activity.busy = value; }, error: (message) => { activity.error = message; }, render });
const confirmRemoval = createConfirmation($<HTMLDialogElement>('delete-dialog'));
const sdkUI = createSDKUI({
  confirm: confirmRemoval, state: () => app.state, request, mutate, error: () => activity.error,
  busy: () => activity.busy || composer.draftLoading || !app.loaded,
  workspaceBusy: (id) => !!workspaceRun(id), settings: () => settings.openSettings(),
  refreshProviderAuth: (provider) => settings.refreshProviderAuth(provider),
  draft: (text) => { input.value = text + input.value; rememberDraft(); resizeComposer(); input.focus(); render(); },
  refreshResources: () => files.loadResources(), refreshMCP: () => settings.loadMCP(),
}, () => acknowledgeViewedCompletion());

const messages = createMessagesUI({ view: app, download, logo, disposed: () => disposed,
  messageActionAvailability: () => ({ edit: activity.busy || app.state.running, branch: activity.busy || app.state.running || !app.state.activeId }),
  onMessageAction: async (action, button) => {
    const message = app.state.messages.find(entry => entry.id === action.messageId);
    if (!message) return;
    if (action.action === 'copy' && (message.role === 'assistant' || message.role === 'user') && message.text && message.status !== 'streaming') await files.copyWithFeedback(button, () => files.copyText(message.text), message.role === 'user' ? 'Message copied.' : 'Response copied.');
    if (action.action === 'edit' && message.role === 'user') messageEditor.open(message);
    if (action.action === 'branch' && action.branchKey && message.role === 'assistant' && action.branchKey === message.branchNodeId && await mutate('/api/branch', { id: app.state.activeId, nodeId: action.branchKey })) { rememberDraft(); resizeComposer(); input.focus(); render(); }
  },
  onCopyCode: (text, button) => { void files.copyWithFeedback(button, () => files.copyText(text), 'Code copied.'); },
  onWelcomeAction: action => { if (action === 'model') void settings.openModelPicker(); else if (action === 'settings') settings.openSettings(); else conversations.openWorkspace(); },
  onPrompt: text => { if (composer.draftLoading) return; input.value = text; rememberDraft(); resizeComposer(); render(); input.focus(); },
});
const tasks = createTaskControls({ view: app, activity, request, download, mutate, render, selectedWorkspace: () => conversations.selectedWorkspace(), renderCosts: () => costUI.render(), showDialog });
const { clearHistoryImages } = messages;
const messageEditor = createMessageEditor({ view: app, activity, mutate, showDialog, followLatest: () => messages.followLatest() });
const { renderRuntime, exportDiagnostics, renderApproval, renderPermissions } = tasks;
const composer = createComposer({ view: app, activity, input, request, mutate, refresh, render, selectedWorkspace: () => conversations.selectedWorkspace(), openWorkspace: () => conversations.openWorkspace(), openSettings: () => settings.openSettings(), showDialog, followLatest: () => messages.followLatest(), disposed: () => disposed, resizeInput: () => workspaceShell.composer.resize() });
const files = createFilesUI({ view: app, activity, request, download, render, selectedWorkspace: () => conversations.selectedWorkspace(), openWorkspace: () => conversations.openWorkspace(), conversationRunning, workspaceBusy: (id) => !!workspaceRun(id), showDialog, nativeClipboard, editResource: (...args) => sdkUI.resource(...args) });
const settings = createSettingsUI({ view: app, activity, request, mutate, render, closeSidebar, showDialog, anyRunning, appearanceMode, applyAppearance, providerActions: (provider) => sdkUI.providerActions(provider) });
const conversations = createConversationsUI({ view: app, activity, input, request, download, mutate, render, closeSidebar, workspaceRun, conversationRunning, historyStatus, confirmRemoval, removeWorkspaceResources: (id) => files.removeWorkspace(id), clearHistoryImages, loadComposerDraft: () => composer.loadComposerDraft(), resizeComposer: () => composer.resizeComposer() });
const { rememberDraft, loadComposerDraft, renderQueue, openQueueEditor, send, renderDraftImages, clearDraftImages, addImageFiles, resizeComposer } = composer;
const { downloadConversationFile, copyText, copyWithFeedback, setArtifactsOpen, renderArtifacts, clearFilePreview, openArtifactPreview, loadArtifacts, openResources, loadResources } = files;
const { renderAppearance, openConnections, loadMCP, editMCP, thinkingLabel, openModelPicker, openSettings } = settings;
const { selectedWorkspace, renderHistory, closeConversationMenu, openConversationMenu, openWorkspaceMenu, openDeletion, newConversation, openRename, exportConversation, openWorkspace } = conversations;
const drafts = composer.drafts;

function render(): void {
  if (disposed) return;
  confirmRemoval.render();
  renderAppearance();
  const workspace = selectedWorkspace();
  if (workspace) conversations.selectedWorkspaceId = workspace.id;
  const activeConversation = app.state.conversations.find((entry) => entry.id === app.state.activeId);
  const levels = app.state.settings.thinkingLevels || ['off'];
  renderPermissions();
  renderHistory();
  const menuConversation = app.state.conversations.find((entry) => entry.id === conversations.menuConversationId);
  const menuWorkspace = app.state.workspaces.find((entry) => entry.id === conversations.menuWorkspaceId);
  if ((!menuConversation && !menuWorkspace) || activity.busy) closeConversationMenu();

  messages.renderMessages(workspace);
  messageEditor.render();

  renderApproval();
  renderArtifacts();
  files.renderResourceAvailability();
  renderQueue();
  renderRuntime();
  sdkUI.render();
  renderDraftImages();
  const blocked = !app.state.running && workspaceRun(workspace?.id);
  const error = activity.error || app.state.error || '';
  workspaceShell.update({ workspace: workspace?.name ?? 'No workspace', conversation: activeConversation?.title || 'New conversation', reconnecting: app.connection === 'reconnecting',
    busy: blocked ? { key: blocked.conversationId, message: 'A task is running in this workspace or an overlapping folder.', actionLabel: 'Open running conversation' } : null,
    error: { message: error, hidden: !activity.error && !!app.state.failure },
  });
  const hasDraft = !!input.value.trim() || composer.draftImages.length > 0;
  const stopping = app.state.running && !hasDraft;
  workspaceShell.composer.update({ action: stopping ? 'stop' : app.state.running ? 'queue' : 'send',
    readOnly: composer.draftLoading,
    actionDisabled: stopping ? activity.busy : !app.loaded || activity.busy || composer.draftLoading || composer.readingImages || composer.resolvingReferences || !hasDraft || (!!composer.draftImages.length && !app.state.settings.supportsImages) || !workspace || !app.state.settings.hasApiKey || (!app.state.running && !!workspaceRun(workspace?.id)),
    placeholder: !app.loaded ? 'Connecting to Pith…' : !app.state.settings.hasApiKey ? app.state.settings.hasConnections ? 'Choose a model beside the message box' : 'Connect a provider in Settings to get started' : !workspace ? 'Choose a workspace to get started' : app.state.running ? 'Send a message to queue it…' : workspaceRun(workspace?.id) ? 'Another task is running in this workspace. Open its conversation to queue a message.' : 'Ask Pith to help with your work…',
    model: { label: app.state.settings.modelName || app.state.settings.model || 'Choose model', description: `${app.state.settings.provider || 'deepseek'} / ${app.state.settings.model}`, disabled: activity.busy || anyRunning() },
    thinking: { options: levels.map(level => ({ value: level, label: thinkingLabel(level) })), value: app.state.settings.thinkingLevel || 'off', disabled: anyRunning() || activity.busy || levels.length < 2 },
  });
  workspaceShell.updateActionAvailability(scope => activity.busy || (scope.kind === 'global' ? anyRunning() : scope.kind === 'conversation' ? conversationRunning(scope.id || null) : scope.kind === 'workspace' ? !!workspaceRun(scope.id) : app.state.running), document.body);
  nativeMenu?.update();
}

function snapshotChanged(next: State, previous: State, initialized: boolean): void {
  const shouldLoadArtifacts = !next.running && (!initialized || next.activeId !== previous.activeId || previous.running);
  const activeChanged = next.activeId !== previous.activeId;
  const runFinished = previous.runs.length > 0 && !next.runs.length;
  if (activeChanged) { imageViewer.close(); activity.error = ''; clearHistoryImages(); files.activeChanged(); }
  loadComposerDraft();
  updateCompletions(initialized);
  render();
  if (shouldLoadArtifacts && next.activeId) void loadArtifacts(next.activeId);
  if (runFinished && $<HTMLDialogElement>('connections-dialog').open) void loadMCP();
}

function mutate<P extends MutationPath>(path: P, payload: MutationInput<P>, onResponse?: (response: MutationResponse<P>) => void): Promise<boolean> {
  return mutations(path, payload, onResponse);
}

function showDialog(id: string): void {
  workspaceShell.openDialog(id.replace(/-dialog$/, '') as WorkspaceDialogName);
}

function closeSidebar(): void { workspaceShell.setSidebarOpen(false); }
input.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
  if (files.length) { event.preventDefault(); void addImageFiles(files); }
});
const removeFileDrop = installWorkspaceFileDrop({
  form: $('composer-form'), input, native: nativeFileDrop,
  busy: () => activity.busy || composer.draftLoading || !app.loaded,
  context: () => `${selectedWorkspace()?.id}/${app.state.activeId}/${composer.draftGeneration}`,
  workspaceID: () => selectedWorkspace()?.id,
  disposed: () => disposed,
  resolve: async (workspaceId, paths) => (await request('/api/workspace-references', { workspaceId, paths })).paths || [],
  images: addImageFiles,
  pending: (pending) => { composer.resolvingReferences = pending; render(); },
  changed: () => { activity.error = ''; rememberDraft(); resizeComposer(); render(); },
  error: (message) => { activity.error = message; render(); },
});
nativeMenu = installNativeMenu({
  native: nativeMenus,
  context: () => ({ ready: app.loaded, busy: activity.busy || composer.draftLoading || composer.readingImages || composer.resolvingReferences, workspaceId: selectedWorkspace()?.id, activeId: app.state.activeId }),
  request,
  canExport: () => !!app.state.conversations.find((entry) => entry.id === app.state.activeId) && !conversationRunning(app.state.activeId),
  actions: { newConversation, chooseWorkspace: openWorkspace, exportConversation, settings: () => settings.openSettings(), checkUpdates: () => settings.checkUpdates() },
  error: (message) => { activity.error = message; render(); },
});

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button, a[data-download-path]');
  if (!target) return;
  if (target.dataset.downloadPath && target.dataset.downloadConversation) {
    event.preventDefault();
    await downloadConversationFile(target.dataset.downloadConversation, target.dataset.downloadPath);
    return;
  }
  if (target.hasAttribute('data-copy-code') && !(target as HTMLButtonElement).disabled) {
    const code = target.closest('.pui-code-block')?.querySelector('pre > code');
    if (code) await copyWithFeedback(target as HTMLButtonElement, () => copyText(code.textContent || ''), 'Code copied.');
    return;
  }
  if (target.dataset.dismissCompletion) {
    dismissCompletion(target.dataset.dismissCompletion);
    return;
  }
  if (target.dataset.queueAction && target.dataset.queuedMessage) {
    if (activity.busy || !app.state.activeId) return;
    const entry = app.state.queuedMessages.find((message) => message.id === target.dataset.queuedMessage);
    if (!entry) return;
    if (target.dataset.queueAction === 'edit') openQueueEditor(entry);
    else if (target.dataset.queueAction === 'delete' || target.dataset.queueAction === 'steer') await mutate(`/api/queue/${target.dataset.queueAction}`, { id: app.state.activeId, messageId: entry.id });
    return;
  }
  if (target.dataset.conversationMenu) { openConversationMenu(target.dataset.conversationMenu, target); return; }
  if (target.dataset.workspaceMenu) { openWorkspaceMenu(target.dataset.workspaceMenu, target); return; }
  if (target.dataset.newWorkspace) { await newConversation(target.dataset.newWorkspace); return; }
  if (target.dataset.removeImage) { if (!activity.busy && !composer.readingImages) { clearDraftImages(new Set([target.dataset.removeImage])); rememberDraft(); render(); } return; }
  if (target.dataset.close) return;
  if (target.dataset.previewPath && target.dataset.previewId) { await openArtifactPreview(target.dataset.previewId, target.dataset.previewPath); return; }
  if (target.dataset.fileKind && target.dataset.filePath && target.dataset.fileOwner) {
    if (activity.busy || (target.dataset.fileKind === 'resource' ? workspaceRun(target.dataset.fileOwner) : conversationRunning(target.dataset.fileOwner))) return;
    const kind = target.dataset.fileKind;
    const payload = { kind, ...(kind === 'resource' ? { workspaceId: target.dataset.fileOwner } : { id: target.dataset.fileOwner }), path: target.dataset.filePath, action: target.dataset.fileAction || '' };
    if (kind === 'artifact' && ['copy', 'copy-path'].includes(payload.action || '')) {
      if ((target as HTMLButtonElement).disabled) return;
      await copyWithFeedback(target as HTMLButtonElement, () => payload.action === 'copy' ? request('/api/file', payload).then(() => {}) : copyText(payload.path), payload.action === 'copy' ? 'File copied.' : 'Path copied.');
      return;
    }
    if (!await mutate('/api/file', payload) && kind === 'resource') files.setResourceError(activity.error);
    return;
  }
  if (target.dataset.mcpEdit) { const entry = settings.mcpConnections.find((item) => item.name === target.dataset.mcpEdit); if (entry) editMCP(entry); return; }
  if (target.dataset.mcpToggle || target.dataset.mcpRemove) {
    if (activity.busy || anyRunning()) return;
    const entry = settings.mcpConnections.find((item) => item.name === (target.dataset.mcpToggle || target.dataset.mcpRemove));
    if (!entry) return;
    settings.setMCPError('');
    const save = async () => {
      const ok = target.dataset.mcpRemove ? await mutate('/api/mcp/remove', { name: entry.name }) : await mutate('/api/mcp/save', { name: entry.name, type: entry.type, oauth: entry.oauth, url: entry.url, command: entry.command, args: entry.args || [], enabled: !entry.enabled });
      if (ok) { await loadMCP(); if (target.dataset.mcpRemove && settings.isEditingMCP(entry.name)) editMCP(); }
      else settings.setMCPError(activity.error);
      return ok;
    };
    if (target.dataset.mcpRemove) confirmRemoval({ title: 'Delete connection?', action: 'Delete connection', description: `Remove <strong>${escape(entry.name)}</strong> and its saved credentials from Pith Desk?`, hint: 'Workspace files and existing conversations stay on your computer.', scope: { global: true }, unavailable: () => activity.busy || anyRunning(), run: save, error: () => activity.error });
    else await save();
    return;
  }
  if (target.dataset.conversation) {
    if (await mutate('/api/open', { id: target.dataset.conversation })) {
      acknowledgeViewedCompletion();
    }
    render(); closeSidebar(); return;
  }
  if (target.dataset.workspace) {
    const id = target.dataset.workspace;
    conversations.selectedWorkspaceId = id;
    const conversation = app.state.conversations.filter((entry) => entry.workspaceId === id).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    if (conversation) await mutate('/api/open', { id: conversation.id });
    else await newConversation(id);
    closeSidebar(); return;
  }
  if (target.dataset.approval && app.state.pendingApproval) {
    const approval = app.state.pendingApproval;
    if (target.dataset.approvalId !== approval.id) {
      activity.error = 'This tool request has changed. Review the current request before allowing it.';
      render();
      return;
    }
    const alwaysAllow = target.dataset.approval === 'always';
    if (alwaysAllow && approval.toolName !== 'write_file' && approval.toolName !== 'edit_file') return;
    await mutate('/api/approval', { id: approval.id, allow: target.dataset.approval !== 'deny', ...(alwaysAllow ? { alwaysAllow: true } : {}) });
    return;
  }
  switch (target.dataset.action) {
    case 'close-conversation-menu': closeConversationMenu(); break;
    case 'settings': openSettings(); break;
    case 'model': await openModelPicker(); break;
    case 'continue': if (!app.state.running && app.state.activeId && app.state.failure?.canContinue) await mutate('/api/continue', { id: app.state.activeId }); break;
    case 'attach-images': if (!activity.busy && !composer.readingImages) $<HTMLInputElement>('image-picker').click(); break;
    case 'diagnostics': await exportDiagnostics(); break;
    case 'workspace': openWorkspace(); break;
    case 'resources': openResources(); break;
    case 'connections': openConnections(); break;
    case 'rename': { const id = conversations.menuConversationId; closeConversationMenu(); if (id) openRename(id); break; }
    case 'delete-conversation': { const id = conversations.menuConversationId; closeConversationMenu(); if (id) openDeletion('conversation', id); break; }
    case 'remove-workspace': { const id = conversations.menuWorkspaceId; closeConversationMenu(); if (id) openDeletion('workspace', id); break; }
    case 'export': { const id = conversations.menuConversationId; closeConversationMenu(true); if (id) await exportConversation(id); break; }
    case 'refresh-resources': await loadResources(); break;
    case 'create-instructions':
      if (workspaceRun(files.resourcesWorkspaceId) || activity.busy) break;
      if (await mutate('/api/create-instructions', { workspaceId: files.resourcesWorkspaceId })) await loadResources();
      else files.setResourceError(activity.error);
      break;
    case 'refresh-mcp': await loadMCP(); break;
    case 'new-mcp': editMCP(); break;
    case 'toggle-env': settings.toggleMCPEnvironment(); break;
  }
});

input.addEventListener('blur', () => { rememberDraft(); void drafts.flush(composer.composerScope).catch(() => {}); });

const runtimeClock = window.setInterval(() => {
  tasks.tick();
}, 1000);
function saveDraftsOnLeave(): void { rememberDraft(); void drafts.flushAll({ keepalive: true }); }
const removeLifecycle = installAppLifecycle({
  acknowledge: acknowledgeViewedCompletion,
  saveOnLeave: saveDraftsOnLeave,
  flushDrafts: async () => {
    rememberDraft();
    input.readOnly = true;
    const results = await drafts.flushAll();
    const saved = results.every((result) => result.status === 'fulfilled');
    if (!saved) input.readOnly = composer.draftLoading;
    return saved;
  },
  dispose: () => {
    disposed = true;
    app.dispose();
    removeLifecycle();
    nativeMenu?.dispose();
    removeFileDrop();
    window.clearInterval(runtimeClock);
    clearDraftImages();
    clearHistoryImages();
    messages.destroy();
    imageViewer.destroy();
    composer.destroy();
    files.destroy();
    completionUI.destroy();
    costUI.destroy();
    messageEditor.destroy();
    confirmRemoval.destroy();
    conversations.destroy();
    settings.destroy();
    tasks.destroy();
    sdkUI.destroy();
    workspaceShell.destroy();
  },
});
systemAppearance.addEventListener('change', () => {
  if (appearanceMode(app.state.settings.appearance) === 'system') applyAppearance('system');
});
render();
void app.start();
