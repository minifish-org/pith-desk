import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';

interface Workspace { id: string; name: string; path: string }
type AppearanceMode = 'system' | 'light' | 'dark';
type PermissionMode = 'ask' | 'workspace-write' | 'full-access';
interface Conversation { id: string; title: string; workspaceId: string; updatedAt: string | number; permissionMode?: PermissionMode }
interface Message { id: string; role: string; text: string; toolName?: string; status?: string }
interface Approval { id: string; toolName: string; args: unknown; warning?: string }
interface State {
  settings: { baseUrl: string; model: string; hasApiKey: boolean; appearance?: AppearanceMode };
  workspaces: Workspace[];
  conversations: Conversation[];
  activeId: string | null;
  messages: Message[];
  running: boolean;
  pendingApproval?: Approval | null;
  error?: string | null;
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
  workspaces: [], conversations: [], activeId: null, messages: [], running: false,
};
let selectedWorkspaceId = '';
let snapshotLoaded = false;
let connection: 'connecting' | 'connected' | 'reconnecting' = 'connecting';
let requestBusy = false;
let localError = '';
let messagesSignature = '';
let renderedActiveId: string | null = null;
let approvalSignature = '';
let eventSocket: WebSocket | null = null;
let disposed = false;
let fullAccessTargetId: string | null = null;

