import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';

interface Workspace { id: string; name: string; path: string }
type AppearanceMode = 'system' | 'light' | 'dark';
type PermissionMode = 'ask' | 'workspace-write' | 'full-access';
interface Conversation { id: string; title: string; workspaceId: string; updatedAt: string | number; permissionMode?: PermissionMode; archived?: boolean }
interface QueuedMessage { id: string; text: string; mode: 'steer' | 'follow-up'; imageCount?: number }
interface Artifact { path: string; name: string }
interface WorkspaceResources { workspaceId: string; instructions: { name: string; path: string; content: string }[]; skills: { name: string; path: string; description: string }[]; diagnostics: string[] }
interface MCPConnection { name: string; type: 'http' | 'stdio'; url?: string; command?: string; args: string[]; envKeys?: string[]; enabled: boolean; hasBearerToken: boolean; status: 'disconnected' | 'connecting' | 'connected' | 'error'; toolCount: number; error?: string }
interface MessageImage { index: number; mimeType: string }
interface ImageInput { type: 'image'; data: string; mimeType: string }
interface DraftImage extends ImageInput { id: string; name: string; size: number; url: string }
interface Message { id: string; role: string; text: string; toolName?: string; status?: string; images?: MessageImage[] }
interface Approval { id: string; toolName: string; args: unknown; warning?: string }
interface RunUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
interface RuntimeStatus { phase: string; model: string; usage: RunUsage; contextTokens: number; contextWindow: number; compactions: number; toolFailures: number }
interface Failure { kind: string; message: string; advice: string; canContinue: boolean }
interface State {
  settings: { baseUrl: string; model: string; hasApiKey: boolean; appearance?: AppearanceMode; supportsImages?: boolean; imageUploadLimit?: number };
  workspaces: Workspace[];
  conversations: Conversation[];
  activeId: string | null;
  messages: Message[];
  queuedMessages: QueuedMessage[];
  running: boolean;
  pendingApproval?: Approval | null;
  error?: string | null;
  runtime?: RuntimeStatus;
  failure?: Failure | null;
}

const tokenMeta = document.querySelector<HTMLMetaElement>('meta[name="desk-token"]');
const tokenValue = tokenMeta?.content ?? '';
const token = tokenValue === '__DESK_TOKEN__' ? '' : tokenValue;
tokenMeta?.remove();

const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');
const appearanceMode = (value: unknown): AppearanceMode => value === 'light' || value === 'dark' ? value : 'system';
const initialAppearance = appearanceMode(document.documentElement.dataset.appearance);

function applyAppearance(mode: AppearanceMode): void {
  document.documentElement.dataset.appearance = mode;
  document.documentElement.dataset.theme = mode === 'system' ? (systemAppearance.matches ? 'dark' : 'light') : mode;
}

applyAppearance(initialAppearance);

let state: State = {
  settings: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', hasApiKey: false, appearance: initialAppearance },
  workspaces: [], conversations: [], activeId: null, messages: [], queuedMessages: [], running: false,
};
let selectedWorkspaceId = '';
let snapshotLoaded = false;
let connection: 'connecting' | 'connected' | 'reconnecting' = 'connecting';
let requestBusy = false;
let connectionProbe: AbortController | null = null;
let localError = '';
let messagesSignature = '';
let renderedActiveId: string | null = null;
let approvalSignature = '';
let eventSocket: WebSocket | null = null;
let disposed = false;
let fullAccessTargetId: string | null = null;
let historyArchived = false;
let historySearch = '';
let artifacts: Artifact[] = [];
let artifactsError = '';
let artifactsLoading = false;
let artifactsRequest = 0;
let artifactsSignature = '';
let queueSignature = '';
let resources: WorkspaceResources | null = null;
let resourcesWorkspaceId = '';
let resourcesRequest = 0;
let mcpConnections: MCPConnection[] = [];
let mcpRequest = 0;
let mcpEditorGeneration = 0;
let draftImages: DraftImage[] = [];
let readingImages = false;
let draftGeneration = 0;
const historyImages = new Map<string, Promise<string>>();
let imageGeneration = 0;

const paths: Record<string, string> = {
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5a8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  settings: '<path d="m9.5 3-.7 2.2-2.1 1.2-2.3-.5-2.5 4.2 1.6 1.7v2.4l-1.6 1.7 2.5 4.2 2.3-.5 2.1 1.2.7 2.2h5l.7-2.2 2.1-1.2 2.3.5 2.5-4.2-1.6-1.7v-2.4l1.6-1.7-2.5-4.2-2.3.5-2.1-1.2-.7-2.2Z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z"/><path d="m8 12 3 3 5-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  terminal: '<path d="m4 7 5 5-5 5M12 17h8"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  plug: '<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-6 6v4M8 8V5M16 8V5"/>',
};
const icon = (name: string, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.chat}</svg>`;
const logo = '<span class="logo-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

$('app').innerHTML = `
  <aside class="sidebar" id="sidebar">
    <a class="brand" href="#" aria-label="Pith Desk home">${logo}<span>Pith<span class="brand-light"> Desk</span></span><span class="beta-tag">LOCAL</span></a>
    <button class="new-conversation" data-action="new">${icon('plus')}<span>New conversation</span><kbd>⌘ N</kbd></button>
    <div class="sidebar-section-label">WORKSPACE <button class="quiet-icon" data-action="workspace" aria-label="Manage workspaces">${icon('plus')}</button></div>
    <div id="workspace-list" class="workspace-list"></div>
    <div class="sidebar-section-label history-label">CONVERSATIONS</div>
    <label class="history-search">${icon('search')}<span class="sr-only">Search conversation titles</span><input id="history-search" type="search" placeholder="Search conversations" autocomplete="off" /></label>
    <div class="history-filters" aria-label="Conversation list"><button id="history-active" type="button" data-history-filter="active" aria-pressed="true">Active</button><button id="history-archived" type="button" data-history-filter="archived" aria-pressed="false">Archived</button></div>
    <nav id="history-list" class="history-list" aria-label="Conversation history"></nav>
    <div class="sidebar-bottom">
      <button class="settings-button" data-action="resources">${icon('file')}<span>Workspace resources</span></button>
      <button class="settings-button" data-action="connections">${icon('plug')}<span>Connections</span></button>
      <button class="settings-button" data-action="settings">${icon('settings')}<span>Settings</span></button>
      <div class="local-status"><span id="connection-dot" class="status-dot connecting"></span><span id="connection-text">Connecting to local service</span></div>
    </div>
  </aside>
  <div class="sidebar-scrim" id="sidebar-scrim"></div>
  <main class="main">
    <header class="topbar">
      <button class="quiet-icon mobile-menu" data-action="menu" aria-label="Open sidebar">${icon('menu')}</button>
      <div class="breadcrumb">${icon('folder')}<span id="workspace-label">No workspace</span>${icon('chevron', 'breadcrumb-chevron')}<span class="breadcrumb-current" id="conversation-label">New conversation</span></div>
      <div class="topbar-actions"><button class="model-pill" data-action="settings"><span class="model-indicator"></span><span id="model-label">deepseek-flash</span>${icon('down')}</button><details id="conversation-menu" class="conversation-menu"><summary aria-label="Conversation actions">${icon('more')}</summary><div class="conversation-actions"><button data-action="rename" data-conversation-action>Rename</button><button id="archive-conversation" data-action="archive" data-conversation-action>Archive</button><button data-action="export" data-conversation-action>Export Markdown</button></div></details></div>
    </header>
    <section id="chat-scroll" class="chat-scroll" aria-label="Conversation">
      <div id="welcome" class="welcome"></div>
      <div id="messages" class="messages" aria-live="polite" aria-relevant="additions text"></div>
      <section id="artifacts" class="artifacts" aria-label="Generated files" hidden></section>
    </section>
    <div class="composer-region">
      <div id="approval" class="approval-region"></div>
      <div id="inline-error" class="inline-error" role="alert" hidden></div>
      <section id="task-failure" class="task-failure" role="status" hidden></section>
      <details id="run-status" class="run-status" hidden><summary id="run-status-summary"></summary><div id="run-status-details"></div></details>
      <section id="queued-messages" class="queued-messages" aria-label="Pending messages" aria-live="polite" hidden></section>
      <form id="composer-form" class="composer">
        <div id="draft-images" class="draft-images" aria-label="Image attachments" hidden></div>
        <input id="image-picker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
        <textarea id="composer-input" rows="1" placeholder="Ask Pith to help with your work…" aria-label="Message Pith"></textarea>
        <div class="composer-toolbar">
          <div class="composer-context">
            <button id="attach-images" type="button" class="quiet-icon attach-images" data-action="attach-images" aria-label="Attach images" title="Attach images">${icon('image')}</button>
            <button type="button" class="workspace-chip" data-action="workspace">${icon('folder')}<span id="composer-workspace">Select workspace</span>${icon('down')}</button>
            <label class="permission-control" id="permission-control">${icon('shield')}<span class="sr-only">Conversation permissions</span><select id="permission-mode" aria-describedby="permission-description"><option value="ask">Ask before changes</option><option value="workspace-write">Allow workspace changes</option><option value="full-access">Full access</option></select>${icon('down')}</label>
            <label class="queue-control" id="queue-control" hidden><span class="sr-only">Send while Pith is running</span><select id="queue-mode"><option value="steer">Add instruction</option><option value="follow-up">Queue next task</option></select></label>
          </div>
          <div class="composer-actions"><span class="keyboard-hint">↵ to send</span><button id="send-button" class="send-button" type="submit" aria-label="Send message">${icon('arrow')}</button><button id="stop-button" class="stop-button" type="button" data-action="stop" aria-label="Stop agent" hidden>${icon('stop')}<span>Stop</span></button></div>
        </div>
      </form>
      <p id="image-guidance" class="composer-note image-guidance" hidden></p>
      <p class="composer-note" id="permission-description">Pith can read workspace files. Changes and commands require your approval.</p>
    </div>
  </main>
  <dialog id="settings-dialog" class="modal"><div id="settings-content"></div></dialog>
  <dialog id="workspace-dialog" class="modal"><div id="workspace-content"></div></dialog>
  <dialog id="permissions-dialog" class="modal permission-modal" aria-labelledby="full-access-title"><div id="permissions-content"></div></dialog>
  <dialog id="rename-dialog" class="modal" aria-labelledby="rename-title"><div id="rename-content"></div></dialog>
  <dialog id="resources-dialog" class="modal feature-modal" aria-labelledby="resources-title"><div id="resources-content"></div></dialog>
  <dialog id="connections-dialog" class="modal feature-modal" aria-labelledby="connections-title"><div id="connections-content"></div></dialog>
