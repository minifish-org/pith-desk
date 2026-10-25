import {createRoot} from 'react-dom/client';
import '@/styles.css';
import {App} from './App.tsx';
import {readAppBootstrap} from '@/lib/bootstrap.ts';
import {createApp} from '@/app.ts';
import type {State} from '@/app-state.ts';
import {runtime} from '@/lib/runtime.ts';
import {desk, modalId} from '@/stores/desk.ts';
import {createServerSession} from '@/lib/session.ts';
import {createDraftRecovery} from '@/draft-recovery.ts';
import {applyAppearance, request, setError} from '@/actions/core.ts';
import {emitAppEvent} from '@/lib/events.ts';
import {addDroppedImages, addImageFiles, disposeComposer, enableDraftRecovery, flushAllDrafts, loadComposerDraft, preserveTexts, setDropPending} from '@/actions/composer.ts';
import {acknowledgeViewed, clearNotices, observeNotices} from '@/actions/notices.ts';
import {clearFilePreview, loadArtifacts} from '@/actions/files.ts';
import {pruneWorkspaceTools} from '@/actions/workspace-tools.ts';
import {installAppLifecycle, installNativeDrop, installNativeMenu, installWorkspaceFileDrop} from '@/lib/native.ts';
import {installBrowserFileDrop} from '@/lib/file-drop.ts';
import {installVisualViewportTracking} from '@/lib/viewport.ts';
import type {AppearanceMode} from '@/contract.generated.ts';

const bootstrap = readAppBootstrap();
runtime.server = bootstrap.server;
runtime.nativeBrowser = bootstrap.nativeBrowser;
runtime.nativeClipboard = bootstrap.nativeClipboard;
runtime.nativeFileDrop = bootstrap.nativeFileDrop;
runtime.titlebar = bootstrap.titlebar;

const appearanceMode = (value: unknown): AppearanceMode => value === 'light' || value === 'dark' ? value : 'system';
let disposed = false;
let appInstance: ReturnType<typeof createApp> | undefined;

const recovery = bootstrap.server ? createDraftRecovery() : undefined;
if (bootstrap.server) enableDraftRecovery(recovery);

const root = document.getElementById('app');
if (!root) throw new Error('The application mount is missing.');
createRoot(root).render(<App />);

applyAppearance(appearanceMode(document.documentElement.dataset.appearance));

// Navigation and unload retire this document's lease requests; a dying page
// must never race the document that replaces it.
const markUnloading = () => {runtime.unloading = true;};
const markActive = () => {runtime.unloading = false;};
window.addEventListener('pagehide', markUnloading);
window.addEventListener('beforeunload', markUnloading);
// Back-forward cache restores and synthetic lifecycle checks return control.
window.addEventListener('pageshow', markActive);
window.addEventListener('focus', markActive);

installVisualViewportTracking();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (desk().appearance === 'system') applyAppearance('system');
});

async function mountApplication(): Promise<void> {
  if (disposed || appInstance) return;
  const application = createApp({
    token: bootstrap.token,
    session: session ? {
      headers: json => session.headers(json),
      protocols: () => session.protocols(),
      failed: status => session.failed(status),
      check: () => session.check(),
    } : undefined,
    origin: window.location.href,
    appearance: appearanceMode(desk().state.settings.appearance),
    onSnapshot: snapshotChanged,
    onConnection(status) {
      desk().setConnection(status);
      if (status === 'connected' && !desk().loaded) desk().setError('');
    },
    onError(message) {setError(message);},
  });
  appInstance = application;
  runtime.app = application;
  await application.start();
  if (!disposed && recovery) {
    const recovered = await recovery.recover(scope => request('/api/draft', {query: scope}));
    if (!disposed && recovered) desk().openModal({kind: 'recovered', id: modalId('recovered'), text: recovered});
  }
}

