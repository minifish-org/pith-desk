import {busy, mutate, request, setError} from './core.ts';
import {desk} from '@/stores/desk.ts';
import {app} from '@/lib/runtime.ts';
import {saveBlob} from '@/lib/save.ts';
import type {UpdateStatus} from '@/contract.generated.ts';

// Application settings, appearance, diagnostics and updates. Model providers
// live in `models.ts`; MCP connections in `connections.ts`.

export function openSettings(): void {
  desk().openModal({kind: 'settings', id: 'settings'});
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
    await saveBlob(await app().download('/api/diagnostics'), 'pith-desk-diagnostics.json');
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
