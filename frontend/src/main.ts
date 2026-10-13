import { createApp,readAppBootstrap } from './app';
import { installAppLifecycle } from './app-lifecycle';
import type { State } from './app-state';
import { createCompletionUI } from './completion';
import { createComposer } from './composer';
import { createConfirmation } from './confirmation';
import { controlDisabled } from './controls';
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
import type { AppearanceMode,Conversation,PermissionMode,RunSummary } from './contract.generated';
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

const logo = '<span class="logo-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

$('app').innerHTML = `
  <aside class="sidebar" id="sidebar">
    <div class="brand">${logo}<span>Pith<span class="brand-light"> Desk</span></span></div>
    <div class="sidebar-section-label">WORKSPACES <button class="quiet-icon" data-action="workspace" aria-label="Manage workspaces">${icon('plus')}</button></div>
    <label class="history-search">${icon('search')}<span class="sr-only">Search conversation titles</span><input id="history-search" type="search" placeholder="Search conversations" autocomplete="off" /></label>
    <nav id="history-list" class="history-list" aria-label="Workspaces and conversations"></nav>
    <div class="sidebar-bottom">
      <button class="settings-button" data-action="resources">${icon('file')}<span>Workspace resources</span></button>
      <button class="settings-button" data-action="connections">${icon('plug')}<span>Connections</span></button>
      <button class="settings-button" data-action="settings">${icon('settings')}<span>Settings</span></button>
      <div id="connection-status" class="local-status" role="status" hidden><span class="status-dot reconnecting" aria-hidden="true"></span><span>Reconnecting…</span></div>
    </div>
  </aside>
  <div id="conversation-menu" class="sidebar-conversation-menu" role="menu" hidden></div>
  <div class="sidebar-scrim" id="sidebar-scrim"></div>
  <main class="main">
    <header class="topbar">
      <button class="quiet-icon mobile-menu" data-action="menu" aria-label="Open sidebar">${icon('menu')}</button>
      <div class="breadcrumb">${icon('folder')}<span id="workspace-label">No workspace</span>${icon('chevron', 'breadcrumb-chevron')}<span class="breadcrumb-current" id="conversation-label">New conversation</span></div>
      <div class="conversation-actions"><button class="quiet-icon compact-action" data-sdk="compact" data-sdk-idle title="Compress context by summarizing older messages" aria-label="Compress context">${icon('compress')}<span>Compact</span></button><div id="artifacts-control" class="artifacts-control" hidden><button id="artifacts-toggle" type="button" class="quiet-icon artifacts-toggle" aria-label="Conversation files" title="Conversation files" aria-expanded="false" aria-controls="artifacts">${icon('file')}<span id="artifacts-count" class="artifacts-count" aria-hidden="true"></span></button><section id="artifacts" class="artifacts-panel" aria-labelledby="artifacts-title" tabindex="-1" hidden></section></div></div>
    </header>
    <section id="conversation-find" class="conversation-find" aria-label="Find in conversation" hidden>
      <input type="search" aria-label="Find in this conversation" placeholder="Find in this conversation" autocomplete="off" />
      <span data-find-count role="status" aria-live="polite"></span>
      <button type="button" class="quiet-icon find-previous" data-find-previous aria-label="Previous match" title="Previous match (Shift+Enter)">${icon('down')}</button>
      <button type="button" class="quiet-icon" data-find-next aria-label="Next match" title="Next match (Enter)">${icon('down')}</button>
      <button type="button" class="quiet-icon" data-find-close aria-label="Close search" title="Close (Esc)">${icon('close')}</button>
    </section>
    <div class="conversation-region"><section id="chat-scroll" class="chat-scroll" aria-label="Conversation" tabindex="-1">
      <div id="welcome" class="welcome"></div>
      <div id="messages" class="messages" aria-live="polite" aria-relevant="additions text"></div>
    </section><button id="back-to-latest" type="button" class="secondary-button back-to-latest" hidden>${icon('down')}<span>Back to latest</span></button></div>
    <div class="composer-region">
      <div class="composer-panels">
      <div id="approval" class="approval-region"></div>
      <div id="workspace-busy" class="workspace-busy" hidden></div><div id="inline-error" class="inline-error" role="alert" hidden></div>
      <section id="task-failure" class="task-failure" role="status" hidden></section>
      <details id="run-status" class="run-status" hidden><summary id="run-status-summary"></summary><div id="run-status-details"><div id="runtime-values"></div><details id="cost-requests" class="cost-requests" hidden><summary>Request breakdown</summary><div id="cost-ledger"></div></details></div></details>
      <section id="queued-messages" class="queued-messages" aria-label="Pending messages" aria-live="polite" hidden></section>
      </div>
      <form id="composer-form" class="composer">
        <div id="draft-images" class="draft-images" aria-label="Image attachments" hidden></div>
        <input id="image-picker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
        <textarea id="composer-input" rows="1" placeholder="Ask Pith to help with your work…" aria-label="Message Pith"></textarea>
        <div class="composer-toolbar">
          <div class="composer-context">
            <button id="attach-images" type="button" class="quiet-icon attach-images" data-action="attach-images" aria-label="Attach images" title="Attach images">${icon('image')}</button>
            <label class="permission-control" id="permission-control">${icon('shield')}<span class="sr-only">Conversation permissions</span><select id="permission-mode" aria-describedby="permission-description"><option value="ask">Ask before changes</option><option value="workspace-write">Allow workspace changes</option><option value="full-access">Full access</option></select>${icon('down')}</label>
          </div>
          <div class="composer-actions"><button id="composer-model" type="button" class="composer-model" data-action="model" data-idle-action data-global-idle aria-label="Choose model">Choose model</button><label class="composer-thinking"><span class="sr-only">Thinking effort</span><select id="composer-thinking" aria-label="Thinking effort"></select></label><button id="send-button" class="send-button" type="submit" aria-label="Send message">${icon('arrow')}</button></div>
        </div>
      </form>
      <p id="image-guidance" class="composer-note image-guidance" hidden></p>
      <p class="composer-note" id="permission-description">Pith can read workspace files. Changes and commands require your approval.</p>
    </div>
  </main>
  <section id="completion-notices" class="completion-notices" aria-label="Completed tasks" aria-live="polite"></section>
  <span id="copy-status" class="sr-only" role="status" aria-live="polite"></span>
  <dialog id="model-dialog" class="modal model-modal" aria-labelledby="model-title"><div id="model-content"></div></dialog>
  <dialog id="settings-dialog" class="modal" aria-labelledby="settings-title"><div id="settings-content"></div></dialog>
  <dialog id="workspace-dialog" class="modal" aria-labelledby="workspace-title"><div id="workspace-content"></div></dialog>
  <dialog id="permissions-dialog" class="modal permission-modal" aria-labelledby="full-access-title"><div id="permissions-content"></div></dialog>
  <dialog id="delete-dialog" class="modal" aria-labelledby="delete-title"><div id="delete-content"></div></dialog>
  <dialog id="rename-dialog" class="modal" aria-labelledby="rename-title"><div id="rename-content"></div></dialog>
  <dialog id="queue-edit-dialog" class="modal" aria-labelledby="queue-edit-title"><div id="queue-edit-content"></div></dialog>
  <dialog id="message-edit-dialog" class="modal" aria-labelledby="message-edit-title"><div id="message-edit-content"></div></dialog>
  <dialog id="resources-dialog" class="modal feature-modal" aria-labelledby="resources-title"><div id="resources-content"></div></dialog>
  <dialog id="connections-dialog" class="modal feature-modal" aria-labelledby="connections-title"><div id="connections-content"></div></dialog>
  <dialog id="preview-dialog" class="modal file-preview-modal" aria-labelledby="preview-title"><div id="preview-content"></div></dialog>
  <dialog id="image-dialog" class="modal image-viewer" aria-labelledby="image-viewer-title">
    <div class="modal-heading"><h2 id="image-viewer-title">Image</h2><button type="button" class="quiet-icon" data-image-close aria-label="Close image">${icon('close')}</button></div>
    <div class="image-viewer-viewport"><img alt="" /></div>
    <div class="image-viewer-toolbar"><span data-image-scale role="status"></span><div><button type="button" class="secondary-button" data-image-out aria-label="Zoom out">−</button><button type="button" class="secondary-button" data-image-in aria-label="Zoom in">+</button><button type="button" class="secondary-button" data-image-fit>Fit</button><button type="button" class="secondary-button" data-image-original>Original size</button></div></div>
  </dialog>
`;