const paths: Record<string, string> = {
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
    <nav id="history-list" class="history-list" aria-label="Conversation history"></nav>
    <div class="sidebar-bottom">
      <button class="settings-button" data-action="settings">${icon('settings')}<span>Settings</span></button>
      <div class="local-status"><span id="connection-dot" class="status-dot connecting"></span><span id="connection-text">Connecting to local service</span></div>
    </div>
  </aside>
  <div class="sidebar-scrim" id="sidebar-scrim"></div>
  <main class="main">
    <header class="topbar">
      <button class="quiet-icon mobile-menu" data-action="menu" aria-label="Open sidebar">${icon('menu')}</button>
      <div class="breadcrumb">${icon('folder')}<span id="workspace-label">No workspace</span>${icon('chevron', 'breadcrumb-chevron')}<span class="breadcrumb-current" id="conversation-label">New conversation</span></div>
      <button class="model-pill" data-action="settings"><span class="model-indicator"></span><span id="model-label">deepseek-flash</span>${icon('down')}</button>
    </header>
    <section id="chat-scroll" class="chat-scroll" aria-label="Conversation">
      <div id="welcome" class="welcome"></div>
      <div id="messages" class="messages" aria-live="polite" aria-relevant="additions text"></div>
    </section>
    <div class="composer-region">
      <div id="approval" class="approval-region"></div>
      <div id="inline-error" class="inline-error" role="alert" hidden></div>
      <form id="composer-form" class="composer">
        <textarea id="composer-input" rows="1" placeholder="Ask Pith to help with your work…" aria-label="Message Pith"></textarea>
        <div class="composer-toolbar">
          <div class="composer-context">
            <button type="button" class="workspace-chip" data-action="workspace">${icon('folder')}<span id="composer-workspace">Select workspace</span>${icon('down')}</button>
            <label class="permission-control" id="permission-control">${icon('shield')}<span class="sr-only">Conversation permissions</span><select id="permission-mode" aria-describedby="permission-description"><option value="ask">Ask before changes</option><option value="workspace-write">Allow workspace changes</option><option value="full-access">Full access</option></select>${icon('down')}</label>
          </div>
          <div class="composer-actions"><span class="keyboard-hint">↵ to send</span><button id="send-button" class="send-button" type="submit" aria-label="Send message">${icon('arrow')}</button><button id="stop-button" class="stop-button" type="button" data-action="stop" aria-label="Stop agent" hidden>${icon('stop')}<span>Stop</span></button></div>
        </div>
      </form>
      <p class="composer-note" id="permission-description">Pith can read workspace files. Changes and commands require your approval.</p>
    </div>
  </main>
  <dialog id="settings-dialog" class="modal"><div id="settings-content"></div></dialog>
  <dialog id="workspace-dialog" class="modal"><div id="workspace-content"></div></dialog>
  <dialog id="permissions-dialog" class="modal permission-modal" aria-labelledby="full-access-title"><div id="permissions-content"></div></dialog>
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
  const conversations = [...state.conversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  $('history-list').innerHTML = conversations.length ? conversations.map((entry) => `
    <button class="history-item ${entry.id === state.activeId ? 'active' : ''}" data-conversation="${escape(entry.id)}" title="${escape(entry.title || 'Untitled conversation')}">${icon('chat')}<span>${escape(entry.title || 'Untitled conversation')}</span></button>`).join('') : '<p class="history-empty">A little space for<br>your next good idea.</p>';

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
    if (nearBottom || changedConversation) requestAnimationFrame(() => chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: changedConversation ? 'instant' : 'smooth' }));
  }

  renderApproval();
  const error = localError || state.error || '';
  $('inline-error').hidden = !error;
  $('inline-error').textContent = error;
  $('connection-dot').className = `status-dot ${connection}`;
  $('connection-text').textContent = connection === 'connected' ? 'Local service connected' : connection === 'reconnecting' ? 'Reconnecting to local service' : 'Connecting to local service';
  $('stop-button').hidden = !state.running;
  $('send-button').hidden = state.running;
  $<HTMLButtonElement>('send-button').disabled = !snapshotLoaded || requestBusy || !input.value.trim() || !workspace || !state.settings.hasApiKey;
  input.placeholder = !snapshotLoaded ? 'Connecting to Pith…' : !state.settings.hasApiKey ? 'Connect your model in Settings to get started' : !workspace ? 'Choose a workspace to get started' : state.running ? 'Pith is working. You can prepare your next message…' : 'Ask Pith to help with your work…';
  $<HTMLButtonElement>('stop-button').disabled = requestBusy;
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
  if (message.role === 'tool') return `<details class="tool-message" ${message.status === 'running' ? 'open' : ''}><summary>${icon('terminal')}<span>${escape(message.toolName || 'Tool result')}</span><span class="tool-status">${escape(message.status || 'Result')}</span>${icon('down')}</summary><pre>${escape(text)}</pre></details>`;
  if (message.role === 'user') return `<article class="message user-message"><div class="message-content"><div class="message-label">You</div><div class="user-text">${escape(text)}</div></div></article>`;
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
  $('approval').innerHTML = approval ? `<section class="approval-card" aria-label="Tool approval required"><div class="approval-heading">${icon('shield')}<div><strong>Pith needs your permission</strong><span>Review this action before it runs.</span></div><span class="approval-badge">${escape(approval.toolName)}</span></div>${warning ? `<p class="approval-warning">${escape(warning)}</p>` : ''}<pre>${escape(typeof approval.args === 'string' ? approval.args : JSON.stringify(approval.args, null, 2))}</pre>${canAlwaysAllow ? '<p class="approval-scope">Workspace permission applies to this conversation. Commands still need approval.</p>' : ''}<div class="approval-actions"><button class="secondary-button" data-approval="deny" ${requestBusy ? 'disabled' : ''}>Deny</button>${canAlwaysAllow ? `<button class="secondary-button always-allow-button" data-approval="always" ${requestBusy ? 'disabled' : ''}>Always allow workspace changes</button>` : ''}<button class="primary-button" data-approval="allow" ${requestBusy ? 'disabled' : ''}>${icon('check')}Allow this action</button></div></section>` : '';
  for (const button of $('approval').querySelectorAll<HTMLButtonElement>('[data-approval]')) button.dataset.approvalId = approval?.id || '';
}