`;

const input = $<HTMLTextAreaElement>('composer-input');
const chatScroll = $('chat-scroll');

function selectedWorkspace(): Workspace | undefined {
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  return state.workspaces.find((entry) => entry.id === (conversation?.workspaceId || selectedWorkspaceId)) ?? state.workspaces[0];
}

function activePermissionMode(): PermissionMode {
  const mode = state.conversations.find((entry) => entry.id === state.activeId)?.permissionMode;
  return mode === 'workspace-write' || mode === 'full-access' ? mode : 'ask';
}

function renderMarkdown(value: string): string {
  const html = marked.parse(value, { async: false, breaks: true }) as string;
  const safe = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'svg', 'math', 'style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'src', 'srcset'],
    ALLOW_DATA_ATTR: false,
  });
  const container = document.createElement('div');
  container.innerHTML = safe;
  for (const link of container.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) link.removeAttribute('href');
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  return container.innerHTML;
}

function render(): void {
  renderAppearance();
  const workspace = selectedWorkspace();
  if (workspace) selectedWorkspaceId = workspace.id;
  const activeConversation = state.conversations.find((entry) => entry.id === state.activeId);
  $('workspace-label').textContent = workspace?.name ?? 'No workspace';
  $('conversation-label').textContent = activeConversation?.title || 'New conversation';
  $('composer-workspace').textContent = workspace?.name ?? 'Select workspace';
  $('model-label').textContent = state.settings.model || 'Choose a model';
  renderPermissions();
  $('workspace-list').innerHTML = state.workspaces.length ? state.workspaces.map((entry) => `
    <button class="workspace-item ${entry.id === workspace?.id ? 'selected' : ''}" data-workspace="${escape(entry.id)}" title="${escape(entry.path)}">${icon('folder')}<span>${escape(entry.name)}</span>${entry.id === workspace?.id ? '<span class="workspace-active-dot"></span>' : ''}</button>`).join('') : `
    <button class="workspace-item empty-workspace" data-action="workspace">${icon('folder')}<span>Add a workspace</span></button>`;
  renderHistory();
  $('conversation-menu').hidden = !activeConversation;
  $('archive-conversation').textContent = activeConversation?.archived ? 'Restore' : 'Archive';
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-conversation-action]')) button.disabled = requestBusy || !activeConversation || state.running;

  const hasMessages = state.messages.length > 0;
  $('welcome').hidden = hasMessages;
  $('messages').hidden = !hasMessages;
  if (!hasMessages) renderWelcome(workspace);

  const signature = JSON.stringify([state.activeId, state.messages, state.running, state.pendingApproval?.id]);
  if (signature !== messagesSignature) {
    const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 150;
    const changedConversation = renderedActiveId !== state.activeId;
    $('messages').innerHTML = state.messages.map(renderMessage).join('') + (state.running && !state.pendingApproval ? `<div class="agent-working"><span class="agent-avatar">${logo}</span><span class="working-dots"><i></i><i></i><i></i></span><span>Pith is working</span></div>` : '');
    messagesSignature = signature;
    renderedActiveId = state.activeId;
    loadHistoryImages();
    if (nearBottom || changedConversation) requestAnimationFrame(() => chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: changedConversation ? 'instant' : 'smooth' }));
  }

  renderApproval();
  renderArtifacts();
  renderQueue();
  renderRuntime();
  renderDraftImages();
  const error = localError || state.error || '';
  $('inline-error').hidden = !error || (!localError && !!state.failure);
  $('inline-error').textContent = error;
  $('connection-dot').className = `status-dot ${connection}`;
  $('connection-text').textContent = connection === 'connected' ? 'Local service connected' : connection === 'reconnecting' ? 'Reconnecting to local service' : 'Connecting to local service';
  $('stop-button').hidden = !state.running;
  $('queue-control').hidden = !state.running;
  $('send-button').hidden = false;
  $<HTMLButtonElement>('send-button').disabled = !snapshotLoaded || requestBusy || readingImages || (!input.value.trim() && !draftImages.length) || (!!draftImages.length && !state.settings.supportsImages) || !workspace || !state.settings.hasApiKey || !!activeConversation?.archived;
  $<HTMLSelectElement>('queue-mode').disabled = requestBusy;
  const queuedMode = $<HTMLSelectElement>('queue-mode').value;
  $('send-button').setAttribute('aria-label', state.running ? queuedMode === 'follow-up' ? 'Queue next task' : 'Add instruction' : 'Send message');
  input.placeholder = !snapshotLoaded ? 'Connecting to Pith…' : activeConversation?.archived ? 'Restore this conversation to send a message' : !state.settings.hasApiKey ? 'Connect your model in Settings to get started' : !workspace ? 'Choose a workspace to get started' : state.running ? queuedMode === 'follow-up' ? 'Describe the next task to run afterward…' : 'Add an instruction for the current task…' : 'Ask Pith to help with your work…';
  $<HTMLButtonElement>('stop-button').disabled = requestBusy;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-idle-action]')) button.disabled = requestBusy || state.running;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mcp-edit], [data-action="new-mcp"]')) button.disabled = requestBusy;
}

function renderRuntime(): void {
  const status = state.runtime;
  $('run-status').hidden = !status?.model;
  if (status?.model) {
    const phases: Record<string, string> = { starting: 'Starting', working: 'Working', tool: 'Using a tool', retrying: 'Retrying model request', compacting: 'Summarizing context', complete: 'Finished', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Needs attention' };
    const n = (value: number) => new Intl.NumberFormat().format(Math.round(value || 0));
    $('run-status-summary').textContent = `${state.pendingApproval ? 'Waiting for approval' : phases[status.phase] || 'Ready'} · ${status.model} · ${n(status.usage.total)} tokens`;
    $('run-status-details').innerHTML = `<dl><dt>Session input / output</dt><dd>${n(status.usage.input)} / ${n(status.usage.output)}</dd><dt>Cache read / write</dt><dd>${n(status.usage.cacheRead)} / ${n(status.usage.cacheWrite)}</dd><dt>Estimated conversation context</dt><dd>~${n(status.contextTokens)} / ${n(status.contextWindow)} tokens</dd><dt>Context summaries</dt><dd>${n(status.compactions)}</dd><dt>Tool failures recorded</dt><dd>${n(status.toolFailures)}</dd><dt>Cost</dt><dd>Not reported by this compatible endpoint</dd></dl><p>Tokens come from Pith session records. Context is an estimate of conversation messages; system instructions and tool schemas also take space. Requests without usage reports and summarization requests may not be included. This is not a provider bill.</p>`;
  }
  const failure = state.failure;
  $('task-failure').hidden = !failure || state.running;
  $('task-failure').innerHTML = failure && !state.running ? `<strong>${escape(failure.message)}</strong><p>${escape(failure.advice)}</p><div>${failure.canContinue ? '<button class="secondary-button" type="button" data-action="continue" data-idle-action>Review and continue</button>' : '<button class="secondary-button" type="button" data-action="settings">Check model settings</button>'}<button class="text-button" type="button" data-action="diagnostics">Save diagnostics</button></div>` : '';
}

async function exportDiagnostics(): Promise<void> {
  if (requestBusy) return;
  requestBusy = true;
  render();
  try {
    const result = await request<{ native: boolean }>('/api/diagnostics', {});
    if (!result.native) {
      const response = await fetch('/api/diagnostics', { headers: headers(), credentials: 'same-origin' });
      if (!response.ok) throw new Error('Diagnostic export failed.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'pith-desk-diagnostics.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) { localError = error instanceof Error ? error.message : String(error); }
  finally { requestBusy = false; render(); }
}

function renderHistory(): void {
  $('history-active').setAttribute('aria-pressed', String(!historyArchived));
  $('history-archived').setAttribute('aria-pressed', String(historyArchived));
  const search = historySearch.trim().toLocaleLowerCase();
  const conversations = state.conversations.filter((entry) => !!entry.archived === historyArchived && (entry.title || 'Untitled conversation').toLocaleLowerCase().includes(search)).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  $('history-list').innerHTML = conversations.length ? conversations.map((entry) => `<button class="history-item ${entry.id === state.activeId ? 'active' : ''}" data-conversation="${escape(entry.id)}" title="${escape(entry.title || 'Untitled conversation')}">${icon('chat')}<span>${escape(entry.title || 'Untitled conversation')}</span></button>`).join('') : `<p class="history-empty">${search ? 'No matching conversations.' : historyArchived ? 'No archived conversations.' : 'A little space for<br>your next good idea.'}</p>`;
}

function renderQueue(): void {
  const queued = state.queuedMessages || [];
  const signature = JSON.stringify([state.activeId, queued]);
  if (signature === queueSignature) return;
  queueSignature = signature;
  $('queued-messages').hidden = !queued.length;
  $('queued-messages').innerHTML = queued.length ? `<div class="section-heading">Pending messages</div>${queued.map((entry) => `<div class="queued-message"><span class="queue-badge">${entry.mode === 'steer' ? 'Instruction' : 'Next task'}</span><span>${escape(entry.text)}${entry.imageCount ? `<small class="queue-image-count">${entry.imageCount} image${entry.imageCount === 1 ? '' : 's'}</small>` : ''}</span></div>`).join('')}` : '';
}

function renderAppearance(): void {
  const mode = appearanceMode(state.settings.appearance);
  applyAppearance(mode);
  const selector = document.getElementById('appearance-mode') as HTMLSelectElement | null;
  if (selector) {
    selector.value = mode;
    selector.disabled = requestBusy || !snapshotLoaded;
  }
}

function renderWelcome(workspace?: Workspace): void {
  const ready = !!workspace && state.settings.hasApiKey;
  $('welcome').innerHTML = `
    <div class="welcome-mark">${logo}</div>
    <p class="eyebrow">YOUR LOCAL WORK COMPANION</p>
    <h1>${ready ? 'What are we working on?' : 'Your work. A little more possible.'}</h1>
    <p class="welcome-description">An agent that works alongside you, with your files<br class="desktop-break"> and the tools you choose.</p>
    ${!ready ? `<div class="setup-card">
      <div class="setup-card-heading">Make yourself at home <span>Two quick steps</span></div>
      <button class="setup-step" data-action="settings"><span class="step-number ${state.settings.hasApiKey ? 'complete' : ''}">${state.settings.hasApiKey ? icon('check') : '1'}</span><span><strong>${state.settings.hasApiKey ? 'Model configured' : 'Connect your model'}</strong><small>${state.settings.hasApiKey ? escape(state.settings.model) : 'Bring your DeepSeek or compatible API key'}</small></span>${icon('chevron')}</button>
      <button class="setup-step" data-action="workspace"><span class="step-number ${workspace ? 'complete' : ''}">${workspace ? icon('check') : '2'}</span><span><strong>${workspace ? escape(workspace.name) : 'Choose a workspace'}</strong><small>${workspace ? escape(workspace.path) : 'A folder Pith can help you work in'}</small></span>${icon('chevron')}</button>
    </div>` : `<div class="welcome-workspace">${icon('folder')}<span>Working in <strong>${escape(workspace.name)}</strong></span><button class="text-button" data-action="workspace">Change</button></div>
    <div class="suggestions"><button data-prompt="Explore this workspace and give me a concise overview of its files.">${icon('file')}Explore my workspace</button><button data-prompt="Help me plan a task. Start by asking what I want to accomplish.">${icon('chat')}Think through a task</button><button data-prompt="I'd like help creating a document in this workspace. Ask me what it should cover.">${icon('plus')}Create something</button></div>`}
    <div class="welcome-footnote">${icon('shield')}Local workspace. Your choice of model.</div>
  `;
}

function renderMessage(message: Message): string {
  const text = message.text ?? '';
  const images = (message.images || []).map((image) => `<img class="history-image" data-image-key="${escape(`${state.activeId}/${message.id}/${image.index}`)}" data-message-id="${escape(message.id)}" data-image-index="${image.index}" alt="Image ${image.index + 1}" loading="lazy" />`).join('');
  const gallery = images ? `<div class="message-images">${images}</div>` : '';
  if (message.role === 'tool') return `<details class="tool-message" ${message.status === 'running' ? 'open' : ''}><summary>${icon('terminal')}<span>${escape(message.toolName || 'Tool result')}</span><span class="tool-status">${escape(message.status || 'Result')}</span>${icon('down')}</summary><pre>${escape(text)}</pre>${gallery}</details>`;
  if (message.role === 'user') return `<article class="message user-message"><div class="message-content"><div class="message-label">You</div>${text ? `<div class="user-text">${escape(text)}</div>` : ''}${gallery}</div></article>`;
  if (message.role === 'system') return `<div class="system-message">${escape(text)}</div>`;
  return `<article class="message assistant-message"><span class="agent-avatar">${logo}</span><div class="message-content"><div class="message-label">Pith</div><div class="markdown">${renderMarkdown(text)}</div>${message.status === 'error' ? '<span class="message-error-label">Response interrupted</span>' : ''}</div></article>`;
}

function renderApproval(): void {
  const approval = state.pendingApproval;
  const signature = JSON.stringify([approval, requestBusy]);
  if (signature === approvalSignature) return;
  approvalSignature = signature;
  const warning = approval?.warning || (approval?.toolName === 'run_command' ? 'This command runs with your normal computer permissions. It may access or change files outside this workspace.' : '');
  const canAlwaysAllow = approval?.toolName === 'write_file' || approval?.toolName === 'edit_file';
  $('approval').innerHTML = approval ? `<section class="approval-card" aria-label="Tool approval required"><div class="approval-heading">${icon('shield')}<div><strong>Pith needs your permission</strong><span>Review this action before it runs.</span></div><span class="approval-badge">${escape(approval.toolName)}</span></div>${warning ? `<p class="approval-warning">${escape(warning)}</p>` : ''}<pre>${escape(typeof approval.args === 'string' ? approval.args : JSON.stringify(approval.args, null, 2))}</pre>${canAlwaysAllow ? '<p class="approval-scope">Workspace permission applies to this conversation. Commands and external connection tools still need approval.</p>' : ''}<div class="approval-actions"><button class="secondary-button" data-approval="deny" ${requestBusy ? 'disabled' : ''}>Deny</button>${canAlwaysAllow ? `<button class="secondary-button always-allow-button" data-approval="always" ${requestBusy ? 'disabled' : ''}>Always allow workspace changes</button>` : ''}<button class="primary-button" data-approval="allow" ${requestBusy ? 'disabled' : ''}>${icon('check')}Allow this action</button></div></section>` : '';
  for (const button of $('approval').querySelectorAll<HTMLButtonElement>('[data-approval]')) button.dataset.approvalId = approval?.id || '';
}

function renderPermissions(): void {
  const mode = activePermissionMode();
  const selector = $<HTMLSelectElement>('permission-mode');
  selector.value = mode;
  selector.disabled = !snapshotLoaded || !state.activeId || requestBusy;
  $('permission-control').classList.toggle('full-access', mode === 'full-access');
  const descriptions: Record<PermissionMode, string> = {
    ask: 'Pith can read workspace files. Changes, commands, and external connection tools require approval.',
    'workspace-write': 'Workspace file changes are allowed. Commands and external connection tools still require approval.',
    'full-access': 'Full access: all enabled tools, including external connections, run without asking. There is no OS sandbox.',
  };
  $('permission-description').textContent = descriptions[mode];
  $('permission-description').classList.toggle('full-access-note', mode === 'full-access');
  const dialog = $<HTMLDialogElement>('permissions-dialog');
  if (dialog.open && fullAccessTargetId !== state.activeId) {
    dialog.close();
    localError = 'The active conversation changed. Choose its permissions again.';
  }
  const confirm = document.getElementById('enable-full-access') as HTMLButtonElement | null;
  if (confirm) confirm.disabled = requestBusy || !fullAccessTargetId || fullAccessTargetId !== state.activeId;
}

function confirmFullAccess(id: string): void {
  fullAccessTargetId = id;
  const conversation = state.conversations.find((entry) => entry.id === id);
  $('permissions-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">CONVERSATION PERMISSIONS</span><h2 id="full-access-title">Enable full access?</h2></div><button class="quiet-icon" data-close="permissions-dialog" aria-label="Cancel full access">${icon('close')}</button></div><p class="modal-description">Give Pith permission to run <strong>all enabled tools, including external MCP connections,</strong> without asking in <strong>${escape(conversation?.title || 'this conversation')}</strong>.</p><div class="full-access-explanation">${icon('shield')}<div><strong>This is access to your computer account and connected services.</strong><p>Commands can read, change, or delete files outside the workspace and access the network. External tools can act on their connected services. There is no OS sandbox.</p></div></div><p class="permission-revoke-note">This applies only to the current conversation and stays enabled across app restarts until you revoke it. To revoke it, choose “Ask before changes” or “Allow workspace changes” in the composer. Workspace permission alone never grants external MCP tools access.</p><div id="permissions-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="permissions-dialog">Cancel</button><button class="primary-button full-access-confirm" id="enable-full-access" type="button">Enable full access</button></div>`;
  $<HTMLDialogElement>('permissions-dialog').showModal();
  $('enable-full-access').addEventListener('click', async () => {
    const targetId = fullAccessTargetId;
    if (!targetId || targetId !== state.activeId || requestBusy) return;
    if (await mutate('/api/permissions', { id: targetId, mode: 'full-access' })) $<HTMLDialogElement>('permissions-dialog').close();
    else if ($<HTMLDialogElement>('permissions-dialog').open) $('permissions-error').textContent = localError;
  });
}