const input = $<HTMLTextAreaElement>('composer-input');
const imageViewer = installImageViewer($<HTMLDialogElement>('image-dialog'));
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
});

const messages = createMessagesUI({ view: app, download, logo, disposed: () => disposed });
const tasks = createTaskControls({ view: app, activity, request, download, mutate, render, selectedWorkspace: () => conversations.selectedWorkspace(), renderCosts: () => costUI.render() });
const { clearHistoryImages } = messages;
const messageEditor = createMessageEditor({ view: app, activity, mutate, showDialog, followLatest: () => messages.followLatest() });
const { activePermissionMode, renderRuntime, exportDiagnostics, renderApproval, renderPermissions, confirmFullAccess } = tasks;
const composer = createComposer({ view: app, activity, input, request, mutate, refresh, render, selectedWorkspace: () => conversations.selectedWorkspace(), openWorkspace: () => conversations.openWorkspace(), openSettings: () => settings.openSettings(), showDialog, followLatest: () => messages.followLatest(), disposed: () => disposed });
const files = createFilesUI({ view: app, activity, request, download, render, selectedWorkspace: () => conversations.selectedWorkspace(), openWorkspace: () => conversations.openWorkspace(), conversationRunning, showDialog, nativeClipboard, resourceActions: (...args) => sdkUI.resourceActions(...args) });
const settings = createSettingsUI({ view: app, activity, request, mutate, render, closeSidebar, showDialog, anyRunning, appearanceMode, applyAppearance, providerActions: (provider) => sdkUI.providerActions(provider) });
const conversations = createConversationsUI({ view: app, activity, input, request, download, mutate, render, closeSidebar, showDialog, workspaceRun, conversationRunning, historyStatus, confirmRemoval, removeWorkspaceResources: (id) => files.removeWorkspace(id), clearHistoryImages, loadComposerDraft: () => composer.loadComposerDraft(), resizeComposer: () => composer.resizeComposer() });
const { rememberDraft, loadComposerDraft, renderQueue, openQueueEditor, send, renderDraftImages, clearDraftImages, addImageFiles, resizeComposer } = composer;
const { downloadConversationFile, copyText, copyWithFeedback, setArtifactsOpen, renderArtifacts, clearFilePreview, openArtifactPreview, loadArtifacts, openResources, loadResources } = files;
const { renderAppearance, openConnections, loadMCP, editMCP, thinkingLabel, openModelPicker, openSettings } = settings;
const { selectedWorkspace, renderHistory, closeConversationMenu, openConversationMenu, openWorkspaceMenu, openDeletion, newConversation, openRename, exportConversation, openWorkspace } = conversations;
const drafts = composer.drafts;