function renderPermissions(): void {
  const mode = activePermissionMode();
  const selector = $<HTMLSelectElement>('permission-mode');
  selector.value = mode;
  selector.disabled = !snapshotLoaded || !state.activeId || requestBusy;
  $('permission-control').classList.toggle('full-access', mode === 'full-access');
  const descriptions: Record<PermissionMode, string> = {
    ask: 'Pith can read workspace files. Changes and commands require your approval.',
    'workspace-write': 'Workspace file changes are allowed in this conversation. Commands still require approval.',
    'full-access': 'Full access: commands can use your files and network beyond this workspace. There is no OS sandbox.',
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
  $('permissions-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">CONVERSATION PERMISSIONS</span><h2 id="full-access-title">Enable full access?</h2></div><button class="quiet-icon" data-close="permissions-dialog" aria-label="Cancel full access">${icon('close')}</button></div><p class="modal-description">Give Pith permission to run all tools without asking in <strong>${escape(conversation?.title || 'this conversation')}</strong>.</p><div class="full-access-explanation">${icon('shield')}<div><strong>This is access to your computer account.</strong><p>Commands can read, change, or delete files outside the workspace and access the network with your normal operating system permissions. There is no OS sandbox.</p></div></div><p class="permission-revoke-note">This applies only to the current conversation and stays enabled across app restarts until you revoke it. To revoke it, choose “Ask before changes” or “Allow workspace changes” in the composer.</p><div id="permissions-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="permissions-dialog">Cancel</button><button class="primary-button full-access-confirm" id="enable-full-access" type="button">Enable full access</button></div>`;
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
  state = next;
  snapshotLoaded = true;
  render();
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

async function mutate(path: string, payload: unknown): Promise<boolean> {
  if (requestBusy) return false;
  requestBusy = true;
  localError = '';
  render();
  try {
    await request(path, payload);
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
    input.value = '';
    resizeComposer();
    closeSidebar();
    input.focus();
  }
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || state.running || requestBusy) return;
  if (!state.settings.hasApiKey) { openSettings(); return; }
  if (!selectedWorkspace()) { openWorkspace(); return; }
  if (!state.activeId && !await mutate('/api/conversations', { workspaceId: selectedWorkspace()!.id })) return;
  if (await mutate('/api/send', { text })) {
    input.value = '';
    resizeComposer();
    render();
    chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: 'smooth' });
  }
}

