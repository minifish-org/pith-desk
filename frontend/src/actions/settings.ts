import {busy, mutate, request, setError} from './core.ts';
import {closeModalId, desk, modalId} from '@/stores/desk.ts';
import {app} from '@/lib/runtime.ts';
import {saveBlob} from '@/lib/save.ts';
import {selected} from './conversations.ts';
import type {ModelCatalog, ModelSelectionInput, ProviderChoice, UpdateStatus} from '@/contract.generated.ts';

export function openSettings(): void {
  desk().setNavigationOpen(false);
  desk().openModal({kind: 'settings', id: 'settings'});
}

export function openConnections(): void {
  desk().setNavigationOpen(false);
  desk().openModal({kind: 'connections', id: 'connections'});
}

export function openModels(): void {
  desk().openModal({kind: 'models', id: 'models'});
}

export function openCustomConnection(connectionId?: string): void {
  desk().openModal({kind: 'custom-connection', id: modalId('custom-connection'), connectionId});
}

export function openProviderLogin(provider: string): void {
  desk().openModal({kind: 'provider-login', id: `login-${provider}`, provider});
}

export async function loadModels(): Promise<ModelCatalog> {
  return request('/api/models');
}

export async function saveModelSelection(selection: ModelSelectionInput): Promise<boolean> {
  if (busy() || desk().state.runs.length > 0) return false;
  return mutate('/api/model-selection', selection);
}

export async function saveProviderConfig(draft: {provider: string; baseUrl: string; apiKey?: string}): Promise<boolean> {
  return mutate('/api/provider-config', draft);
}

export async function removeProviderKey(draft: {provider: string; baseUrl: string}): Promise<boolean> {
  if (busy()) return false;
  return mutate('/api/provider-config', {...draft, clearApiKey: true});
}

export async function testProviderConnection(draft: {provider: string; baseUrl: string; apiKey?: string}, signal?: AbortSignal): Promise<{ok: boolean; message: string}> {
  return request('/api/test-provider-connection', draft, {signal});
}

export async function saveAppearance(mode: 'system' | 'light' | 'dark'): Promise<boolean> {
  if (busy()) return false;
  const ok = await mutate('/api/appearance', {mode});
  if (!ok) desk().setError(desk().activity.error);
  return ok;
}

export async function exportDiagnostics(): Promise<void> {
  if (busy()) return;
  desk().setBusy(true);
  try {
    const result = await request('/api/diagnostics', {});
    if (result.native) return;
    const saved = await saveBlob(await app().download('/api/diagnostics'), 'pith-desk-diagnostics.json');
    if (!saved.ok) throw new Error(saved.error);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    desk().setBusy(false);
  }
}

export async function updateStatus(): Promise<UpdateStatus> {
  return request('/api/update', {query: {}});
}

export async function updateAction(action: 'check' | 'install' | 'restart'): Promise<void> {
  await mutate('/api/update', {action});
}

// Provider account actions keep request ownership outside the settings view.
export async function providerAction(action: 'custom' | 'login' | 'logout' | 'remove-connection', target: ProviderChoice): Promise<{ok: boolean; error?: string}> {
  if (busy() || desk().state.runs.length > 0) return {ok: false, error: 'A task is running. Try again when it finishes.'};
  try {
    if (action === 'custom') {
      openCustomConnection(target.id);
      return {ok: true};
    }
    if (action === 'login') {
      // Open the sign-in dialog from the login snapshot, never before the host
      // has committed the OAuth start. A failed start leaves the form in place.
      return await mutate('/api/oauth/start', {provider: target.id}) ? {ok: true} : {ok: false, error: desk().activity.error};
    }
    if (action === 'logout') {
      return await mutate('/api/oauth/logout', {provider: target.id}) ? {ok: true} : {ok: false, error: desk().activity.error};
    }
    openRemoveConnection(target.id);
    return {ok: true};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

export function openRemoveConnection(id: string): void {
  desk().openModal({
    kind: 'confirm', id: modalId('confirm'), title: 'Remove model connection?', action: 'Remove connection',
    description: {before: 'Remove ', subject: id, after: ' and its saved credentials?'},
    hint: 'Existing conversations and workspace files stay available.',
    async run() {
      if (busy() || desk().state.runs.length > 0) return false;
      const ok = await mutate('/api/remove-model-connection', {id});
      if (!ok) desk().patchModal(this.id, {error: desk().activity.error});
      return ok;
    },
  });
}

export async function loadMCP() {
  return request('/api/mcp');
}

export async function saveMCP(draft: {
  name: string; type: string; args: string[]; oauth: boolean; enabled: boolean; url?: string; command?: string;
  oauthClientId?: string; oauthScope?: string; bearerToken?: string; clearBearerToken?: boolean;
  env?: Record<string, string>; clearEnv?: boolean;
}): Promise<boolean> {
  return mutate('/api/mcp/save', draft as never);
}

export async function removeMCP(name: string): Promise<boolean> {
  return mutate('/api/mcp/remove', {name});
}

export function confirmRemoveMCP(name: string): void {
  desk().openModal({
    kind: 'confirm', id: modalId('confirm'), title: 'Delete connection?', action: 'Delete connection',
    description: {before: 'Remove ', subject: name, after: ' and its saved credentials from Pith Desk?'},
    hint: 'Workspace files and existing conversations stay on your computer.',
    async run() {
      const ok = await removeMCP(name);
      if (!ok) desk().patchModal(this.id, {error: desk().activity.error});
      return ok;
    },
  });
}

export async function mcpAuth(action: 'mcp-login' | 'mcp-logout', name: string): Promise<void> {
  if (busy() || desk().state.runs.length > 0) return;
  await mutate(action === 'mcp-login' ? '/api/mcp/oauth/start' : '/api/mcp/oauth/logout', {name});
}

export async function oauthAnswer(id: string, answer: string): Promise<boolean> {
  return mutate('/api/oauth/answer', {id, answer});
}

export async function oauthCancel(): Promise<void> {
  await mutate('/api/oauth/cancel', {});
}

export async function loadCustomConnection(id: string) {
  return request('/api/custom-connection', {query: {id}});
}

export async function saveCustomConnection(payload: {
  id: string; name: string; baseUrl: string; api: string; apiKey?: string; models: unknown[];
}): Promise<boolean> {
  return mutate('/api/custom-connection', payload as never);
}

export async function createInstructions(workspaceId: string): Promise<boolean> {
  return mutate('/api/create-instructions', {workspaceId});
}

export async function saveResource(input: {workspaceId: string; kind: string; path: string; name: string; content: string; remove?: boolean}): Promise<boolean> {
  return mutate('/api/resource', input as never);
}

export function dismissModal(id: string): void {
  closeModalId(id);
}

export function selectedWorkspaceId(): string {
  return selected()?.id || '';
}