function setState(next: State): void {
  if (!next || !next.settings || !Array.isArray(next.messages) || !Array.isArray(next.workspaces) || !Array.isArray(next.conversations)) throw new Error('The local service returned an invalid state.');
  const shouldLoadArtifacts = !next.running && (!snapshotLoaded || next.activeId !== state.activeId || state.running);
  const activeChanged = next.activeId !== state.activeId;
  const runFinished = state.running && !next.running;
  state = { ...next, queuedMessages: Array.isArray(next.queuedMessages) ? next.queuedMessages : [] };
  if (activeChanged) { clearHistoryImages(); artifacts = []; artifactsError = ''; artifactsLoading = false; artifactsRequest++; }
  snapshotLoaded = true;
  render();
  if (shouldLoadArtifacts && next.activeId) void loadArtifacts(next.activeId);
  if (runFinished && $<HTMLDialogElement>('connections-dialog').open) void loadMCP();
}

function headers(json = false): Headers {
  const value = new Headers();
  if (token) value.set('Authorization', `Bearer ${token}`);
  if (json) value.set('Content-Type', 'application/json');
  return value;
}

async function request<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: headers(payload !== undefined), body: payload === undefined ? undefined : JSON.stringify(payload), credentials: 'same-origin' });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok === false) {
    const error = body?.error;
    throw new Error(typeof error === 'string' ? error : error?.message || `Request failed (${response.status}).`);
  }
  return body as T;
}