function openSettings(): void {
  closeSidebar();
  const appearanceSection = `<section class="appearance-settings" aria-labelledby="appearance-title"><div><h3 id="appearance-title">Appearance</h3><p class="appearance-hint" id="appearance-hint">A bright white workspace or a calm dark one, both with a blue accent. Follow system matches your computer.</p></div><label class="sr-only" for="appearance-mode">Appearance</label><select id="appearance-mode" class="appearance-select" aria-describedby="appearance-hint"><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select><div id="appearance-error" class="form-error" role="alert"></div></section>`;
  $('settings-content').innerHTML = `<div class="modal-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2>Settings</h2></div><button class="quiet-icon" data-close="settings-dialog" aria-label="Close settings">${icon('close')}</button></div>${appearanceSection}<p class="modal-description">Connect DeepSeek or an OpenAI-compatible provider.<br>Your key is kept by the local Pith service.</p><form id="settings-form"><label class="field-label" for="base-url">API base URL</label><div class="input-with-icon">${icon('globe')}<input id="base-url" name="baseUrl" type="url" required value="${escape(state.settings.baseUrl || 'https://api.deepseek.com/v1')}" placeholder="https://api.deepseek.com/v1" autocomplete="off" /></div><label class="field-label" for="model-name">Model</label><input id="model-name" name="model" required value="${escape(state.settings.model || 'deepseek-flash')}" placeholder="deepseek-flash" autocomplete="off" /><label class="field-label" for="api-key">API key ${state.settings.hasApiKey ? '<span class="configured-badge">Configured</span>' : ''}</label><input id="api-key" name="apiKey" type="password" placeholder="${state.settings.hasApiKey ? 'Leave blank to keep your current key' : 'Paste your API key'}" autocomplete="new-password" ${state.settings.hasApiKey ? '' : 'required'} /><p class="field-hint">The saved key is never returned to this page. Model requests go to your configured provider.</p>${state.settings.hasApiKey ? '<button class="remove-key" id="remove-key" type="button">Remove saved API key</button>' : ''}<div id="settings-error" class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-close="settings-dialog">Cancel</button><button class="primary-button" id="save-settings" type="submit">Save settings</button></div></form>`;
  renderAppearance();
  $<HTMLDialogElement>('settings-dialog').showModal();
  $<HTMLSelectElement>('appearance-mode').addEventListener('change', async (event) => {
    const mode = appearanceMode((event.currentTarget as HTMLSelectElement).value);
    $('appearance-error').textContent = '';
    if (!await mutate('/api/appearance', { mode })) $('appearance-error').textContent = localError;
  });
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const apiKey = String(form.get('apiKey') || '').trim();
    const payload = { baseUrl: String(form.get('baseUrl')).trim(), model: String(form.get('model')).trim(), ...(apiKey ? { apiKey } : {}) };
    $<HTMLButtonElement>('save-settings').disabled = true;
    if (await mutate('/api/config', payload)) $<HTMLDialogElement>('settings-dialog').close();
    else $('settings-error').textContent = localError;
    $<HTMLInputElement>('api-key').value = '';
    $<HTMLButtonElement>('save-settings').disabled = false;
  });
  document.getElementById('remove-key')?.addEventListener('click', async () => {
    if (await mutate('/api/config', { baseUrl: state.settings.baseUrl, model: state.settings.model, clearApiKey: true })) $<HTMLDialogElement>('settings-dialog').close();
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
  if (await mutate('/api/workspaces', { path })) {
    const workspace = state.workspaces.find((entry) => entry.path === path) ?? state.workspaces[state.workspaces.length - 1];
    if (workspace) selectedWorkspaceId = workspace.id;
    $<HTMLDialogElement>('workspace-dialog').close();
    if (workspace && !state.running) await newConversation(workspace.id);
    else render();
  } else $('workspace-error').textContent = localError;
  $<HTMLButtonElement>('add-workspace').disabled = false;
}

function closeSidebar(): void { $('sidebar').classList.remove('open'); $('sidebar-scrim').classList.remove('visible'); }
function resizeComposer(): void { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; }

document.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button, .brand');
  if (!target) return;
  if (target.dataset.close) { $<HTMLDialogElement>(target.dataset.close).close(); return; }
  if (target.classList.contains('brand')) { event.preventDefault(); input.focus(); return; }
  if (target.dataset.prompt) { input.value = target.dataset.prompt; resizeComposer(); render(); input.focus(); return; }
  if (target.dataset.conversation) {
    if (state.running) { localError = 'Stop the current run before switching conversations.'; render(); return; }
    await mutate('/api/open', { id: target.dataset.conversation }); closeSidebar(); return;
  }
  if (target.dataset.workspace || target.dataset.modalWorkspace) {
    const id = target.dataset.workspace || target.dataset.modalWorkspace!;
    if (state.running) { localError = 'Stop the current run before switching workspaces.'; render(); return; }
    selectedWorkspaceId = id;
    if (target.dataset.modalWorkspace) $<HTMLDialogElement>('workspace-dialog').close();
    const conversation = state.conversations.filter((entry) => entry.workspaceId === id).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
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
    case 'workspace': openWorkspace(); break;
    case 'stop': await mutate('/api/abort', {}); break;
    case 'menu': $('sidebar').classList.add('open'); $('sidebar-scrim').classList.add('visible'); break;
  }
});

$('sidebar-scrim').addEventListener('click', closeSidebar);
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
  dialog.addEventListener('close', () => { const key = document.getElementById('api-key') as HTMLInputElement | null; if (key) key.value = ''; });
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

window.addEventListener('beforeunload', () => { disposed = true; eventSocket?.close(); });
systemAppearance.addEventListener('change', () => {
  if (appearanceMode(state.settings.appearance) === 'system') applyAppearance('system');
});
render();
void refresh().catch((error) => { localError = error instanceof Error ? error.message : String(error); render(); }).finally(() => { void streamEvents(); });
