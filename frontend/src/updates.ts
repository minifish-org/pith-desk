import type { ApiRequest } from './api';
import type { UpdateStatus } from './contract.generated';
import { createUpdatePanel } from 'pith-ui';

export function mountUpdates(root: HTMLElement, request: ApiRequest): { check: () => Promise<void>; dispose: () => void } {
  const panel = createUpdatePanel({ container: root, productName: 'Pith Desk', onCheck: () => { void act('check'); }, onInstall: () => { void act('install'); } });
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let submitting = false;
  let generation = 0;

  function render(state: UpdateStatus): void {
    panel.update(state);
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
      if (!disposed && current === generation) { panel.setError(String(error), { allowCheckRetry: true }); }
    }
  }

  async function act(action: 'check' | 'install'): Promise<void> {
    if (disposed || submitting) return;
    generation++;
    submitting = true;
    panel.setPending(true);
    let failure = '';
    try { await request('/api/update', { action }); }
    catch (error) { failure = String(error); }
    finally { submitting = false; }
    await refresh();
    panel.setPending(false);
    if (!disposed && failure) panel.setError(failure);
  }

  void refresh();
  return {
    check: () => act('check'),
    dispose: () => { disposed = true; if (timer !== undefined) clearTimeout(timer); panel.destroy(); },
  };
}