async function refresh(): Promise<void> { setState(await request<State>('/api/state')); }

async function mutate<T = unknown>(path: string, payload: unknown, onResponse?: (response: T) => void): Promise<boolean> {
  if (requestBusy) return false;
  requestBusy = true;
  localError = '';
  render();
  try {
    const response = await request<T>(path, payload);
    onResponse?.(response);
    await refresh();
    return true;
  } catch (error) {
    localError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    requestBusy = false;
    render();
  }
}

async function newConversation(workspaceId = selectedWorkspace()?.id): Promise<void> {
  if (!workspaceId) { openWorkspace(); return; }
  if (state.running) { localError = 'Stop the current run before starting another conversation.'; render(); return; }
  if (await mutate('/api/conversations', { workspaceId })) {
    historyArchived = false;
    input.value = '';
    clearDraftImages();
    resizeComposer();
    closeSidebar();
    input.focus();
  }
}

async function send(): Promise<void> {
  const draft = input.value;
  const text = input.value.trim();
  const images = draftImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
  const submittedIds = new Set(draftImages.map((image) => image.id));
  if ((!text && !images.length) || requestBusy || readingImages) return;
  if (images.length && !state.settings.supportsImages) { localError = 'Choose an image-capable model in Settings, or remove the attachments.'; render(); return; }
  if (state.conversations.find((entry) => entry.id === state.activeId)?.archived) return;
  if (state.running) { await queueMessage(text, draft, images, submittedIds); return; }
  if (!state.settings.hasApiKey) { openSettings(); return; }
  if (!selectedWorkspace()) { openWorkspace(); return; }
  if (!state.activeId && !await mutate('/api/conversations', { workspaceId: selectedWorkspace()!.id })) return;
  if (await mutate('/api/send', { text, images }, () => {
    if (input.value === draft) input.value = '';
    clearDraftImages(submittedIds);
  })) {
    resizeComposer();
    render();
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: 'smooth' });
  }
}

async function queueMessage(text: string, draft: string, images: ImageInput[], submittedIds: Set<string>): Promise<void> {
  const id = state.activeId;
  if (!id || requestBusy) return;
  const mode = $<HTMLSelectElement>('queue-mode').value === 'follow-up' ? 'follow-up' : 'steer';
  requestBusy = true;
  localError = '';
  render();
  try {
    // A queue POST is sent exactly once. A lost response must not duplicate work.
    await request('/api/queue', { id, text, mode, images });
    clearDraftImages(submittedIds);
    if (input.value === draft) input.value = '';
    resizeComposer();
    await refresh().catch(() => { localError = 'Message submitted. Waiting for the local service to update the pending list.'; });
  } catch (error) {
    localError = `${error instanceof Error ? error.message : String(error)} The message was not resent. Check pending messages before trying again.`;
  } finally { requestBusy = false; render(); }
}

function dialogHeading(title: string, id: string, dialogId: string, eyebrow: string): string {
  return `<div class="modal-heading"><div><span class="eyebrow">${escape(eyebrow)}</span><h2 id="${id}">${escape(title)}</h2></div><button class="quiet-icon" data-close="${dialogId}" aria-label="Close ${escape(title.toLowerCase())}">${icon('close')}</button></div>`;
}

function showDialog(id: string): void {
  closeSidebar();
  const dialog = $<HTMLDialogElement>(id);
  if (!dialog.open) dialog.showModal();
}

function openRename(): void {
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  if (!conversation || state.running) return;
  const id = conversation.id;
  $('rename-content').innerHTML = `${dialogHeading('Rename conversation', 'rename-title', 'rename-dialog', 'CONVERSATION')}<form id="rename-form"><label class="field-label" for="conversation-title">Title</label><input id="conversation-title" name="title" value="${escape(conversation.title || '')}" required autocomplete="off" /><div id="rename-error" class="form-error" role="alert"></div><div class="modal-footer"><button type="button" class="secondary-button" data-close="rename-dialog">Cancel</button><button type="submit" class="primary-button" data-idle-action>Save title</button></div></form>`;
  showDialog('rename-dialog');
  $<HTMLInputElement>('conversation-title').select();
  $('rename-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $<HTMLInputElement>('conversation-title').value.trim();
    if (!title || state.running || requestBusy) return;
    if (await mutate('/api/rename', { id, title })) $<HTMLDialogElement>('rename-dialog').close();
    else $('rename-error').textContent = localError;
  });
}

