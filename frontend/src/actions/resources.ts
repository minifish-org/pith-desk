import {busy, copyText, mutate, request} from './core.ts';
import {desk, modalId} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime.ts';
import {selectedWorkspace} from '@/lib/derive.ts';
import type {ResourceContentResponse, ResourceInput, ResourceInventory} from '@/contract.generated.ts';

// Workspace instructions, skills and prompt templates.

function selectedWorkspaceId(): string {
  return selectedWorkspace(desk().state, desk().selectedWorkspaceId)?.id || '';
}

export function openResources(): void {
  if (!selectedWorkspaceId()) {
    desk().openModal({kind: 'workspace', id: modalId('workspace'), error: ''});
    return;
  }
  desk().openModal({kind: 'resources', id: 'resources'});
}

export async function loadResources(workspaceId: string): Promise<ResourceInventory> {
  return request('/api/resources', {query: {workspaceId}});
}

export async function loadResourceContent(workspaceId: string, path: string): Promise<ResourceContentResponse> {
  return request('/api/resource-content', {query: {workspaceId, path}});
}

export async function createInstructions(workspaceId: string): Promise<boolean> {
  return mutate('/api/create-instructions', {workspaceId});
}

export async function saveResource(input: Omit<ResourceInput, 'remove'> & {remove?: boolean}): Promise<boolean> {
  return mutate('/api/resource', input as ResourceInput);
}

export async function resourceFileAction(action: 'open' | 'reveal', target: {workspaceId: string; path: string}): Promise<void> {
  if (busy() || target.workspaceId !== selectedWorkspaceId()) return;
  if (runtime.server) {
    await copyText(target.path);
    return;
  }
  if (!await mutate('/api/file', {kind: 'resource', workspaceId: target.workspaceId, path: target.path, action})) throw new Error(desk().activity.error);
}
