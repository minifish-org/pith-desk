import type { ApiRequest } from './api';
import type { UpdateStatus } from './contract.generated';
import type { SettingsSession, UpdateAction } from 'pith-ui/app';

export function mountUpdates(panel: SettingsSession, request: ApiRequest): { act: (action: UpdateAction) => Promise<void>; check: () => Promise<void>; dispose: () => void } {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let submitting = false;
  let generation = 0;

  function render(state: UpdateStatus): void {
    panel.updateUpdates(state);
    const busy = ['checking', 'installing', 'restarting'].includes(state.phase);
    if (busy && !disposed) timer = setTimeout(() => { void refresh(); }, 500);
  }

  async function refresh(): Promise<void> {
    if (disposed || submitting) return;
    const current = ++generation;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    try {
      const state = await request('/api/update');
      if (!disposed && current === generation) render(state);
    } catch (error) {
      if (!disposed && current === generation) { panel.setUpdateError(String(error), { allowCheckRetry: true }); }
    }
  }

  async function act(action: 'check' | 'install'): Promise<void> {
    if (disposed || submitting) return;
    generation++;
    submitting = true;
    panel.setUpdatePending(true);
    let failure = '';
    try { await request('/api/update', { action }); }
    catch (error) { failure = String(error); }
    finally { submitting = false; }
    await refresh();
    panel.setUpdatePending(false);
    if (!disposed && failure) panel.setUpdateError(failure);
  }

  void refresh();
  return {
    act,
    check: () => act('check'),
    dispose: () => { disposed = true; if (timer !== undefined) clearTimeout(timer); },
  };
}
