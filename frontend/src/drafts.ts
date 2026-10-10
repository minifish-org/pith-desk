import type { ApiRequest, RequestOptions } from './api.ts';
import type { Draft, DraftScope } from './contract.generated.ts';

export function draftKey(scope: DraftScope): string {
  return scope.id ? `conversation:${scope.id}` : scope.workspaceId ? `workspace:${scope.workspaceId}` : '';
}

// Revisions let the host reject an older autosave arriving after an unload save
// or a successful send. Drafts belong to the data profile, not a loopback origin.
export function createDrafts(request: ApiRequest, error: (message: string) => void, delay = 250) {
  type Entry = { scope: DraftScope; draft: Draft; saved: number; timer?: ReturnType<typeof setTimeout>; loading?: Promise<Draft> };
  const entries = new Map<string, Entry>();
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
  function update(scope: DraftScope, text: string): void {
    const key = draftKey(scope);
    if (!key) return;
    let entry = entries.get(key);
    if (!entry) {
      entry = { scope, draft: { text: '', revision: 0 }, saved: 0 };
      entries.set(key, entry);
    }
    if (entry.loading || entry.draft.text === text) return;
    entry.draft = { text, revision: Math.max(Date.now(), entry.draft.revision + 1) };
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void flush(scope).catch(() => {}); }, delay);
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
  function clearIfUnchanged(scope: DraftScope, submittedText: string): void {
    if (entries.get(draftKey(scope))?.draft.text === submittedText) update(scope, '');
  }
  return { load, update, flush, flushAll, prune, clearIfUnchanged };
}
