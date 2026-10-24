import {busy, mutate, request} from './core.ts';
import {desk, modalId} from '@/stores/desk.ts';
import {emitAppEvent} from '@/lib/events.ts';

// MCP tool connections.

export function openConnections(): void {
  desk().openModal({kind: 'connections', id: 'connections'});
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

async function removeMCP(name: string): Promise<boolean> {
  const ok = await mutate('/api/mcp/remove', {name});
  if (ok || desk().activity.error === 'MCP server not found') {
    if (!ok) desk().setError('');
    emitAppEvent('mcpRefresh');
    return true;
  }
  return false;
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
