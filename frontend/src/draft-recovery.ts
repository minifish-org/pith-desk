import {draftKey} from './drafts.ts';
import type {Draft, DraftScope} from './contract.generated.ts';

type TextDraft = {scope?: DraftScope; label?: string; text: string; revision: number};
const storageKey = 'pith-desk-unsaved-text';

// A per-page recovery copy, never a submission queue. Image data belongs in the
// authenticated server draft rather than browser storage.
export function createDraftRecovery(storage?: Pick<Storage, 'getItem'|'setItem'|'removeItem'>) {
  const entries = new Map<string, TextDraft>();
  try {
    const saved: unknown = JSON.parse((storage ?? sessionStorage).getItem(storageKey) || '[]');
    if (Array.isArray(saved)) for (const value of saved) {
      if (!value || typeof value !== 'object' || typeof value.text !== 'string' || !Number.isSafeInteger(value.revision)) continue;
      if (typeof value.label === 'string' && value.text) {entries.set(`edit:${value.label}`,{label: value.label,text: value.text,revision: value.revision});continue;}
      if (!value.scope || typeof value.scope !== 'object') continue;
      const scope: DraftScope = typeof value.scope.id === 'string' ? {id: value.scope.id} : typeof value.scope.workspaceId === 'string' ? {workspaceId: value.scope.workspaceId} : {};
      const key = draftKey(scope);
      if (key && value.text) entries.set(key, {scope, text: value.text, revision: value.revision});
    }
  } catch { /* Storage may be unavailable or full; the live page still keeps text. */ }
  const restored = [...entries];
  const format = (values: Array<[string,TextDraft]>) => values.map(([key, draft]) => `[${key}]\n${draft.text}`).join('\n\n');
  function persist(): void {
    try {
      if (entries.size) (storage ?? sessionStorage).setItem(storageKey, JSON.stringify([...entries.values()]));
      else (storage ?? sessionStorage).removeItem(storageKey);
    } catch { /* Preserve the in-memory copy. */ }
  }
  return {
    keepText(label: string, text: string): void {
      if (text) entries.set(`edit:${label}`, {label, text, revision: Date.now()});
      else entries.delete(`edit:${label}`);
      persist();
    },
    remember(scope: DraftScope, draft: Draft): void {
      const key = draftKey(scope);
      if (!key) return;
      if (draft.text) entries.set(key, {scope: {...scope}, text: draft.text, revision: draft.revision});
      else entries.delete(key);
      persist();
    },
    saved(scope: DraftScope, draft: Draft): void {
      const key = draftKey(scope);
      if (entries.get(key)?.revision === draft.revision) {entries.delete(key); persist();}
    },
    async recover(read: (scope: DraftScope) => Promise<Draft>): Promise<string> {
      const remaining: Array<[string,TextDraft]> = [];
      for (const [key, draft] of restored) {
        try {
          if (draft.scope && (await read(draft.scope)).text === draft.text) {
            if (entries.get(key)?.revision === draft.revision) entries.delete(key);
            continue;
          }
        } catch { /* Unavailable or removed server drafts still need local recovery. */ }
        remaining.push([key,draft]);
      }
      persist();return format(remaining);
    },
    text(): string {return format([...entries]);},
    discard(): void {
      for (const [key, draft] of restored) if (entries.get(key)?.revision === draft.revision) entries.delete(key);
      persist();
    },
  };
}
export type DraftRecovery = ReturnType<typeof createDraftRecovery>;