function render(): void {
  renderAppearance();
  const workspace = selectedWorkspace();
  if (workspace) conversations.selectedWorkspaceId = workspace.id;
  const activeConversation = app.state.conversations.find((entry) => entry.id === app.state.activeId);
  $('workspace-label').textContent = workspace?.name ?? 'No workspace';
  $('conversation-label').textContent = activeConversation?.title || 'New conversation';
  $('composer-model').textContent = app.state.settings.modelName || app.state.settings.model || 'Choose model';
  $('composer-model').title = `${app.state.settings.provider || 'deepseek'} / ${app.state.settings.model}`;
  const effort = $<HTMLSelectElement>('composer-thinking');
  const levels = app.state.settings.thinkingLevels || ['off'];
  effort.innerHTML = levels.map((level) => `<option value="${escape(level)}">${escape(thinkingLabel(level))}</option>`).join('');
  effort.value = app.state.settings.thinkingLevel || 'off';
  effort.disabled = anyRunning() || activity.busy || levels.length < 2;
  effort.parentElement!.hidden = levels.length < 2;
  renderPermissions();
  renderHistory();
  const menuConversation = app.state.conversations.find((entry) => entry.id === conversations.menuConversationId);
  const menuWorkspace = app.state.workspaces.find((entry) => entry.id === conversations.menuWorkspaceId);
  if ((!menuConversation && !menuWorkspace) || activity.busy) closeConversationMenu();

  messages.renderMessages(workspace);
  messageEditor.render();

  renderApproval();
  renderArtifacts();
  renderQueue();
  renderRuntime();
  sdkUI.render();
  renderDraftImages();
  const blocked = !app.state.running && workspaceRun(workspace?.id);
  const busyNotice = $('workspace-busy');
  busyNotice.hidden = !blocked;
  if (blocked && busyNotice.dataset.conversation !== blocked.conversationId) {
    busyNotice.dataset.conversation = blocked.conversationId;
    busyNotice.innerHTML = `<span>A task is running in this workspace or an overlapping folder.</span><button class="text-button" type="button" data-conversation="${escape(blocked.conversationId)}">Open running conversation</button>`;
  }
  const error = activity.error || app.state.error || '';
  $('inline-error').hidden = !error || (!activity.error && !!app.state.failure);
  $('inline-error').textContent = error;
  $('connection-status').hidden = app.connection !== 'reconnecting';
  const hasDraft = !!input.value.trim() || composer.draftImages.length > 0;
  const stopping = app.state.running && !hasDraft;
  const sendButton = $<HTMLButtonElement>('send-button');
  const buttonType = stopping ? 'button' : 'submit';
  if (sendButton.type !== buttonType) sendButton.innerHTML = icon(stopping ? 'stop' : 'arrow');
  sendButton.type = buttonType;
  sendButton.classList.toggle('is-stop', stopping);
  if (stopping) sendButton.dataset.action = 'stop'; else delete sendButton.dataset.action;
  sendButton.disabled = stopping ? activity.busy : !app.loaded || activity.busy || composer.draftLoading || composer.readingImages || composer.resolvingReferences || !hasDraft || (!!composer.draftImages.length && !app.state.settings.supportsImages) || !workspace || !app.state.settings.hasApiKey || (!app.state.running && !!workspaceRun(workspace?.id));
  const buttonLabel = stopping ? 'Stop agent' : app.state.running ? 'Queue message' : 'Send message';
  sendButton.setAttribute('aria-label', buttonLabel);
  sendButton.title = buttonLabel;
  input.placeholder = !app.loaded ? 'Connecting to Pith…' : !app.state.settings.hasApiKey ? app.state.settings.hasConnections ? 'Choose a model beside the message box' : 'Connect a provider in Settings to get started' : !workspace ? 'Choose a workspace to get started' : app.state.running ? 'Send a message to queue it…' : workspaceRun(workspace?.id) ? 'Another task is running in this workspace. Open its conversation to queue a message.' : 'Ask Pith to help with your work…';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-idle-action]')) {
    const conversationId = button.dataset.idleConversation;
    const workspaceId = button.dataset.idleWorkspace;
    button.disabled = controlDisabled(button, activity.busy || (button.hasAttribute('data-global-idle') ? anyRunning() : conversationId ? conversationRunning(conversationId) : workspaceId ? !!workspaceRun(workspaceId) : app.state.running));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-global-idle]')) button.disabled = controlDisabled(button, activity.busy || anyRunning());
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mcp-edit], [data-action="new-mcp"]')) button.disabled = controlDisabled(button, activity.busy || anyRunning());
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-download-conversation]')) {
    link.setAttribute('aria-disabled', String(activity.busy || conversationRunning(link.dataset.downloadConversation!)));
  }
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
  closeSidebar();
  const dialog = $<HTMLDialogElement>(id);
  if (!dialog.open) dialog.showModal();
}

