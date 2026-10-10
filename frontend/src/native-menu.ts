import type { ApiRequest } from './api';

interface MenuContext {
  ready: boolean;
  busy: boolean;
  modal?: boolean;
  workspaceId?: string;
  activeId?: string | null;
}

type MenuAction = 'new-conversation' | 'choose-workspace' | 'export-conversation' | 'settings';
type Action = () => void | Promise<void>;

interface NativeMenuOptions {
  native: boolean;
  context: () => MenuContext;
  request: ApiRequest;
  canExport: () => boolean;
  actions: { newConversation: Action; chooseWorkspace: Action; exportConversation: Action; settings: Action };
  error?: (message: string) => void;
}

// Native menu shortcuts are delivered by the platform, while the browser
// preview keeps its existing New Conversation shortcut. Both use this guard.
export function installNativeMenu(options: NativeMenuOptions): { update: () => void; dispose: () => void } {
  let disposed = false;
  let sending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastSignature = '';
  let pending: ReturnType<typeof input> | undefined;

  function input() {
    const context = options.context();
    return {
      ready: context.ready && !disposed,
      busy: context.busy,
      modal: !!context.modal || !!document.querySelector('dialog[open]'),
      workspaceId: context.workspaceId || '',
      activeId: context.activeId || '',
    };
  }

  async function flush(): Promise<void> {
    if (sending || disposed) return;
    sending = true;
    try {
      while (pending && !disposed) {
        const next = pending;
        pending = undefined;
        try {
          await options.request('/api/native-menu-state', next);
        } catch {
          // A transient HTTP interruption should not leave startup menus
          // disabled forever. Actions still check the live page state.
          lastSignature = '';
          if (!disposed && retry === undefined) retry = setTimeout(() => { retry = undefined; update(); }, 700);
          break;
        }
      }
    } finally { sending = false; }
  }

  function update(): void {
    if (!options.native || disposed) return;
    const next = input();
    const signature = JSON.stringify(next);
    if (signature === lastSignature) return;
    lastSignature = signature;
    pending = next;
    void flush();
  }

  function dispatch(action: MenuAction): void {
    const current = input();
    if (!current.ready || current.busy || current.modal) return;
    if (action === 'export-conversation' && (!current.activeId || !options.canExport())) return;
    const invoke: Record<MenuAction, Action> = {
      'new-conversation': options.actions.newConversation,
      'choose-workspace': options.actions.chooseWorkspace,
      'export-conversation': options.actions.exportConversation,
      settings: options.actions.settings,
    };
    // Existing actions set their request/dialog state synchronously before
    // awaiting HTTP, so a second activation sees the new busy/modal state.
    try {
      void Promise.resolve(invoke[action]()).catch((error: unknown) => {
        options.error?.(error instanceof Error ? error.message : String(error));
      }).finally(update);
    } catch (error) { options.error?.(error instanceof Error ? error.message : String(error)); }
    update();
  }

  const onNative = (event: Event): void => {
    if (!options.native || disposed) return;
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object' || !('action' in detail)) return;
    const action = detail.action;
    if (action === 'new-conversation' || action === 'choose-workspace' || action === 'export-conversation' || action === 'settings') dispatch(action);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (options.native || disposed || event.repeat || event.isComposing || event.shiftKey || event.altKey) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      dispatch('new-conversation');
    }
  };
  window.addEventListener('pith:native-menu', onNative);
  if (!options.native) document.addEventListener('keydown', onKeyDown);
  const dialogs = new MutationObserver(update);
  dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  update();
  return {
    update,
    dispose: () => {
      disposed = true;
      pending = undefined;
      if (retry !== undefined) clearTimeout(retry);
      dialogs.disconnect();
      window.removeEventListener('pith:native-menu', onNative);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
