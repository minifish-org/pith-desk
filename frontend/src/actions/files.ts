import {busy, copyText, mutate, request, setError} from './core.ts';
import {closeModalId, desk} from '@/stores/desk.ts';
import {saveBlob} from '@/lib/save.ts';
import {app, runtime} from '@/lib/runtime.ts';
import {conversationRunning, selectedWorkspace} from '@/lib/derive.ts';

// File previews, downloads and native file actions.

export async function downloadConversationFile(id: string, path: string): Promise<void> {
  // Native saves are serialized by the host; repeated clicks must stay usable
  // even while a task is streaming or a previous save dialog is closing.
  if (id !== desk().state.activeId) return;
  desk().setBusy(true);
  desk().setError('');
  try {
    const result = await request('/api/conversation-file', {id, path});
    // Native cancellation is a completed native action; it must not download.
    if (result.native) return;
    await saveBlob(await app().download('/api/conversation-file', {id, path}), result.name);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    desk().setBusy(false);
  }
}

export async function workspaceFileAction(action: 'open' | 'reveal' | 'copy' | 'copy-path' | 'download', target: {workspaceId: string; path: string}): Promise<void> {
  const workspace = selectedWorkspace(desk().state, desk().selectedWorkspaceId);
  if (busy() || target.workspaceId !== workspace?.id) return;
  const {workspaceId, path} = target;
  try {
    if (action === 'copy-path') {
      await copyText(`${workspace!.path.replace(/[\\/]$/, '')}/${path}`);
      return;
    }
    if (action === 'download' || (action === 'open' && (runtime.server || !runtime.nativeClipboard))) {
      const result = await request('/api/workspace-file', {workspaceId, path});
      if (result.native) return;
      await saveBlob(await app().download('/api/workspace-file', {workspaceId, path}), result.name);
      return;
    }
    if (action === 'copy') {
      await request('/api/file', {kind: 'workspace', workspaceId, path, action});
      return;
    }
    await mutate('/api/file', {kind: 'workspace', workspaceId, path, action: action as 'open' | 'reveal'});
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

export async function artifactAction(action: 'open' | 'reveal' | 'copy' | 'copy-path', target: {ownerId: string; path: string}): Promise<void> {
  const id = target.ownerId;
  if (busy() || conversationRunning(desk().state, id) || id !== desk().state.activeId) return;
  if (runtime.server && action === 'open') {
    await downloadConversationFile(id, target.path);
    return;
  }
  if (runtime.server && action === 'reveal') {
    await copyText(target.path);
    return;
  }
  try {
    if (action === 'copy' || action === 'copy-path') {
      if (action === 'copy') await request('/api/file', {kind: 'artifact', id, path: target.path, action});
      else await copyText(target.path);
      return;
    }
    await mutate('/api/file', {kind: 'artifact', id, path: target.path, action});
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

let artifactRequest = 0;

export async function loadArtifacts(id: string): Promise<void> {
  const requestId = ++artifactRequest;
  const current = () => requestId === artifactRequest && desk().state.activeId === id;
  desk().setArtifacts({error: ''});
  try {
    const result = await request('/api/artifacts', {query: {id}});
    if (current()) desk().setArtifacts({files: result || []});
  } catch (error) {
    if (current()) desk().setArtifacts({error: error instanceof Error ? error.message : String(error)});
  }
}

export function clearFilePreview(): void {
  for (const modal of desk().modals) if (modal.kind === 'preview') closeModalId(modal.id);
}
