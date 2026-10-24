import {busy, mutate, request} from './core.ts';
import {desk, modalId} from '@/stores/desk.ts';
import {emitAppEvent} from '@/lib/events.ts';
import type {CustomConnectionInput, ModelCatalog, ModelSelectionInput, ProviderChoice, ProviderConnectionInput} from '@/contract.generated.ts';

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

export interface ProviderEditorState {
  pending: '' | 'save' | 'remove' | 'test';
  error: string;
  saved: string;
  test: {message: string; ok?: boolean};
}

export const emptyProviderEditor: ProviderEditorState = {pending: '', error: '', saved: '', test: {message: ''}};

// One form revision owns saves, key removal and probes. Editing or closing the
// form retires their UI results without replaying or undoing a committed write.
export function createProviderEditor(publish: (state: ProviderEditorState) => void, clearKey: () => void) {
  let revision = 0;
  let probe: AbortController | undefined;
  function invalidate() {
    revision++;
    probe?.abort();
    probe = undefined;
  }
  return {
    reset() {invalidate(); publish(emptyProviderEditor);},
    dispose: invalidate,
    async run(action: 'save' | 'remove' | 'test', draft: ProviderConnectionInput): Promise<void> {
      if (action === 'test' && probe) {
        invalidate();
        publish({...emptyProviderEditor, test: {message: 'Test cancelled.', ok: false}});
        return;
      }
      if (busy() || desk().state.runs.length > 0 || probe) return;
      const current = ++revision;
      const controller = action === 'test' ? new AbortController() : undefined;
      probe = controller;
      publish({...emptyProviderEditor, pending: action, test: {message: action === 'test' ? 'Testing streaming and tool calling…' : ''}});
      try {
        if (action === 'test') {
          const result = await request('/api/test-provider-connection', draft, {signal: controller!.signal});
          if (current === revision) publish({...emptyProviderEditor, test: result});
        } else {
          const payload = action === 'remove' ? {provider: draft.provider, baseUrl: draft.baseUrl, clearApiKey: true} : draft;
          const ok = await mutate('/api/provider-config', payload);
          if (ok) emitAppEvent('modelConnectionsChanged');
          if (current !== revision) return;
          if (ok) {
            clearKey();
            publish({...emptyProviderEditor, saved: action === 'remove' ? 'API key removed.' : 'Provider saved.'});
          } else publish({...emptyProviderEditor, error: desk().activity.error});
        }
      } catch (failure) {
        if (current !== revision) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        publish({...emptyProviderEditor, ...(action === 'test' ? {test: {message, ok: false}} : {error: message})});
      } finally {
        if (current === revision) probe = undefined;
      }
    },
  };
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

export async function saveCustomConnection(payload: CustomConnectionInput): Promise<boolean> {
  return mutate('/api/custom-connection', payload);
}

export async function oauthAnswer(id: string, answer: string): Promise<boolean> {
  return mutate('/api/oauth/answer', {id, answer});
}

export async function oauthCancel(): Promise<void> {
  await mutate('/api/oauth/cancel', {});
}
