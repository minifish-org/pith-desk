import type {ApiRequest} from '@/api.ts';
import {readDraftFlushCallback, readNativeDrop, readNativeMenuAction, type NativeMenuAction} from '@/native-protocol.ts';
import {desk, useDesk} from '@/stores/desk.ts';
import {currentWorkspace, exportConversation, newConversation, openWorkspace} from '@/actions/conversations.ts';
import {openSettings} from '@/actions/settings.ts';
import {insertReferences, setDropPending} from '@/actions/composer.ts';
import {isImagePath, localFileURIs} from '@/workspace-files.ts';
import {setError} from '@/actions/core.ts';
import {runtime} from '@/lib/runtime.ts';


// Native coordinates are data; only the page decides what a drop targets.
export function installNativeDrop(enabled: boolean, receive: (paths: string[], x: number, y: number) => void): () => void {
  const onDrop = (event: Event) => {
    if (!enabled) return;
    const drop = readNativeDrop((event as CustomEvent<unknown>).detail);
    if (drop) receive(drop.paths, drop.x, drop.y);
  };
  if (enabled) window.addEventListener('pith:file-drop', onDrop);
  return () => window.removeEventListener('pith:file-drop', onDrop);
}

export function installNativeMenu(request: ApiRequest, native: boolean): () => void {
  let disposed = false;
  let sending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastSignature = '';
  let pending: ReturnType<typeof input> | undefined;
  const busy = () => desk().activity.busy || desk().composer.loading || desk().composer.reading || desk().composer.resolving;
  const canExport = () => !!desk().state.conversations.find(entry => entry.id === desk().state.activeId)
    && !desk().state.runs.some(run => run.conversationId === desk().state.activeId);

  function input() {
    return {
      ready: desk().loaded && !disposed,
      busy: busy(),
      modal: desk().modals.length > 0,
      workspaceId: currentWorkspace()?.id || '',
      activeId: desk().state.activeId || '',
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
          await request('/api/native-menu-state', next);
        } catch {
          // A transient HTTP interruption should not leave startup menus
          // disabled forever. Actions still check the live page state.
          lastSignature = '';
          if (!disposed && retry === undefined) retry = setTimeout(() => {retry = undefined; update();}, 700);
          break;
        }
      }
    } finally {sending = false;}
  }
  function update(): void {
    if (!native || disposed) return;
    const next = input();
    const signature = JSON.stringify(next);
    if (signature === lastSignature) return;
    lastSignature = signature;
    pending = next;
    void flush();
  }
  function dispatch(action: NativeMenuAction): void {
    const current = input();
    if (!current.ready || current.busy || current.modal) return;
    if (action === 'export-conversation' && (!current.activeId || !canExport())) return;
    const invoke: Record<NativeMenuAction, () => void | Promise<void>> = {
      'new-conversation': () => newConversation(),
      'choose-workspace': () => openWorkspace(),
      'export-conversation': () => exportConversation(),
      settings: () => openSettings(),
      'check-updates': () => openSettings(),
    };
    try {
      void Promise.resolve(invoke[action]()).catch((error: unknown) => setError(error instanceof Error ? error.message : String(error))).finally(update);
    } catch (error) {setError(error instanceof Error ? error.message : String(error));}
    update();
  }
  const onNative = (event: Event): void => {
    if (!native || disposed) return;
    const action = readNativeMenuAction((event as CustomEvent<unknown>).detail);
    if (action) dispatch(action);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (native || disposed || event.repeat || event.isComposing || event.shiftKey || event.altKey) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      dispatch('new-conversation');
    }
  };
  window.addEventListener('pith:native-menu', onNative);
  if (!native) document.addEventListener('keydown', onKeyDown);
  update();
  const unsubscribe = useDesk.subscribe(update);
  return () => {
    disposed = true;
    pending = undefined;
    if (retry !== undefined) clearTimeout(retry);
    window.removeEventListener('pith:native-menu', onNative);
    document.removeEventListener('keydown', onKeyDown);
    unsubscribe();
  };
}

// References resolve to workspace-relative paths before they enter a draft.
export function installWorkspaceFileDrop(options: {
  resolve: (workspaceId: string, paths: string[]) => Promise<string[]>;
  busy: () => boolean;
  context: () => string;
}): {references: (input: {paths: string[]; uris?: string; hasUnidentifiedFiles?: boolean}) => void; destroy: () => void} {
  let pending = false;
  let destroyed = false;
  const addPaths = async (paths: string[]) => {
    if (destroyed || !paths.length || options.busy() || pending) return;
    const workspaceId = currentWorkspace()?.id;
    if (!workspaceId) {setError('Choose a workspace before dropping files.'); return;}
    const context = options.context();
    pending = true;
    setDropPending(true);
    desk().setComposer({resolving: true});
    let released = false;
    try {
      const refs = await options.resolve(workspaceId, paths);
      if (destroyed || context !== options.context()) return;
      if (!refs.length) {
        setError('Files must be inside the selected workspace to be referenced.');
        return;
      }
      setDropPending(false);
      desk().setComposer({resolving: false});
      released = true;
      insertReferences(refs);
    } catch (error) {
      if (!destroyed && context === options.context()) setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending = false;
      if (!destroyed && !released) {
        setDropPending(false);
        desk().setComposer({resolving: false});
      }
    }
  };
  function references(input: {paths: string[]; uris?: string; hasUnidentifiedFiles?: boolean}): void {
    if (destroyed || options.busy() || pending) return;
    if (runtime.server) {
      if (input.hasUnidentifiedFiles || input.paths.length || localFileURIs(input.uris || '').some(path => !isImagePath(path))) {
        setError('Files on this device are not uploaded. Enter a server workspace-relative path to reference a file. Image attachments can still be uploaded.');
      }
      return;
    }
    if (runtime.nativeFileDrop) {
      if (input.paths.length) void addPaths(input.paths.filter(path => !isImagePath(path)));
      return;
    }
    const paths = localFileURIs(input.uris || '').filter(path => !isImagePath(path));
    if (paths.length) void addPaths(paths);
    else if (input.hasUnidentifiedFiles) setError('The browser cannot identify this local file. Type its workspace-relative path, or drop it in the desktop app.');
  }
  return {
    references,
    destroy() {destroyed = true; setDropPending(false);},
  };
}

export function installAppLifecycle(options: {acknowledge: () => void; saveOnLeave: () => void; flushDrafts: () => Promise<boolean>; dispose: () => void}): () => void {
  const onVisibility = () => {
    options.acknowledge();
    if (document.visibilityState === 'hidden') options.saveOnLeave();
  };
  const onFlush = (event: Event) => {
    const callback = readDraftFlushCallback((event as CustomEvent<unknown>).detail);
    if (!callback) return;
    event.preventDefault();
    void options.flushDrafts().then(callback, () => callback(false));
  };
  const onUnload = () => {options.saveOnLeave(); options.dispose();};
  window.addEventListener('focus', options.acknowledge);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', options.saveOnLeave);
  window.addEventListener('pith:flush-drafts', onFlush);
  window.addEventListener('beforeunload', onUnload);
  return () => {
    window.removeEventListener('focus', options.acknowledge);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', options.saveOnLeave);
    window.removeEventListener('pith:flush-drafts', onFlush);
    window.removeEventListener('beforeunload', onUnload);
  };
}
