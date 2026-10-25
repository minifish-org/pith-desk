import type { State as WireState, Workspace, Conversation, QueuedMessage, AppearanceMode } from './contract.generated';
export type { ProviderChoice } from './contract.generated';

/** The page's transport connection to the local service or server host. */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

// The Go snapshot normalizes these collections; retain a defensive boundary
// for an interrupted connection while using the generated wire State type.
export type State = Omit<WireState, 'workspaces' | 'conversations' | 'messages' | 'queuedMessages' | 'runs'> & {
  workspaces: Workspace[];
  conversations: Conversation[];
  messages: NonNullable<WireState['messages']>;
  queuedMessages: QueuedMessage[];
  runs: NonNullable<WireState['runs']>;
};

export function initialState(appearance: AppearanceMode): State {
  return {
    settings: { provider: '', modelName: '', thinkingLevel: '', thinkingLevels: [], baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', hasApiKey: false, hasConnections: false, appearance, supportsImages: false, imageUploadLimit: 0 },
    workspaces: [], conversations: [], activeId: '', messages: [], queuedMessages: [], running: false, runs: [],
    runtime: { phase: '', model: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: { total: 0, runTotal: 0, requestCount: 0, unknownRequests: 0, runRequests: 0, runUnknownRequests: 0 }, timing: { elapsedMs: 0, outputTokens: 0 }, contextTokens: 0, contextWindow: 0, compactions: 0, toolFailures: 0 },
  };
}

export function normalizeState(next: WireState, previous?: State): State {
  if (!next || !next.settings || !Array.isArray(next.messages) || !Array.isArray(next.workspaces) || !Array.isArray(next.conversations)) throw new Error('The local service returned an invalid state.');
  // Stream frames recreate every JSON object. Reuse unchanged collection
  // members so shell subscribers can skip frames that only append message text.
  return {
    ...next,
    workspaces: reuseItems(previous?.workspaces, next.workspaces || [], sameFields),
    conversations: reuseItems(previous?.conversations, next.conversations || [], sameFields),
    messages: next.messages || [],
    runs: reuseItems(previous?.runs, Array.isArray(next.runs) ? next.runs : [], sameFields),
    queuedMessages: Array.isArray(next.queuedMessages) ? next.queuedMessages : [],
  };
}

function sameFields(a: object, b: object): boolean {
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return aKeys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

function reuseItems<T>(previous: readonly T[] | undefined, next: T[], equal: (a: T, b: T) => boolean): T[] {
  if (!previous || previous.length !== next.length) return next;
  let changed = false;
  const items = next.map((item, index) => {
    if (equal(previous[index], item)) return previous[index];
    changed = true;
    return item;
  });
  return changed ? items : previous as T[];
}
