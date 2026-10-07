import type { State, ProviderChoice } from './main';

type Resource = { name: string; path: string; description?: string; content?: string };
type ModelDefinition = { id: string; name?: string; reasoning?: boolean; input?: string[]; contextWindow: number; maxTokens: number; cost?: Record<string, number>; [key: string]: unknown };
type CustomConnection = { id?: string; name: string; baseUrl: string; api: string; models: ModelDefinition[] };
type API = {
  state: () => State;
  busy: () => boolean;
  request: <T>(path: string, payload?: unknown) => Promise<T>;
  mutate: (path: string, payload: unknown) => Promise<boolean>;
  error: () => string;
  workspaceBusy: (id: string) => boolean;
  workspace: () => { id: string; name: string; path: string } | undefined;
  draft: (text: string) => void;
  refreshResources: () => Promise<void>;
  settings: () => void;
  refreshMCP: () => Promise<void>;
};

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;

// These are host controls around SDK APIs, not another agent runtime.
export function createSDKUI(api: API) {
  document.body.insertAdjacentHTML('beforeend', '<dialog id="sdk-dialog" class="modal feature-modal"><div id="sdk-content"></div></dialog><dialog id="oauth-dialog" class="modal"><div id="oauth-content"></div></dialog>');
  let generation = 0;
  let loginSignature = '';
  let dismissedLogin = '';
  const heading = (title: string, id = 'sdk-dialog') => `<div class="modal-heading"><h2>${escape(title)}</h2><button class="quiet-icon" type="button" data-close="${id}" aria-label="Close">×</button></div>`;
  const open = (title: string, body: string) => {
    generation++;
    $('sdk-content').onclick = null;
    $('sdk-content').innerHTML = heading(title) + body + '<p id="sdk-error" class="form-error" role="alert"></p>';
    if (!$<HTMLDialogElement>('sdk-dialog').open) $<HTMLDialogElement>('sdk-dialog').showModal();
    return generation;
  };
  const fail = (message: string) => {
    const error = document.getElementById('sdk-error') || document.getElementById('settings-error') || document.getElementById('mcp-form-error');
    if (error) { error.textContent = message; error.scrollIntoView({ block: 'nearest' }); }
  };
  const act = async (path: string, payload: unknown) => {
    if (await api.mutate(path, payload)) return true;
    fail(api.error());
    return false;
  };

  async function custom(id?: string) {
    const seq = open(id ? 'Edit model connection' : 'Add model connection', '<p>Loading…</p>');
    const connection = id ? await api.request<CustomConnection>(`/api/custom-connection?id=${encodeURIComponent(id)}`) : { name: '', baseUrl: '', api: 'openai-completions', models: [{ id: '', contextWindow: 128000, maxTokens: 8192 }] };
    if (seq !== generation) return;
    const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'];
    open(id ? 'Edit model connection' : 'Add model connection', `<p class="modal-description">Give this endpoint its own name. It can coexist with official providers and other compatible endpoints.</p><form id="custom-form"><label class="field-label">Connection name<input id="custom-name" required value="${escape(connection.name)}" /></label><label class="field-label">API base URL<input id="custom-url" type="url" required value="${escape(connection.baseUrl)}" placeholder="https://example.com/v1" /></label><label class="field-label">API protocol<select id="custom-api" class="feature-select">${protocols.map((p) => `<option ${connection.api === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label class="field-label">API key<input id="custom-key" type="password" autocomplete="new-password" placeholder="${id ? 'Leave blank to keep the key at the same endpoint' : 'API key (optional for local endpoints)'}" /></label><div id="custom-models"></div><button type="button" class="secondary-button" id="add-custom-model">Add model</button><p class="field-hint">Limits and capabilities are provided by you. Prices are USD per million tokens. Fill all four rates (0 for free/unused), or leave all four blank for unknown prices.</p><div class="modal-footer"><button type="button" class="secondary-button" data-close="sdk-dialog">Cancel</button><button class="primary-button" type="submit">Save connection</button></div></form>`);
    const models = [...connection.models];
    const row = (model: ModelDefinition, index: number) => `<fieldset class="custom-model" data-model-index="${index}"><legend>Model ${index + 1}</legend><label>Model ID<input name="id" required value="${escape(model.id)}" /></label><label>Display name<input name="name" value="${escape(model.name || '')}" /></label><div class="sdk-grid"><label>Context tokens<input name="contextWindow" type="number" min="1" required value="${model.contextWindow}" /></label><label>Max output tokens<input name="maxTokens" type="number" min="1" required value="${model.maxTokens}" /></label></div><div class="sdk-grid"><label class="checkbox-field"><input name="reasoning" type="checkbox" ${model.reasoning ? 'checked' : ''} />Thinking effort</label><label class="checkbox-field"><input name="images" type="checkbox" ${model.input?.includes('image') ? 'checked' : ''} />Images</label></div><details class="provider-advanced"><summary>Price estimate (optional)</summary><div class="sdk-grid">${['input', 'output', 'cacheRead', 'cacheWrite'].map((rate) => `<label>${({ input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" } as Record<string, string>)[rate]}<input name="price-${rate}" type="number" min="0" step="any" value="${model.cost?.[rate] ?? ''}" /></label>`).join('')}</div></details><button type="button" class="text-button" data-remove-model>Remove model</button></fieldset>`;
    $('custom-models').innerHTML = models.map(row).join('');
    $('add-custom-model').onclick = () => { const i = models.length; const m = { id: '', contextWindow: 128000, maxTokens: 8192 }; models.push(m); $('custom-models').insertAdjacentHTML('beforeend', row(m, i)); };
    $('custom-models').onclick = (event) => { (event.target as HTMLElement).closest('[data-remove-model]')?.closest('fieldset')?.remove(); };
    $('custom-form').onsubmit = async (event) => {
      event.preventDefault();
      const fields = Array.from(document.querySelectorAll<HTMLFieldSetElement>('#custom-models fieldset'));
      for (const field of fields) {
        const rates = Array.from(field.querySelectorAll<HTMLInputElement>('[name^="price-"]')).map((input) => input.value);
        if (rates.some(Boolean) && rates.some((value) => value === '')) {
          fail('Enter all four rates, using 0 for a free or unused category, or leave all four blank for unknown prices.');
          return;
        }
      }
      const definitions = fields.map((field) => {
        const value = (name: string) => field.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
        const prices = ['input', 'output', 'cacheRead', 'cacheWrite'];
        const model: ModelDefinition = { ...models[Number(field.dataset.modelIndex)], id: value('id').value.trim(), name: value('name').value.trim(), contextWindow: Number(value('contextWindow').value), maxTokens: Number(value('maxTokens').value), reasoning: value('reasoning').checked, input: value('images').checked ? ['text', 'image'] : ['text'] };
        if (prices.some((p) => value(`price-${p}`).value !== '')) model.cost = { ...model.cost, ...Object.fromEntries(prices.map((p) => [p, Number(value(`price-${p}`).value || 0)])) }; else delete model.cost;
        return model;
      });
      if (await act('/api/custom-connection', { id, name: $<HTMLInputElement>('custom-name').value, baseUrl: $<HTMLInputElement>('custom-url').value, api: $<HTMLSelectElement>('custom-api').value, apiKey: $<HTMLInputElement>('custom-key').value, models: definitions })) { $<HTMLDialogElement>('sdk-dialog').close(); api.settings(); }
    };
  }

  async function resource(kind: string, path?: string) {
    const workspace = api.workspace(); if (!workspace) return;
    const seq = open(path ? 'Edit workspace resource' : `Create ${kind}`, '<p>Loading…</p>');
    const content = path ? (await api.request<{ content: string }>(`/api/resource-content?workspaceId=${encodeURIComponent(workspace.id)}&path=${encodeURIComponent(path)}`)).content : kind === 'skill' ? '---\nname: my-skill\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n' : kind === 'template' ? '---\ndescription: Describe this prompt.\n---\n\nHelp me with $@.\n' : '# Project instructions\n\n';
    if (seq !== generation) return;
    const editable = !api.workspaceBusy(workspace.id) && (!path || path.startsWith(workspace.path.replace(/\/$/, '') + '/'));
    open(editable ? (path ? 'Edit workspace resource' : `Create ${kind}`) : 'Workspace resource', `<p class="file-path">${escape(path || workspace.path)}</p>${!editable ? `<p>${api.workspaceBusy(workspace.id) ? 'Stop this workspace’s task before editing resources.' : 'Inherited instructions are read-only here. Add workspace instructions to specialize them.'}</p>` : ''}<form id="resource-form">${!path && kind !== 'instructions' ? '<label class="field-label">Name<input id="resource-name" required pattern="[A-Za-z0-9]([A-Za-z0-9_]|-)*" placeholder="my-resource" /></label>' : ''}<label class="field-label" for="resource-body">Markdown</label><textarea id="resource-body" class="resource-editor" ${!editable ? 'readonly' : ''}>${escape(content)}</textarea><div class="modal-footer">${path && editable ? '<button type="button" id="delete-resource" class="secondary-button destructive-button">Delete resource</button>' : ''}<button type="button" class="secondary-button" data-close="sdk-dialog">Close</button>${editable ? '<button type="submit" class="primary-button">Save</button>' : ''}</div></form>`);
    const save = async (remove = false) => {
      const name = ($('resource-name') as HTMLInputElement | null)?.value || '';
      let content = $<HTMLTextAreaElement>('resource-body').value;
      if (!path && kind === 'skill') content = content.replace(/^name: my-skill$/m, `name: ${name}`);
      if (await act('/api/resource', { workspaceId: workspace.id, kind, path: path || '', name, content, remove })) { $<HTMLDialogElement>('sdk-dialog').close(); await api.refreshResources(); }
    };
    $('resource-form').onsubmit = (e) => { e.preventDefault(); void save(); };
    const remove = document.getElementById('delete-resource');
    if (remove) remove.onclick = () => { remove.textContent = 'Confirm delete'; remove.onclick = () => void save(true); };
  }

  async function history() {
    const id = api.state().activeId; if (!id) return;
    const seq = open('Conversation branches', '<p>Loading history…</p>');
    const nodes = await api.request<{ id: string; parentId: string; role: string; text: string; active: boolean }[]>(`/api/history?id=${encodeURIComponent(id)}`);
    if (seq !== generation) return;
    open('Conversation branches', `<p class="modal-description">Continue from any saved message. Other branches remain available here; files and external actions are not undone.</p><div class="branch-list">${nodes.map((node) => `<article class="branch-node ${node.active ? 'current-branch' : ''}"><div class="connection-card-heading"><strong>${escape(node.role)}${node.active ? ' · current branch' : ''}</strong><button class="secondary-button" data-branch="${escape(node.id)}">Continue here</button></div><p>${escape(node.text.slice(0, 360) || '(Image or empty reply)')}</p></article>`).join('') || '<p>No history yet.</p>'}</div>`);
    $('sdk-content').onclick = async (event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-branch]'); if (target && await act('/api/branch', { id, nodeId: target.dataset.branch })) $<HTMLDialogElement>('sdk-dialog').close(); };
  }

  function render() {
    const state = api.state();
    const globalActions = new Set(['custom', 'login', 'logout', 'mcp-login', 'mcp-logout', 'remove-connection']);
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sdk]')) {
      if (globalActions.has(button.dataset.sdk || '')) button.disabled = api.busy() || state.runs.length > 0;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-sdk-idle]')) button.disabled = api.busy() || state.running || !state.activeId || (button.dataset.sdk === 'compact' && !state.messages.length);
    const login = state.login;
    if (!login || dismissedLogin === login.id) return;
    const signature = JSON.stringify(login);
    if (signature === loginSignature) return;
    loginSignature = signature;
    $('oauth-content').innerHTML = heading('Provider sign-in', 'oauth-dialog') + `<p>${escape(login.message)}</p>${login.url ? `<p><a href="${escape(login.url)}" target="_blank" rel="noopener noreferrer">Open sign-in page in your browser ↗</a></p>` : ''}${login.code ? `<p>Verification code: <strong>${escape(login.code)}</strong></p>` : ''}${login.phase === 'prompt' ? `<form id="oauth-answer"><label class="field-label" for="oauth-value">${escape(login.prompt)}</label>${login.options?.length ? `<select id="oauth-value" class="feature-select">${login.options.map((o) => `<option value="${escape(o.id)}">${escape(o.label)}</option>`).join('')}</select>` : `<input id="oauth-value" type="${login.promptType === 'secret' ? 'password' : 'text'}" required autocomplete="off" />`}<button type="submit" class="primary-button">Continue</button></form>` : ''}<div id="oauth-error" class="form-error" role="alert"></div><div class="modal-footer">${['complete', 'error'].includes(login.phase) ? '<button class="secondary-button" data-close="oauth-dialog">Close</button>' : '<button class="secondary-button" data-sdk="cancel-login">Cancel sign-in</button>'}</div>`;
    if (!$<HTMLDialogElement>('oauth-dialog').open) $<HTMLDialogElement>('oauth-dialog').showModal();
    const form = document.getElementById('oauth-answer');
    if (form) form.onsubmit = async (e) => { e.preventDefault(); if (!await api.mutate('/api/oauth/answer', { id: login.id, answer: $<HTMLInputElement>('oauth-value').value })) $('oauth-error').textContent = api.error(); };
  }

  document.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-sdk]');
    if (!target || target.disabled) return;
    try {
      switch (target.dataset.sdk) {
        case 'custom': await custom(target.dataset.id); break;
        case 'resource': await resource(target.dataset.kind || 'instructions', target.dataset.path); break;
        case 'use-resource': api.draft(target.dataset.command || ''); $<HTMLDialogElement>('resources-dialog').close(); break;
        case 'history': await history(); break;
        case 'branch':
          if (await api.mutate('/api/branch', { id: api.state().activeId, nodeId: target.dataset.node })) api.draft('');
          break;
        case 'compact': if (await act('/api/compact', { id: api.state().activeId })) $<HTMLDialogElement>('sdk-dialog').close(); break;
        case 'mcp-login': dismissedLogin = ''; await act('/api/mcp/oauth/start', { name: target.dataset.id }); break;
        case 'mcp-logout': if (await act('/api/mcp/oauth/logout', { name: target.dataset.id })) await api.refreshMCP(); break;
        case 'login': dismissedLogin = ''; await act('/api/oauth/start', { provider: target.dataset.id }); break;
        case 'logout': if (await act('/api/oauth/logout', { provider: target.dataset.id })) api.settings(); break;
        case 'cancel-login': await act('/api/oauth/cancel', {}); break;
        case 'remove-connection':
          if (target.dataset.confirm !== 'yes') { target.dataset.confirm = 'yes'; target.textContent = 'Confirm remove'; }
          else if (await act('/api/remove-model-connection', { id: target.dataset.id })) api.settings();
          break;
      }
    } catch (error) { fail(String(error)); }
  });
  $<HTMLDialogElement>('oauth-dialog').addEventListener('close', () => { dismissedLogin = api.state().login?.id || ''; if (api.state().login && !['complete', 'error'].includes(api.state().login!.phase)) void api.mutate('/api/oauth/cancel', {}); });
  $<HTMLDialogElement>('sdk-dialog').addEventListener('close', () => { generation++; $('sdk-content').innerHTML = ''; });

  return {
    render,
    providerActions(provider: ProviderChoice) {
      return `<div class="feature-toolbar">${provider.oauth ? `<button type="button" class="secondary-button" data-sdk="${provider.signedIn ? 'logout' : 'login'}" data-id="${escape(provider.id)}">${provider.signedIn ? 'Sign out' : 'Sign in with provider'}</button>` : ''}${provider.custom ? `<button type="button" class="secondary-button" data-sdk="custom" data-id="${escape(provider.id)}">Edit models and prices</button><button type="button" class="text-button destructive-button" data-sdk="remove-connection" data-id="${escape(provider.id)}">Remove connection</button>` : ''}</div>`;
    },
    resourceActions(kind: string, resource: Resource) {
      const command = kind === 'skill' ? `/skill:${resource.name} ` : `/${resource.name} `;
      return `<div class="file-actions">${kind !== 'instructions' ? `<button class="secondary-button" data-sdk="use-resource" data-command="${escape(command)}">Use</button>` : ''}<button class="secondary-button" data-sdk="resource" data-kind="${kind}" data-path="${escape(resource.path)}">View / edit</button></div>`;
    },
  };
}