$<HTMLSelectElement>('composer-thinking').addEventListener('change', async (event) => {
  if (anyRunning() || activity.busy) { render(); return; }
  const thinkingLevel = (event.currentTarget as HTMLSelectElement).value;
  await mutate('/api/model-selection', { provider: app.state.settings.provider, model: app.state.settings.model, thinkingLevel });
});

function closeSidebar(): void { $('sidebar').classList.remove('open'); $('sidebar-scrim').classList.remove('visible'); }

$('image-picker').addEventListener('change', (event) => {
  const picker = event.currentTarget as HTMLInputElement;
  const files = Array.from(picker.files || []);
  picker.value = '';
  void addImageFiles(files);
});
input.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.items || []).filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
  if (files.length) { event.preventDefault(); void addImageFiles(files); }
});
installWorkspaceFileDrop({
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
  const clicked = event.target as HTMLElement;
  if (files.artifactsOpen && !clicked.closest('#artifacts-control, #preview-dialog, #image-dialog')) setArtifactsOpen(false);
  if (clicked instanceof HTMLImageElement && clicked.matches('.history-image, .draft-image img, .file-preview-image')) { imageViewer.open(clicked); return; }
  if (!clicked.closest('#conversation-menu, [data-conversation-menu], [data-workspace-menu]')) closeConversationMenu();
  const target = (event.target as HTMLElement).closest<HTMLElement>('button, a[data-download-path]');
  if (!target) return;
  if (target.dataset.downloadPath && target.dataset.downloadConversation) {
    event.preventDefault();
    await downloadConversationFile(target.dataset.downloadConversation, target.dataset.downloadPath);
    return;
  }
  if (target.id === 'artifacts-toggle') { setArtifactsOpen(!files.artifactsOpen); return; }
  if (target.hasAttribute('data-artifacts-close')) { setArtifactsOpen(false, true); return; }
  if (target.hasAttribute('data-copy-code') && !(target as HTMLButtonElement).disabled) {
    const code = target.closest('.code-block')?.querySelector('pre > code');
    if (code) await copyWithFeedback(target as HTMLButtonElement, () => copyText(code.textContent || ''), 'Code copied.');
    return;
  }
  if (target.dataset.copyMessage) {
    const message = app.state.messages.find((entry) => entry.id === target.dataset.copyMessage && (entry.role === 'assistant' || entry.role === 'user'));
    if (message?.text && message.status !== 'streaming' && !(target as HTMLButtonElement).disabled) {
      await copyWithFeedback(target as HTMLButtonElement, () => copyText(message.text), message.role === 'user' ? 'Message copied.' : 'Response copied.');
    }
    return;
  }
  if (target.dataset.dismissCompletion) {
    dismissCompletion(target.dataset.dismissCompletion);
    return;
  }
  if (target.dataset.editMessage) {
    const message = app.state.messages.find(entry => entry.id === target.dataset.editMessage && entry.role === 'user');
    if (message && !(target as HTMLButtonElement).disabled) messageEditor.open(message);
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
  if (target.dataset.toggleWorkspace) {
    const id = target.dataset.toggleWorkspace;
    conversations.toggleWorkspace(id);
    document.querySelector<HTMLElement>(`[aria-controls="workspace-children-${CSS.escape(id)}"]`)?.focus();
    return;
  }
  if (target.dataset.newWorkspace) { await newConversation(target.dataset.newWorkspace); return; }
  if (target.dataset.removeImage) { if (!activity.busy && !composer.readingImages) { clearDraftImages(new Set([target.dataset.removeImage])); rememberDraft(); render(); } return; }
  if (target.dataset.close) { $<HTMLDialogElement>(target.dataset.close).close(); return; }
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
    if (!await mutate('/api/file', payload) && kind === 'resource') $('resources-error').textContent = activity.error;
    return;
  }
  if (target.dataset.mcpEdit) { const entry = settings.mcpConnections.find((item) => item.name === target.dataset.mcpEdit); if (entry) editMCP(entry); return; }
  if (target.dataset.mcpToggle || target.dataset.mcpRemove) {
    if (activity.busy || anyRunning()) return;
    const entry = settings.mcpConnections.find((item) => item.name === (target.dataset.mcpToggle || target.dataset.mcpRemove));
    if (!entry) return;
    $('mcp-error').textContent = '';
    const save = async () => {
      const ok = target.dataset.mcpRemove ? await mutate('/api/mcp/remove', { name: entry.name }) : await mutate('/api/mcp/save', { name: entry.name, type: entry.type, oauth: entry.oauth, url: entry.url, command: entry.command, args: entry.args || [], enabled: !entry.enabled });
      if (ok) { await loadMCP(); if (target.dataset.mcpRemove && $<HTMLInputElement>('mcp-name').value === entry.name) editMCP(); }
      else $('mcp-error').textContent = activity.error;
      return ok;
    };
    if (target.dataset.mcpRemove) confirmRemoval({ title: 'Delete connection?', action: 'Delete connection', description: `Remove <strong>${escape(entry.name)}</strong> and its saved credentials from Pith Desk?`, hint: 'Workspace files and existing conversations stay on your computer.', scope: { global: true }, unavailable: () => activity.busy || anyRunning(), run: save, error: () => activity.error });
    else await save();
    return;
  }
  if (target.dataset.prompt) { if (composer.draftLoading) return; input.value = target.dataset.prompt; rememberDraft(); resizeComposer(); render(); input.focus(); return; }
  if (target.dataset.conversation) {
    if (await mutate('/api/open', { id: target.dataset.conversation })) {
      acknowledgeViewedCompletion();
    }
    render(); closeSidebar(); return;
  }
  if (target.dataset.workspace || target.dataset.modalWorkspace) {
    const id = target.dataset.workspace || target.dataset.modalWorkspace!;
    conversations.selectedWorkspaceId = id;
    if (target.dataset.modalWorkspace) $<HTMLDialogElement>('workspace-dialog').close();
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
      else $('resources-error').textContent = activity.error;
      break;
    case 'refresh-mcp': await loadMCP(); break;
    case 'new-mcp': editMCP(); break;
    case 'toggle-env': {
      const revealed = $<HTMLTextAreaElement>('mcp-env').classList.toggle('revealed');
      $('mcp-env-visibility').setAttribute('aria-pressed', String(revealed));
      $('mcp-env-visibility').textContent = revealed ? 'Hide' : 'Show';
      break;
    }
    case 'stop': if (app.state.running && !activity.busy) await mutate('/api/abort', { id: app.state.activeId }); break;
    case 'menu': $('sidebar').classList.add('open'); $('sidebar-scrim').classList.add('visible'); break;
  }
});

