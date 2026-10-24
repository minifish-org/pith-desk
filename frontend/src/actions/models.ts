import {busy, mutate, request} from './core.ts';
import {desk, modalId} from '@/stores/desk.ts';
import type {ModelCatalog, ModelSelectionInput, ProviderChoice} from '@/contract.generated.ts';

// Model catalog, the shared model selection and provider connections.

export function openCustomConnection(connectionId?: string): void {
  desk().openModal({kind: 'custom-connection', id: modalId('custom-connection'), connectionId});
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

function openRemoveConnection(id: string): void {
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

export async function loadCustomConnection(id: string) {
  return request('/api/custom-connection', {query: {id}});
}

export async function saveCustomConnection(payload: {
  id: string; name: string; baseUrl: string; api: string; apiKey?: string; models: unknown[];
}): Promise<boolean> {
  return mutate('/api/custom-connection', payload as never);
}

export async function oauthAnswer(id: string, answer: string): Promise<boolean> {
  return mutate('/api/oauth/answer', {id, answer});
}

export async function oauthCancel(): Promise<void> {
  await mutate('/api/oauth/cancel', {});
}
