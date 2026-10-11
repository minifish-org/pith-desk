import type { ApiRequest, RequestOptions } from './api.ts';
import type { Draft, DraftScope, DraftImage } from './contract.generated.ts';

export function draftKey(scope: DraftScope): string {
  return scope.id ? `conversation:${scope.id}` : scope.workspaceId ? `workspace:${scope.workspaceId}` : '';
}

// Revisions let the host reject an older autosave arriving after an unload save
// or a successful send. Drafts belong to the data profile, not a loopback origin.
export function createDrafts(request: ApiRequest, error: (message: string) => void, delay = 250) {
  type Entry = { scope: DraftScope; draft: Draft; saved: number; timer?: ReturnType<typeof setTimeout>; loading?: Promise<Draft>; autosaving?: boolean };
  const entries = new Map<string, Entry>();
  function schedule(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      if (entry.autosaving) return;
      entry.autosaving = true;
      const revision = entry.draft.revision;
      try { await flush(entry.scope); } catch { /* Preserve for explicit retry/quit. */ }
      finally {
        entry.autosaving = false;
        if (entries.get(draftKey(entry.scope)) === entry && entry.draft.revision > revision && entry.saved < entry.draft.revision) schedule(entry);
      }
    }, entry.draft.text.length > 64 * 1024 || entry.draft.images?.length ? Math.max(delay, 1000) : delay);
  }
  async function load(scope: DraftScope): Promise<Draft> {
    const key = draftKey(scope);
    if (!key) return { text: '', revision: 0 };
    const cached = entries.get(key);
    if (cached) return cached.loading || cached.draft;
    const entry: Entry = { scope, draft: { text: '', revision: 0 }, saved: 0 };
    entries.set(key, entry);
    entry.loading = request('/api/draft', { query: scope }).then((draft) => {
      entry.draft = draft;
      entry.saved = draft.revision;
      entry.loading = undefined;
      return draft;
    }).catch((reason) => {
      entries.delete(key);
      throw reason;
    });
    return entry.loading;
  }
  function update(scope: DraftScope, text: string, images: DraftImage[] = []): void {
    const key = draftKey(scope);
    if (!key) return;
    let entry = entries.get(key);
    if (!entry) {
      entry = { scope, draft: { text: '', revision: 0 }, saved: 0 };
      entries.set(key, entry);
    }
    if (entry.loading || entry.draft.text === text && sameImages(entry.draft.images, images)) return;
    entry.draft = { text, images, revision: Math.max(Date.now(), entry.draft.revision + 1) };
    schedule(entry);
  }
  async function flush(scope: DraftScope, options?: RequestOptions): Promise<void> {
    const entry = entries.get(draftKey(scope));
    if (!entry || entry.loading) return;
    clearTimeout(entry.timer);
    if (entry.saved >= entry.draft.revision) return;
    const draft = entry.draft;
    try {
      await request('/api/draft', { ...entry.scope, ...draft }, options);
      entry.saved = Math.max(entry.saved, draft.revision);
    } catch (reason) {
      error(`Draft could not be saved: ${reason instanceof Error ? reason.message : String(reason)}`);
      throw reason;
    }
  }
  function flushAll(options?: RequestOptions): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...entries.values()].map((entry) => flush(entry.scope, options)));
  }
  function prune(conversationIDs: string[], workspaceIDs: string[]): void {
    for (const [key, entry] of entries) {
      if (entry.scope.id ? !conversationIDs.includes(entry.scope.id) : !workspaceIDs.includes(entry.scope.workspaceId || '')) {
        clearTimeout(entry.timer);
        entries.delete(key);
      }
    }
  }
  function clearIfUnchanged(scope: DraftScope, submittedText: string, submittedImages: DraftImage[] = []): void {
    const draft = entries.get(draftKey(scope))?.draft;
    if (!draft) return;
    const ids = new Set(submittedImages.map((image) => image.id));
    update(scope, draft.text === submittedText ? '' : draft.text, (draft.images || []).filter((image) => !ids.has(image.id)));
  }
  async function transfer(source: DraftScope, target: DraftScope): Promise<Draft> {
    await load(target);
    const from = await load(source), to = await load(target);
    if (!to.text && !to.images?.length) {
      update(target, from.text, from.images || []);
      // Persist the destination before clearing the workspace landing draft.
      await flush(target);
      clearIfUnchanged(source, from.text, from.images || []);
      await flush(source);
    }
    return load(target);
  }
  return { load, update, flush, flushAll, prune, clearIfUnchanged, transfer };
}

function sameImages(a: DraftImage[] = [], b: DraftImage[] = []): boolean {
  return a.length === b.length && a.every((image, index) => image.id === b[index].id);
}