async function exportConversation(): Promise<void> {
  const conversation = state.conversations.find((entry) => entry.id === state.activeId);
  if (!conversation || requestBusy || state.running) return;
  requestBusy = true;
  localError = '';
  render();
  try {
    const delivery = await request<{ native: boolean }>('/api/export', { id: conversation.id });
    // A native save (including cancellation) fully handles this export.
    // Only an explicit browser-preview response permits the Blob download.
    if (delivery?.native === true) return;
    if (delivery?.native !== false) throw new Error('The local service returned an invalid export response.');
    const response = await fetch(`/api/export?id=${encodeURIComponent(conversation.id)}`, { headers: headers(), credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.error === 'string' ? body.error : `Export failed (${response.status}).`);
    }
    const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(conversation.title || 'Conversation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'Conversation'}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { localError = error instanceof Error ? error.message : String(error); }
  finally { requestBusy = false; render(); }
}

function fileActions(kind: 'artifact' | 'resource', ownerId: string, path: string): string {
  return `<div class="file-actions"><button class="secondary-button" data-file-kind="${kind}" data-file-owner="${escape(ownerId)}" data-file-path="${escape(path)}" data-file-action="open" data-idle-action>Open</button><button class="secondary-button" data-file-kind="${kind}" data-file-owner="${escape(ownerId)}" data-file-path="${escape(path)}" data-file-action="reveal" data-idle-action>Reveal</button></div>`;
}

function renderArtifacts(): void {
  const region = $('artifacts');
  const signature = JSON.stringify([state.activeId, artifacts, artifactsError, artifactsLoading]);
  if (signature === artifactsSignature) return;
  artifactsSignature = signature;
  region.hidden = !state.activeId || (!artifacts.length && !artifactsError && !artifactsLoading);
  region.innerHTML = `<div class="section-heading">Generated files</div>${artifactsLoading ? '<p class="feature-hint">Looking for files…</p>' : ''}${artifacts.map((file) => `<article class="file-card">${icon('file')}<div class="file-info"><strong>${escape(file.name)}</strong><span class="file-path">${escape(file.path)}</span></div>${fileActions('artifact', state.activeId || '', file.path)}</article>`).join('')}${artifactsError ? `<p class="form-error" role="alert">${escape(artifactsError)}</p>` : ''}`;
}

async function loadArtifacts(id: string): Promise<void> {
  const sequence = ++artifactsRequest;
  artifactsLoading = true;
  artifactsError = '';
  render();
  try {
    const result = await request<Artifact[]>(`/api/artifacts?id=${encodeURIComponent(id)}`);
    if (sequence !== artifactsRequest || state.activeId !== id) return;
    artifacts = result;
  } catch (error) {
    if (sequence !== artifactsRequest || state.activeId !== id) return;
    artifactsError = error instanceof Error ? error.message : String(error);
  } finally { if (sequence === artifactsRequest) { artifactsLoading = false; render(); } }
}

function openResources(): void {
  const workspace = selectedWorkspace();
  if (!workspace) { openWorkspace(); return; }
  resourcesWorkspaceId = workspace.id;
  resources = null;
  $('resources-content').innerHTML = `${dialogHeading('Workspace resources', 'resources-title', 'resources-dialog', workspace.name)}<p class="modal-description">Instructions and skills help Pith work in this workspace. Open a Markdown file to edit it in your installed app. Changes are loaded for the next task.</p><div class="feature-toolbar"><button class="secondary-button" data-action="refresh-resources">Refresh</button></div><div id="resources-list"><p class="feature-hint">Loading workspace resources…</p></div><div id="resources-error" class="form-error" role="alert"></div>`;
  showDialog('resources-dialog');
  void loadResources();
}

async function loadResources(): Promise<void> {
  const id = resourcesWorkspaceId;
  if (!id) return;
  const sequence = ++resourcesRequest;
  $('resources-error').textContent = '';
  try {
    const result = await request<WorkspaceResources>(`/api/resources?workspaceId=${encodeURIComponent(id)}`);
    if (sequence !== resourcesRequest || id !== resourcesWorkspaceId) return;
    resources = result;
    renderResources();
  } catch (error) { if (sequence === resourcesRequest) $('resources-error').textContent = error instanceof Error ? error.message : String(error); }
}

function renderResources(): void {
  if (!resources) return;
  const workspace = state.workspaces.find((entry) => entry.id === resourcesWorkspaceId);
  const rootPath = `${workspace?.path.replace(/\\/g, '/').replace(/\/$/, '')}/AGENTS.md`;
  const hasInstructions = resources.instructions.some((entry) => entry.path.replace(/\\/g, '/') === rootPath);
  $('resources-list').innerHTML = `<section class="resource-section"><h3>Instructions</h3>${resources.instructions.map((entry) => `<article class="resource-card"><div class="file-card">${icon('file')}<div class="file-info"><strong>${escape(entry.name)}</strong><span class="file-path">${escape(entry.path)}</span></div>${fileActions('resource', resourcesWorkspaceId, entry.path)}</div><details class="resource-preview"><summary>View instructions</summary><pre>${escape(entry.content)}</pre></details></article>`).join('') || '<p class="feature-hint">No workspace instructions found.</p>'}${!hasInstructions ? '<button class="secondary-button" data-action="create-instructions" data-idle-action>Create AGENTS.md in this workspace</button>' : ''}</section><section class="resource-section"><h3>Skills</h3>${resources.skills.map((entry) => `<article class="file-card">${icon('file')}<div class="file-info"><strong>${escape(entry.name)}</strong><p>${escape(entry.description)}</p><span class="file-path">${escape(entry.path)}</span></div>${fileActions('resource', resourcesWorkspaceId, entry.path)}</article>`).join('') || '<p class="feature-hint">No skills found. Add .pi/skills/&lt;skill-name&gt;/SKILL.md in this workspace, then refresh.</p>'}</section>${resources.diagnostics.length ? `<section class="resource-section resource-diagnostics"><h3>Resource notes</h3>${resources.diagnostics.map((entry) => `<p>${escape(entry)}</p>`).join('')}</section>` : ''}`;
  render();
}

function openConnections(): void {
  $('connections-content').innerHTML = `${dialogHeading('Connections', 'connections-title', 'connections-dialog', 'EXTERNAL TOOLS')}<p class="modal-description">Connect an MCP server to add its tools. Enabled connections are used when a task starts, or when you choose Connect. External tools require approval unless this conversation has full access.</p><div class="feature-toolbar"><button class="secondary-button" data-action="connect-mcp" data-idle-action>Connect enabled</button><button class="secondary-button" data-action="disconnect-mcp" data-idle-action>Disconnect</button><button class="secondary-button" data-action="refresh-mcp">Refresh</button></div><div id="mcp-list"><p class="feature-hint">Loading connections…</p></div><div id="mcp-error" class="form-error" role="alert"></div><section class="connection-editor"><div class="section-heading"><span id="mcp-form-title">Add connection</span><button type="button" class="text-button" data-action="new-mcp">New connection</button></div><form id="mcp-form"><label class="field-label" for="mcp-name">Name</label><input id="mcp-name" name="name" required autocomplete="off" placeholder="my-tools" /><label class="field-label" for="mcp-type">Connection type</label><select id="mcp-type" name="type" class="feature-select"><option value="http">HTTP</option><option value="stdio">Local command (stdio)</option></select><div id="mcp-http-fields"><label class="field-label" for="mcp-url">Server URL</label><input id="mcp-url" name="url" type="url" placeholder="https://example.com/mcp" autocomplete="off" /><label class="field-label" for="mcp-token">Bearer token (optional)</label><input id="mcp-token" name="bearerToken" type="password" autocomplete="new-password" placeholder="Optional token" /><label class="checkbox-field" id="mcp-clear-token-row" hidden><input id="mcp-clear-token" type="checkbox" />Remove saved bearer token</label><p class="field-hint">Saved tokens are never returned to this page. Leave this field blank to keep an existing token.</p></div><div id="mcp-stdio-fields" hidden><label class="field-label" for="mcp-command">Installed executable</label><input id="mcp-command" name="command" placeholder="/path/to/mcp-server" autocomplete="off" /><label class="field-label" for="mcp-args">Arguments (JSON array)</label><textarea id="mcp-args" name="args" rows="3" spellcheck="false">[]</textarea><p class="field-hint">The executable and any runtime it needs must already be installed on your computer. Pith Desk does not bundle external runtimes or a marketplace.</p><div class="secret-label"><label class="field-label" for="mcp-env">Environment overrides (JSON object, optional)</label><button class="text-button" type="button" id="mcp-env-visibility" data-action="toggle-env" aria-controls="mcp-env" aria-pressed="false">Show</button></div><textarea id="mcp-env" class="secret-field" name="env" rows="3" spellcheck="false" autocomplete="off" aria-describedby="mcp-env-hint" placeholder='{"API_KEY":"…"}'></textarea><p id="mcp-env-hint" class="field-hint">Values stay private. Leave blank to keep saved overrides. Add a JSON object of string keys and values to set or replace individual overrides.</p><p id="mcp-env-keys" class="field-hint" hidden></p><label class="checkbox-field" id="mcp-clear-env-row" hidden><input id="mcp-clear-env" type="checkbox" />Clear saved environment overrides</label></div><label class="checkbox-field"><input id="mcp-enabled" name="enabled" type="checkbox" checked />Enable this connection</label><div id="mcp-form-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="connections-dialog">Close</button><button class="primary-button" type="submit" data-idle-action>Save connection</button></div></form></section>`;
  showDialog('connections-dialog');
  $<HTMLSelectElement>('mcp-type').addEventListener('change', renderMCPType);
  $('mcp-form').addEventListener('submit', (event) => { event.preventDefault(); void saveMCP(); });
  renderMCPType();
  render();
  void loadMCP();
}

function renderMCPType(): void {
  const http = $<HTMLSelectElement>('mcp-type').value === 'http';
  $('mcp-http-fields').hidden = !http;
  $('mcp-stdio-fields').hidden = http;
  $<HTMLInputElement>('mcp-url').required = http;
  $<HTMLInputElement>('mcp-command').required = !http;
}

async function loadMCP(): Promise<void> {
  const sequence = ++mcpRequest;
  $('mcp-error').textContent = '';
  try {
    const result = await request<MCPConnection[]>('/api/mcp');
    if (sequence !== mcpRequest) return;
    mcpConnections = result;
    renderMCPList();
    render();
  } catch (error) { if (sequence === mcpRequest) $('mcp-error').textContent = error instanceof Error ? error.message : String(error); }
}

function renderMCPList(): void {
  $('mcp-list').innerHTML = mcpConnections.map((entry) => `<article class="connection-card"><div class="connection-card-heading"><strong>${escape(entry.name)}</strong><span class="connection-status ${entry.status === 'error' ? 'is-error' : ''}">${escape(entry.status)} · ${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}</span></div><p class="file-path">${escape(entry.type === 'http' ? entry.url : [entry.command, ...(entry.args || [])].join(' '))}</p><p class="feature-hint">${entry.enabled ? 'Enabled' : 'Disabled'}${entry.hasBearerToken ? ' · Token configured' : ''}</p>${entry.envKeys?.length ? `<p class="feature-hint">Saved environment keys: ${escape(entry.envKeys.join(', '))}</p>` : ''}${entry.error ? `<p class="form-error">${escape(entry.error)}</p>` : ''}<div class="file-actions"><button class="secondary-button" data-mcp-edit="${escape(entry.name)}">Edit</button><button class="secondary-button" data-mcp-toggle="${escape(entry.name)}" data-idle-action>${entry.enabled ? 'Disable' : 'Enable'}</button><button class="secondary-button destructive-button" data-mcp-remove="${escape(entry.name)}" data-idle-action>Delete</button></div></article>`).join('') || '<p class="feature-hint">No connections yet. Add an HTTP server or an installed local MCP command below.</p>';
}

function editMCP(entry?: MCPConnection): void {
  mcpEditorGeneration++;
  $<HTMLFormElement>('mcp-form').reset();
  $<HTMLTextAreaElement>('mcp-env').classList.remove('revealed');
  $('mcp-env-visibility').setAttribute('aria-pressed', 'false');
  $('mcp-env-visibility').textContent = 'Show';
  $('mcp-form-title').textContent = entry ? `Edit ${entry.name}` : 'Add connection';
  $<HTMLInputElement>('mcp-name').value = entry?.name || '';
  $<HTMLInputElement>('mcp-name').readOnly = !!entry;
  $<HTMLSelectElement>('mcp-type').value = entry?.type || 'http';
  $<HTMLInputElement>('mcp-url').value = entry?.url || '';
  $<HTMLInputElement>('mcp-command').value = entry?.command || '';
  $<HTMLTextAreaElement>('mcp-args').value = JSON.stringify(entry?.args || [], null, 2);
  $<HTMLInputElement>('mcp-enabled').checked = entry?.enabled ?? true;
  $<HTMLInputElement>('mcp-token').placeholder = entry?.hasBearerToken ? 'Leave blank to keep your saved token' : 'Optional token';
  $('mcp-clear-token-row').hidden = !entry?.hasBearerToken;
  const envKeys = entry?.envKeys || [];
  $('mcp-clear-env-row').hidden = !envKeys.length;
  $('mcp-env-keys').hidden = !envKeys.length;
  $('mcp-env-keys').textContent = `Saved environment keys: ${envKeys.join(', ')}`;
  $('mcp-form-error').textContent = '';
  renderMCPType();
  $<HTMLInputElement>(entry ? entry.type === 'stdio' ? 'mcp-command' : 'mcp-url' : 'mcp-name').focus();
}

function parseConnectionJSON(value: string, label: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error(`Enter valid JSON for ${label}.`); }
}

async function saveMCP(): Promise<void> {
  if (requestBusy || state.running) return;
  const originalForm = $<HTMLFormElement>('mcp-form');
  const generation = mcpEditorGeneration;
  const isCurrent = () => $<HTMLDialogElement>('connections-dialog').open && document.getElementById('mcp-form') === originalForm && mcpEditorGeneration === generation;
  $('mcp-form-error').textContent = '';
  try {
    const name = $<HTMLInputElement>('mcp-name').value.trim();
    const type = $<HTMLSelectElement>('mcp-type').value === 'stdio' ? 'stdio' : 'http';
    const args: unknown = type === 'stdio' ? parseConnectionJSON($<HTMLTextAreaElement>('mcp-args').value || '[]', 'arguments') : [];
    if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) throw new Error('Arguments must be a JSON array of strings.');
    const envDraft = $<HTMLTextAreaElement>('mcp-env').value.trim();
    const env: unknown = type === 'stdio' && envDraft ? parseConnectionJSON(envDraft, 'environment overrides') : undefined;
    if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((value) => typeof value === 'string'))) throw new Error('Environment overrides must be a JSON object with string values.');
    const bearerToken = $<HTMLInputElement>('mcp-token').value.trim();
    const payload = { name, type, args, enabled: $<HTMLInputElement>('mcp-enabled').checked, ...(type === 'http' ? { url: $<HTMLInputElement>('mcp-url').value.trim(), ...(bearerToken ? { bearerToken } : {}), ...($<HTMLInputElement>('mcp-clear-token').checked ? { clearBearerToken: true } : {}) } : { command: $<HTMLInputElement>('mcp-command').value.trim(), ...(env !== undefined ? { env } : {}), ...($<HTMLInputElement>('mcp-clear-env').checked ? { clearEnv: true } : {}) }) };
    const saved = await mutate('/api/mcp/save', payload);
    if (!isCurrent()) return;
    $<HTMLInputElement>('mcp-token').value = '';
    if (!saved) $('mcp-form-error').textContent = localError;
    else {
      $<HTMLTextAreaElement>('mcp-env').value = '';
      await loadMCP();
      if (isCurrent()) editMCP(mcpConnections.find((entry) => entry.name === name));
    }
  } catch (error) { if (isCurrent()) $('mcp-form-error').textContent = error instanceof Error ? error.message : String(error); }
}

