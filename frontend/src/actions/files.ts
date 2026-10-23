import {busy, copyText, mutate, request, setError} from './core.ts';
import {closeModalId, desk, modalId} from '@/stores/desk.ts';
import {saveBlob} from '@/lib/save.ts';
import {app, runtime} from '@/lib/runtime.ts';
import {selected, isConversationRunning} from './conversations.ts';

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
    const saved = await saveBlob(await app().download('/api/conversation-file', {id, path}), result.name);
    if (!saved.ok) throw new Error(saved.error);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    desk().setBusy(false);
  }
}

export async function workspaceFileAction(action: 'open' | 'reveal' | 'copy' | 'copy-path' | 'download' | 'preview', target: {workspaceId: string; path: string}): Promise<void> {
  if (busy() || target.workspaceId !== selected()?.id) return;
  const {workspaceId, path} = target;
  if (action === 'preview') {
    desk().openModal({kind: 'preview', id: modalId('preview'), owner: {kind: 'workspace', id: workspaceId}, path});
    return;
  }
  try {
    if (action === 'copy-path') {
      await copyText(`${selected()!.path.replace(/[\\/]$/, '')}/${path}`);
      return;
    }
    if (action === 'download' || (action === 'open' && (runtime.server || !runtime.nativeClipboard))) {
      const result = await request('/api/workspace-file', {workspaceId, path});
      if (result.native) return;
      const saved = await saveBlob(await app().download('/api/workspace-file', {workspaceId, path}), result.name);
      if (!saved.ok) throw new Error(saved.error);
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
  if (busy() || isConversationRunning(id) || id !== desk().state.activeId) return;
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

export async function loadArtifacts(id: string): Promise<void> {
  desk().setArtifacts({loading: true, error: ''});
  try {
    const result = await request('/api/artifacts', {query: {id}});
    if (desk().state.activeId !== id) return;
    desk().setArtifacts({files: result || []});
  } catch (error) {
    desk().setArtifacts({error: error instanceof Error ? error.message : String(error)});
  } finally {
    desk().setArtifacts({loading: false});
  }
}

export function openArtifacts(): void {
  desk().setArtifacts({open: true});
  if (desk().state.activeId) void loadArtifacts(desk().state.activeId);
}

export function closeArtifacts(): void {
  desk().setArtifacts({open: false});
}

export function clearFilePreview(): void {
  for (const modal of desk().modals) if (modal.kind === 'preview') closeModalId(modal.id);
}

export function openResources(): void {
  if (!selected()) {
    desk().openModal({kind: 'workspace', id: modalId('workspace'), error: ''});
    return;
  }
  desk().openModal({kind: 'resources', id: 'resources'});
}

export function openHistory(): void {
  if (!desk().state.activeId) return;
  desk().openModal({kind: 'history', id: 'history'});
}

export async function resourceFileAction(action: 'open' | 'reveal', target: {workspaceId: string; path: string}): Promise<void> {
  if (busy() || target.workspaceId !== selected()?.id) return;
  if (runtime.server) {
    await copyText(target.path);
    return;
  }
  if (!await mutate('/api/file', {kind: 'resource', workspaceId: target.workspaceId, path: target.path, action})) throw new Error(desk().activity.error);
}

export function copyPath(path: string): Promise<void> {
  return copyText(path);
}