function snapshotChanged(next: State, previous: State, initialized: boolean): void {
  const store = desk();
  store.setSnapshot(next, appInstance?.connection ?? 'connecting', appInstance?.receivedAt ?? performance.now());
  pruneWorkspaceTools(next.workspaces.map(workspace => workspace.id));
  const mode = appearanceMode(next.settings.appearance);
  if (mode !== store.appearance) {
    store.setAppearance(mode);
    applyAppearance(mode);
  }
  if (!initialized) {
    store.setWidths({navigation: next.settings.navigationWidth || undefined, tools: next.settings.toolsWidth || undefined});
  }
  const activeChanged = next.activeId !== previous.activeId;
  const runFinished = (previous.runs?.length || 0) > 0 && !(next.runs?.length || 0);
  if (activeChanged) {
    store.setError('');
    clearFilePreview();
    store.setArtifacts({files: [], error: ''});
  }
  void loadComposerDraft();
  observeNotices(initialized);
  if (next.activeId && !next.running && (!initialized || activeChanged || previous.running)) void loadArtifacts(next.activeId);
  if (runFinished) emitAppEvent('mcpRefresh');
}

const session = bootstrap.server ? createServerSession({
  recoveryText: () => recovery?.text() || '',
  onReady: () => {void mountApplication();},
  onLost: () => {
    preserveTexts();
    appInstance?.dispose();
    appInstance = undefined;
    for (const modal of desk().modals.filter(entry => entry.kind !== 'server')) desk().closeModal(modal.id);
    desk().setLoaded(false);
    desk().setConnection('reconnecting');
  },
}) : undefined;
if (session) {
  runtime.protocols = () => session.protocols();
  runtime.checkAccess = () => session.check();
  runtime.session = {
    login: token => session.login(token),
    continueHere: () => session.continueHere(),
    dismiss: () => session.dismiss(),
    logout: async () => {await flushAllDrafts(); await session.logout();},
  };
}

const removeNativeMenu = installNativeMenu(((path: string, payload: unknown, options?: {signal?: AbortSignal}) => {
  if (!appInstance) return Promise.reject(new Error('Reconnect to Pith Desk before continuing.'));
  return (appInstance.request as unknown as (p: string, i?: unknown, o?: unknown) => Promise<unknown>)(path, payload, options);
}) as never, bootstrap.nativeMenus);

const fileDrop = installWorkspaceFileDrop({
  resolve: async (workspaceId, paths) => (await request('/api/workspace-references', {workspaceId, paths})).paths || [],
  busy: () => desk().activity.busy || desk().composer.loading || !desk().loaded,
  context: () => `${desk().selectedWorkspaceId}/${desk().state.activeId}`,
});
const removeNativeDrop = installNativeDrop(bootstrap.nativeFileDrop, drop => {
  if (!document.elementFromPoint(drop.x, drop.y)?.closest('[data-composer]')) return;
  if (drop.notice) setError(drop.notice);
  if (drop.images.length) void addDroppedImages(drop.images);
  fileDrop.references({paths: drop.paths, uris: '', hasUnidentifiedFiles: false});
});

const removeBrowserDrop = installBrowserFileDrop({
  pending: setDropPending,
  images: files => {void addImageFiles(files);},
  references: input => fileDrop.references({paths: [], ...input}),
});

const removeLifecycle = installAppLifecycle({
  acknowledge: acknowledgeViewed,
  saveOnLeave: () => {preserveTexts(); void flushAllDrafts({keepalive: true});},
  flushDrafts: async () => {
    preserveTexts();
    const results = await flushAllDrafts();
    return results.every(result => result.status === 'fulfilled');
  },
  dispose() {
    if (disposed) return;
    disposed = true;
    appInstance?.dispose();
    session?.dispose();
    removeLifecycle();
    removeNativeMenu();
    removeNativeDrop();
    removeBrowserDrop();
    fileDrop.destroy();
    disposeComposer();
    clearNotices();
  },
});

if (!session) {
  runtime.protocols = () => bootstrap.token ? ['pith-desk', `bearer.${bootstrap.token}`] : ['pith-desk'];
}
if (session) void session.start();
else void mountApplication();
