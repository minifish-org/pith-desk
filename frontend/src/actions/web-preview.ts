import {request} from './core.ts';
import {runtime} from '@/lib/runtime.ts';
import {emptyWebPreview, useWorkspaceTools, type WebPreviewState} from '@/stores/workspace-tools.ts';
import type {BrowserBounds} from '@/contract.generated.ts';

const navigations = new Map<string, Promise<unknown>>();
const placements = new Map<string, BrowserBounds | null>();
let placing = false;

export function updateWebPreview(id: string, patch: Partial<WebPreviewState>): void {
  const store = useWorkspaceTools.getState();
  store.setPreview(id, {...(store.previews[id] || emptyWebPreview), ...patch});
}

export function placeWebPreview(id: string, bounds: BrowserBounds | null): void {
  // Native visibility is shared by all tabs. Keep requests in intent order,
  // coalescing resize bursts without letting a late show overtake a hide.
  placements.delete(id);
  placements.set(id, bounds);
  if (!placing) void flushPlacements();
}

async function flushPlacements(): Promise<void> {
  placing = true;
  while (placements.size) {
    const [id, bounds] = placements.entries().next().value!;
    placements.delete(id);
    try {await request('/api/web-preview/view', {id, bounds});} catch { /* The view may have closed. */ }
  }
  placing = false;
}

export async function navigateWebPreview(workspaceId: string, id: string, value: string): Promise<void> {
  const target = value.trim();
  const store = useWorkspaceTools.getState();
  const tools = store.workspaces[workspaceId];
  if (!target || store.previews[id]?.pending || tools?.closing === id || !tools?.layout.tabs.some(tab => tab.id === id)) return;
  updateWebPreview(id, {address: target, pending: true, error: ''});
  let reserved: Window | null = null;
  try {
    if (!runtime.nativeBrowser) {
      // Reserve during the user gesture. Browser tabs and Server grants outlive
      // the tool view, including a navigation still awaiting authorization.
      reserved = window.open('about:blank', '_blank');
      if (!reserved) throw new Error('Allow new tabs for Pith Desk, then try again.');
      reserved.opener = null;
    }
    const navigation = request('/api/web-preview', {id, workspaceId, address: target});
    navigations.set(id, navigation);
    const result = await navigation;
    reserved?.location.replace(result.url);
    if (useWorkspaceTools.getState().previews[id]) updateWebPreview(id, {current: target, opened: runtime.nativeBrowser});
  } catch (failure) {
    reserved?.close();
    if (useWorkspaceTools.getState().previews[id]) updateWebPreview(id, {error: failure instanceof Error ? failure.message : String(failure)});
  } finally {
    navigations.delete(id);
    if (useWorkspaceTools.getState().previews[id]) updateWebPreview(id, {pending: false});
  }
}

export async function closeWebPreview(id: string): Promise<void> {
  const pending = navigations.get(id);
  const opened = useWorkspaceTools.getState().previews[id]?.opened;
  useWorkspaceTools.getState().setPreview(id, null);
  if (runtime.nativeBrowser && (opened || pending)) {
    // A close racing page creation must release the resulting native page.
    await pending?.catch(() => {});
    try {await request('/api/web-preview/close', {id});} catch { /* The tab closes anyway. */ }
  }
  useWorkspaceTools.getState().setPreview(id, null);
}