$('sidebar-scrim').addEventListener('click', closeSidebar);
$<HTMLInputElement>('history-search').addEventListener('input', (event) => { conversations.search((event.currentTarget as HTMLInputElement).value); });
$('composer-form').addEventListener('submit', (event) => { event.preventDefault(); void send(); });
input.addEventListener('input', () => { rememberDraft(); resizeComposer(); render(); });
input.addEventListener('blur', () => { rememberDraft(); void drafts.flush(composer.composerScope).catch(() => {}); });
$<HTMLSelectElement>('permission-mode').addEventListener('change', async (event) => {
  const mode = (event.currentTarget as HTMLSelectElement).value as PermissionMode;
  const id = app.state.activeId;
  renderPermissions();
  if (!id || activity.busy || mode === activePermissionMode()) return;
  if (mode === 'full-access') confirmFullAccess(id);
  else await mutate('/api/permissions', { id, mode });
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
});
document.addEventListener('focusin', (event) => {
  const target = event.target as HTMLElement;
  if (files.artifactsOpen && !target.closest('#artifacts-control, #preview-dialog, #image-dialog')) setArtifactsOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && files.artifactsOpen && !document.querySelector('dialog[open]')) {
    event.preventDefault(); setArtifactsOpen(false, true); return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLImageElement && event.target.matches('.history-image, .draft-image img, .file-preview-image')) {
    event.preventDefault(); imageViewer.open(event.target); return;
  }
  if (conversations.menuConversationId || conversations.menuWorkspaceId) {
    if (event.key === 'Escape') { event.preventDefault(); closeConversationMenu(true); return; }
    if (event.key === 'Tab') closeConversationMenu();
    const buttons = [...$('conversation-menu').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && $('conversation-menu').contains(document.activeElement)) {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
      return;
    }
  }
});
$('history-list').addEventListener('scroll', () => closeConversationMenu(), { passive: true });
window.addEventListener('resize', () => closeConversationMenu());
for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
  if (dialog.id === 'permissions-dialog') dialog.addEventListener('close', () => tasks.closePermissions());
  dialog.addEventListener('close', () => {
    if (dialog.id === 'preview-dialog' && !dialog.open) clearFilePreview();
    acknowledgeViewedCompletion();
    if (dialog.id === 'queue-edit-dialog') composer.closeQueueEditor();
    if (dialog.id === 'message-edit-dialog') messageEditor.close();
    if (dialog.id === 'settings-dialog') settings.closeSettings();
    if (dialog.id === 'connections-dialog') settings.closeConnections();
    if (dialog.id === 'resources-dialog') files.closeResources();
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
}

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
    window.clearInterval(runtimeClock);
    clearDraftImages();
    clearHistoryImages();
  },
});
systemAppearance.addEventListener('change', () => {
  if (appearanceMode(app.state.settings.appearance) === 'system') applyAppearance('system');
});
render();
void app.start();