function openSettings(): void {
  closeSidebar();
  const appearanceSection = `<section class="appearance-settings" aria-labelledby="appearance-title"><div><h3 id="appearance-title">Appearance</h3><p class="appearance-hint" id="appearance-hint">A bright white workspace or a calm dark one, both with a blue accent. Follow system matches your computer.</p></div><label class="sr-only" for="appearance-mode">Appearance</label><select id="appearance-mode" class="appearance-select" aria-describedby="appearance-hint"><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select><div id="appearance-error" class="form-error" role="alert"></div></section>`;
  connectionProbe?.abort();
  connectionProbe = null;
  $('settings-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2>Settings</h2></div><button class="quiet-icon" data-close="settings-dialog" aria-label="Close settings">${icon('close')}</button></div>${appearanceSection}<p class="modal-description">Connect DeepSeek or an OpenAI-compatible provider.<br>Your key is kept by the local Pith service.</p><form id="settings-form"><label class="field-label" for="base-url">API base URL</label><div class="input-with-icon">${icon('globe')}<input id="base-url" name="baseUrl" type="url" required value="${escape(state.settings.baseUrl || 'https://api.deepseek.com/v1')}" placeholder="https://api.deepseek.com/v1" autocomplete="off" /></div><label class="field-label" for="model-name">Model</label><input id="model-name" name="model" required value="${escape(state.settings.model || 'deepseek-flash')}" placeholder="deepseek-flash" autocomplete="off" /><label class="field-label" for="api-key">API key ${state.settings.hasApiKey ? '<span class="configured-badge">Configured</span>' : ''}</label><input id="api-key" name="apiKey" type="password" placeholder="${state.settings.hasApiKey ? 'Leave blank to keep your current key' : 'Paste your API key'}" autocomplete="new-password" ${state.settings.hasApiKey ? '' : 'required'} /><p class="field-hint">The saved key is never returned to this page. Model requests go to your configured provider.</p>${state.settings.hasApiKey ? '<button class="remove-key" id="remove-key" type="button">Remove saved API key</button>' : ''}<div class="connection-test"><button type="button" class="secondary-button" id="test-connection" data-idle-action>Test connection</button><p class="field-hint">Sends a small model request to check streaming and tool calling. Does not save settings or access files.</p><div id="connection-test-result" role="status" aria-live="polite"></div></div><div id="settings-error" class="form-error" role="alert"></div><div class="diagnostics-setting"><button type="button" class="text-button" data-action="diagnostics">Save diagnostics</button><span>Version, usage and failure category only; no conversation, file contents, paths or credentials.</span></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="settings-dialog">Cancel</button><button class="primary-button" id="save-settings" type="submit">Save settings</button></div></form>`;
  renderAppearance();
  $<HTMLDialogElement>('settings-dialog').showModal();
  const originalForm = $<HTMLFormElement>('settings-form');
  const isCurrent = () => $<HTMLDialogElement>('settings-dialog').open && document.getElementById('settings-form') === originalForm;
  $<HTMLSelectElement>('appearance-mode').addEventListener('change', async (event) => {
    if (requestBusy) { renderAppearance(); return; }
    const mode = appearanceMode((event.currentTarget as HTMLSelectElement).value);
    $('appearance-error').textContent = '';
    if (!await mutate('/api/appearance', { mode }) && isCurrent()) $('appearance-error').textContent = localError;
  });
  $('test-connection').addEventListener('click', async () => {
    if (connectionProbe) { connectionProbe.abort(); return; }
    if (state.running || requestBusy || !originalForm.reportValidity()) return;
    const controller = new AbortController();
    connectionProbe = controller;
    const form = new FormData(originalForm);
    const payload = { baseUrl: String(form.get('baseUrl') || '').trim(), model: String(form.get('model') || '').trim(), apiKey: String(form.get('apiKey') || '').trim() };
    const button = $<HTMLButtonElement>('test-connection');
    button.textContent = 'Cancel test';
    $<HTMLButtonElement>('save-settings').disabled = true;
    $('connection-test-result').textContent = 'Testing streaming and tool calling…';
    try {
      const response = await fetch('/api/test-connection', { method: 'POST', headers: headers(true), body: JSON.stringify(payload), signal: controller.signal, credentials: 'same-origin' });
      const result = await response.json();
      if (!isCurrent() || connectionProbe !== controller) return;
      if (!response.ok) throw new Error(result.error || 'Connection test failed.');
      $('connection-test-result').textContent = result.message;
      $('connection-test-result').className = result.ok ? 'test-success' : 'form-error';
    } catch (error) {
      if (isCurrent() && connectionProbe === controller) {
        $('connection-test-result').textContent = controller.signal.aborted ? 'Test cancelled.' : error instanceof Error ? error.message : String(error);
        $('connection-test-result').className = 'form-error';
      }
    } finally {
      if (connectionProbe === controller) { connectionProbe = null; if (isCurrent()) { button.textContent = 'Test connection'; $<HTMLButtonElement>('save-settings').disabled = false; } }
    }
  });
  originalForm.addEventListener('input', (event) => {
    if ((event.target as HTMLElement).id === 'appearance-mode') return;
    connectionProbe?.abort();
    $('connection-test-result').textContent = '';
  });
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (requestBusy || connectionProbe) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const apiKey = String(form.get('apiKey') || '').trim();
    const payload = { baseUrl: String(form.get('baseUrl')).trim(), model: String(form.get('model')).trim(), ...(apiKey ? { apiKey } : {}) };
    $<HTMLButtonElement>('save-settings').disabled = true;
    const saved = await mutate('/api/config', payload);
    if (!isCurrent()) return;
    if (!saved) $('settings-error').textContent = localError;
    $<HTMLInputElement>('api-key').value = '';
    $<HTMLButtonElement>('save-settings').disabled = false;
    if (saved) $<HTMLDialogElement>('settings-dialog').close();
  });
  document.getElementById('remove-key')?.addEventListener('click', async () => {
    if (requestBusy) return;
    const removed = await mutate('/api/config', { baseUrl: state.settings.baseUrl, model: state.settings.model, clearApiKey: true });
    if (!isCurrent()) return;
    if (removed) $<HTMLDialogElement>('settings-dialog').close();
    else $('settings-error').textContent = localError;
  });
}

