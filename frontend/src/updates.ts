import type { ApiRequest } from './api';
import type { UpdateStatus } from './contract.generated';

export function mountUpdates(root: HTMLElement, request: ApiRequest): { check: () => Promise<void>; dispose: () => void } {
  const version = root.querySelector<HTMLElement>('[data-update-version]')!;
  const message = root.querySelector<HTMLElement>('[data-update-message]')!;
  const checkButton = root.querySelector<HTMLButtonElement>('[data-update-check]')!;
  const installButton = root.querySelector<HTMLButtonElement>('[data-update-install]')!;
  const progress = root.querySelector<HTMLProgressElement>('progress')!;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let submitting = false;
  let generation = 0;

  function render(state: UpdateStatus): void {
    version.textContent = `Pith Desk ${state.version}`;
    message.textContent = state.message;
    const busy = ['checking', 'installing', 'restarting'].includes(state.phase);
    checkButton.disabled = !state.enabled || busy || submitting;
    installButton.hidden = !state.availableVersion;
    installButton.disabled = busy || submitting;
    installButton.textContent = 'Update and restart';
    progress.hidden = state.phase !== 'installing';
    progress.value = state.progress;
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
      if (!disposed && current === generation) { message.textContent = String(error); checkButton.disabled = false; }
    }
  }

  async function act(action: 'check' | 'install'): Promise<void> {
    if (disposed || submitting) return;
    generation++;
    submitting = true;
    checkButton.disabled = installButton.disabled = true;
    let failure = '';
    try { await request('/api/update', { action }); }
    catch (error) { failure = String(error); }
    finally { submitting = false; }
    await refresh();
    if (!disposed && failure) message.textContent = failure;
  }

  checkButton.addEventListener('click', () => { void act('check'); });
  installButton.addEventListener('click', () => { void act('install'); });
  void refresh();
  return {
    check: () => act('check'),
    dispose: () => { disposed = true; if (timer !== undefined) clearTimeout(timer); },
  };
}