function openWorkspace(): void {
  closeSidebar();
  $('workspace-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">A PLACE TO WORK</span><h2>Workspaces</h2></div><button class="quiet-icon" data-close="workspace-dialog" aria-label="Close workspaces">${icon('close')}</button></div><p class="modal-description">Choose a local folder. Conversations belong to a workspace,<br>so Pith knows where to read and create files.</p><div class="modal-workspaces">${state.workspaces.map((entry) => `<button class="modal-workspace" data-modal-workspace="${escape(entry.id)}">${icon('folder')}<span><strong>${escape(entry.name)}</strong><small>${escape(entry.path)}</small></span>${icon('chevron')}</button>`).join('')}</div><div class="workspace-add"><button class="picker-button" id="pick-folder" type="button">${icon('folder')}Choose a folder…</button><div class="path-divider"><span>or enter a folder path</span></div><form id="workspace-form"><label class="sr-only" for="workspace-path">Absolute folder path</label><input id="workspace-path" name="path" placeholder="/Users/you/Documents/my-work" required autocomplete="off" spellcheck="false" /><p class="field-hint">Use an existing folder on this computer. Pith will work inside it.</p><div id="workspace-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="workspace-dialog">Cancel</button><button class="primary-button" id="add-workspace" type="submit">Add workspace</button></div></form></div>`;
  $<HTMLDialogElement>('workspace-dialog').showModal();
  $('workspace-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await addWorkspace($<HTMLInputElement>('workspace-path').value.trim());
  });
  $('pick-folder').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('pick-folder');
    button.disabled = true;
    $('workspace-error').textContent = '';
    try {
      const result = await request<{ path?: string }>('/api/pick-workspace', {});
      if (result.path) { $<HTMLInputElement>('workspace-path').value = result.path; await addWorkspace(result.path); }
    } catch (error) {
      $('workspace-error').textContent = `${error instanceof Error ? error.message : String(error)} You can enter the path below.`;
      $<HTMLInputElement>('workspace-path').focus();
    } finally { button.disabled = false; }
  });
}

async function addWorkspace(path: string): Promise<void> {
  if (!path) return;
  $<HTMLButtonElement>('add-workspace').disabled = true;
  let workspaceId = '';
  if (await mutate<{ ok: true; workspace: Workspace }>('/api/workspaces', { path }, (response) => {
    if (!response?.workspace?.id) throw new Error('The local service did not return the added workspace.');
    workspaceId = response.workspace.id;
  })) {
    selectedWorkspaceId = workspaceId;
    $<HTMLDialogElement>('workspace-dialog').close();
    if (!state.running) await newConversation(workspaceId);
    else render();
  } else $('workspace-error').textContent = localError;
  $<HTMLButtonElement>('add-workspace').disabled = false;
}

function closeSidebar(): void { $('sidebar').classList.remove('open'); $('sidebar-scrim').classList.remove('visible'); }
function renderDraftImages(): void {
  $('draft-images').hidden = !draftImages.length;
  $('draft-images').innerHTML = draftImages.map((image) => `<figure class="draft-image"><img src="${escape(image.url)}" alt="${escape(image.name)}" /><figcaption>${escape(image.name)}</figcaption><button type="button" class="remove-image" data-remove-image="${image.id}" aria-label="Remove ${escape(image.name)}" ${requestBusy || readingImages ? 'disabled' : ''}>${icon('close')}</button></figure>`).join('');
  $<HTMLButtonElement>('attach-images').disabled = requestBusy || readingImages || !snapshotLoaded;
  const guidance = $('image-guidance');
  guidance.hidden = !draftImages.length;
  guidance.textContent = state.settings.supportsImages
    ? 'Images are saved with this conversation and sent to your configured model provider. Up to 20 MiB total per message.'
    : 'This model does not support images. Choose an image-capable model in Settings, or remove the attachments.';
}

function clearDraftImages(ids?: Set<string>): void {
  if (!ids) draftGeneration++;
  draftImages = draftImages.filter((image) => {
    if (ids && !ids.has(image.id)) return true;
    URL.revokeObjectURL(image.url);
    return false;
  });
}

async function addImageFiles(files: File[]): Promise<void> {
  if (!files.length || requestBusy || readingImages) return;
  readingImages = true;
  localError = '';
  render();
  const added: DraftImage[] = [];
  const generation = draftGeneration;
  try {
    const limit = state.settings.imageUploadLimit || 20 * 1024 * 1024;
    if (draftImages.reduce((sum, image) => sum + image.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > limit) throw new Error('Image attachments must total 20 MiB or less per message.');
    for (const file of files) {
      const mimeType = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[file.name.split('.').pop()?.toLowerCase() || ''];
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) || !file.size) throw new Error('Use nonempty PNG, JPEG, GIF or WebP images.');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
        reader.readAsDataURL(file);
      });
      added.push({ id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(''), type: 'image', data, mimeType, name: file.name || 'Pasted image', size: file.size, url: URL.createObjectURL(file) });
    }
    if (disposed || generation !== draftGeneration) { for (const image of added) URL.revokeObjectURL(image.url); return; }
    draftImages.push(...added);
  } catch (error) {
    for (const image of added) URL.revokeObjectURL(image.url);
    localError = error instanceof Error ? error.message : String(error);
  } finally { readingImages = false; render(); }
}

function clearHistoryImages(): void {
  imageGeneration++;
  for (const value of historyImages.values()) void value.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  historyImages.clear();
}

function loadHistoryImages(): void {
  for (const image of $('messages').querySelectorAll<HTMLImageElement>('img[data-image-key]')) {
    const key = image.dataset.imageKey!;
    let value = historyImages.get(key);
    if (!value) {
      const generation = imageGeneration;
      const params = new URLSearchParams({ id: state.activeId || '', message: image.dataset.messageId!, index: image.dataset.imageIndex! });
      value = fetch(`/api/image?${params}`, { headers: headers(), credentials: 'same-origin' }).then(async (response) => {
        if (!response.ok) throw new Error('Image attachment could not be loaded.');
        const blob = await response.blob();
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type)) throw new Error('Invalid image attachment.');
        if (generation !== imageGeneration || disposed) throw new Error('Conversation changed.');
        return URL.createObjectURL(blob);
      });
      historyImages.set(key, value);
      const pending = value;
      void pending.catch(() => { if (historyImages.get(key) === pending) historyImages.delete(key); });
    }
    void value.then((url) => { if (image.isConnected) image.src = url; }).catch(() => { if (image.isConnected) { image.alt = 'Image unavailable'; image.classList.add('image-unavailable'); } });
  }
}

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
$('composer-form').addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); if (!requestBusy && !readingImages) $('composer-form').classList.add('drag-images'); }
});
$('composer-form').addEventListener('dragleave', () => $('composer-form').classList.remove('drag-images'));
$('composer-form').addEventListener('drop', (event) => {
  event.preventDefault();
  $('composer-form').classList.remove('drag-images');
  void addImageFiles(Array.from(event.dataTransfer?.files || []));
});

function resizeComposer(): void { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button, .brand');
  if (!target) return;
  if (target.dataset.removeImage) { if (!requestBusy && !readingImages) { clearDraftImages(new Set([target.dataset.removeImage])); render(); } return; }
  if (target.dataset.close) { $<HTMLDialogElement>(target.dataset.close).close(); return; }
  if (target.classList.contains('brand')) { event.preventDefault(); input.focus(); return; }
  if (target.dataset.historyFilter) { historyArchived = target.dataset.historyFilter === 'archived'; renderHistory(); return; }
  if (target.dataset.fileKind && target.dataset.filePath && target.dataset.fileOwner) {
    if (requestBusy || state.running) return;
    const kind = target.dataset.fileKind;
    const payload = { kind, ...(kind === 'resource' ? { workspaceId: target.dataset.fileOwner } : { id: target.dataset.fileOwner }), path: target.dataset.filePath, action: target.dataset.fileAction };
    if (!await mutate('/api/file', payload) && kind === 'resource') $('resources-error').textContent = localError;
    return;
  }
  if (target.dataset.mcpEdit) { const entry = mcpConnections.find((item) => item.name === target.dataset.mcpEdit); if (entry) editMCP(entry); return; }
  if (target.dataset.mcpToggle || target.dataset.mcpRemove) {
    if (requestBusy || state.running) return;
    const entry = mcpConnections.find((item) => item.name === (target.dataset.mcpToggle || target.dataset.mcpRemove));
    if (!entry) return;
    $('mcp-error').textContent = '';
    const ok = target.dataset.mcpRemove ? await mutate('/api/mcp/remove', { name: entry.name }) : await mutate('/api/mcp/save', { name: entry.name, type: entry.type, url: entry.url, command: entry.command, args: entry.args || [], enabled: !entry.enabled });
    if (ok) { await loadMCP(); if (target.dataset.mcpRemove && $<HTMLInputElement>('mcp-name').value === entry.name) editMCP(); }
    else $('mcp-error').textContent = localError;
    return;
  }
  if (target.dataset.prompt) { input.value = target.dataset.prompt; resizeComposer(); render(); input.focus(); return; }
  if (target.dataset.conversation) {
    if (state.running) { localError = 'Stop the current run before switching conversations.'; render(); return; }
    if (await mutate('/api/open', { id: target.dataset.conversation })) clearDraftImages(); render(); closeSidebar(); return;
  }
  if (target.dataset.workspace || target.dataset.modalWorkspace) {
    const id = target.dataset.workspace || target.dataset.modalWorkspace!;
    if (state.running) { localError = 'Stop the current run before switching workspaces.'; render(); return; }
    selectedWorkspaceId = id;
    if (target.dataset.modalWorkspace) $<HTMLDialogElement>('workspace-dialog').close();
    const conversation = state.conversations.filter((entry) => entry.workspaceId === id && !entry.archived).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    if (conversation) await mutate('/api/open', { id: conversation.id });
    else await newConversation(id);
    closeSidebar(); return;
  }
  if (target.dataset.approval && state.pendingApproval) {
    const approval = state.pendingApproval;
    if (target.dataset.approvalId !== approval.id) {
      localError = 'This tool request has changed. Review the current request before allowing it.';
      render();
      return;
    }
    const alwaysAllow = target.dataset.approval === 'always';
    if (alwaysAllow && approval.toolName !== 'write_file' && approval.toolName !== 'edit_file') return;
    await mutate('/api/approval', { id: approval.id, allow: target.dataset.approval !== 'deny', ...(alwaysAllow ? { alwaysAllow: true } : {}) });
    return;
  }
  switch (target.dataset.action) {
    case 'new': await newConversation(); break;
    case 'settings': openSettings(); break;
    case 'continue': if (!state.running && state.activeId && state.failure?.canContinue) await mutate('/api/continue', { id: state.activeId }); break;
    case 'attach-images': if (!requestBusy && !readingImages) $<HTMLInputElement>('image-picker').click(); break;
    case 'diagnostics': await exportDiagnostics(); break;
    case 'workspace': openWorkspace(); break;
    case 'resources': openResources(); break;
    case 'connections': openConnections(); break;
    case 'rename': $<HTMLDetailsElement>('conversation-menu').open = false; openRename(); break;
    case 'archive': {
      $<HTMLDetailsElement>('conversation-menu').open = false;
      const conversation = state.conversations.find((entry) => entry.id === state.activeId);
      if (!conversation || state.running) break;
      const archived = !conversation.archived;
      if (await mutate('/api/archive', { id: conversation.id, archived })) { historyArchived = archived; renderHistory(); }
      break;
    }
    case 'export': $<HTMLDetailsElement>('conversation-menu').open = false; await exportConversation(); break;
    case 'refresh-resources': await loadResources(); break;
    case 'create-instructions':
      if (state.running || requestBusy) break;
      if (await mutate('/api/create-instructions', { workspaceId: resourcesWorkspaceId })) await loadResources();
      else $('resources-error').textContent = localError;
      break;
    case 'refresh-mcp': await loadMCP(); break;
    case 'new-mcp': editMCP(); break;
    case 'toggle-env': {
      const revealed = $<HTMLTextAreaElement>('mcp-env').classList.toggle('revealed');
      $('mcp-env-visibility').setAttribute('aria-pressed', String(revealed));
      $('mcp-env-visibility').textContent = revealed ? 'Hide' : 'Show';
      break;
    }
    case 'connect-mcp':
    case 'disconnect-mcp': {
      if (state.running || requestBusy) break;
      $('mcp-error').textContent = '';
      const connecting = target.dataset.action === 'connect-mcp';
      if (connecting) { mcpConnections = mcpConnections.map((entry) => entry.enabled ? { ...entry, status: 'connecting', error: undefined } : entry); renderMCPList(); }
      const ok = await mutate(connecting ? '/api/mcp/connect' : '/api/mcp/disconnect', {});
      const error = localError;
      await loadMCP();
      if (!ok) $('mcp-error').textContent = error;
      break;
    }
    case 'stop': await mutate('/api/abort', {}); break;
    case 'menu': $('sidebar').classList.add('open'); $('sidebar-scrim').classList.add('visible'); break;
  }
});

$('sidebar-scrim').addEventListener('click', closeSidebar);
$<HTMLInputElement>('history-search').addEventListener('input', (event) => { historySearch = (event.currentTarget as HTMLInputElement).value; renderHistory(); });
$<HTMLSelectElement>('queue-mode').addEventListener('change', render);
$('composer-form').addEventListener('submit', (event) => { event.preventDefault(); void send(); });
input.addEventListener('input', () => { resizeComposer(); render(); });
$<HTMLSelectElement>('permission-mode').addEventListener('change', async (event) => {
  const mode = (event.currentTarget as HTMLSelectElement).value as PermissionMode;
  const id = state.activeId;
  renderPermissions();
  if (!id || requestBusy || mode === activePermissionMode()) return;
  if (mode === 'full-access') confirmFullAccess(id);
  else await mutate('/api/permissions', { id, mode });
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); void newConversation(); }
});
for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
  if (dialog.id === 'permissions-dialog') dialog.addEventListener('close', () => { fullAccessTargetId = null; });
  dialog.addEventListener('close', () => {
    if (dialog.id === 'settings-dialog') { connectionProbe?.abort(); connectionProbe = null; const key = document.getElementById('api-key') as HTMLInputElement | null; if (key) key.value = ''; }
    if (dialog.id === 'connections-dialog') { mcpRequest++; const key = document.getElementById('mcp-token') as HTMLInputElement | null; if (key) key.value = ''; const env = document.getElementById('mcp-env') as HTMLTextAreaElement | null; if (env) env.value = ''; }
    if (dialog.id === 'resources-dialog') resourcesRequest++;
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
}

async function streamEvents(): Promise<void> {
  let retryDelay = 700;
  while (!disposed) {
    try {
      await new Promise<void>((resolve, reject) => {
        const url = new URL('/api/socket', window.location.href);
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const protocols = token ? ['pith-desk', `bearer.${token}`] : ['pith-desk'];
        const socket = new WebSocket(url.href, protocols);
        eventSocket = socket;
        let transportError = '';
        socket.onopen = () => {
          if (disposed) { socket.close(); return; }
          connection = 'connected';
          if (!snapshotLoaded) localError = '';
          render();
        };
        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            if (typeof event.data !== 'string') throw new Error('The local service returned an invalid event.');
            setState(JSON.parse(event.data) as State);
            retryDelay = 700;
          } catch (error) {
            transportError = error instanceof Error ? error.message : String(error);
            socket.close(1003, 'Invalid state');
          }
        };
        socket.onerror = () => { transportError = 'Could not connect to the local event service.'; };
        socket.onclose = () => {
          if (eventSocket === socket) eventSocket = null;
          if (disposed) resolve();
          else reject(new Error(transportError || 'The local event connection closed.'));
        };
      });
    } catch (error) {
      if (disposed) return;
      connection = 'reconnecting';
      if (!snapshotLoaded) localError = error instanceof Error ? error.message : String(error);
      render();
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 1.6, 10000);
      try { await refresh(); } catch { /* The connection indicator already explains the reconnect. */ }
    }
  }
}

window.addEventListener('beforeunload', () => { disposed = true; clearDraftImages(); clearHistoryImages(); eventSocket?.close(); });
systemAppearance.addEventListener('change', () => {
  if (appearanceMode(state.settings.appearance) === 'system') applyAppearance('system');
});
render();
void refresh().catch((error) => { localError = error instanceof Error ? error.message : String(error); render(); }).finally(() => { void streamEvents(); });
