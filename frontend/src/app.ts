import { createAPI, parseStream } from './api.ts';
import { initialState, normalizeState, type State } from './app-state.ts';
import type { AppearanceMode, State as WireState } from './contract.generated.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

interface AppOptions {
  token: string;
  origin: string;
  appearance: AppearanceMode;
  onSnapshot: (next: State, previous: State, initialized: boolean) => void;
  onConnection: (status: ConnectionStatus) => void;
  onError: (message: string) => void;
  session?: {
    headers(json?: boolean): Headers;
    protocols(): string[];
    failed(status: number): void;
    check(): Promise<void>;
  };
}

// Own the single frontend snapshot and its HTTP/WS ingress. Features use the
// typed API and read this projection; they keep their own transient UI state.
export function createApp(options: AppOptions) {
  const api = createAPI((json = false) => {
    if (options.session) return options.session.headers(json);
    const headers = new Headers();
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (json) headers.set('Content-Type', 'application/json');
    return headers;
  }, options.session?.failed);
  let state = initialState(options.appearance);
  let loaded = false;
  let receivedAt = performance.now();
  let connection: ConnectionStatus = 'connecting';
  let version = 0;
  let refreshGeneration = 0;
  let started = false;
  let disposed = false;
  let socket: WebSocket | undefined;
  let endSocket: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let endRetry: (() => void) | undefined;
  const reads = new Set<AbortController>();

  // Retired pages may still receive a successful response from an already
  // admitted write. Never let it clear drafts or start a follow-up operation.
  function guard<T extends (...args: never[]) => Promise<unknown>>(action: T): T {
    return ((...args: Parameters<T>) => {
      if (disposed) return Promise.reject(new Error('This page is disconnected. Reconnect to continue.'));
      return action(...args).then(result => {
        if (disposed) throw new Error('This page is disconnected. Check the current task before trying again.');
        return result;
      });
    }) as T;
  }

  function accept(next: WireState): void {
    const previous = state;
    const initialized = loaded;
    state = normalizeState(next);
    loaded = true;
    receivedAt = performance.now();
    version++;
    options.onSnapshot(state, previous, initialized);
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    const generation = ++refreshGeneration;
    const observedVersion = version;
    const controller = new AbortController();
    reads.add(controller);
    try {
      const next = await api.request('/api/state', { signal: controller.signal });
      // A stream update or a newer read supersedes this in-flight response.
      // This is local ingress ordering; it adds no server protocol/version.
      if (!disposed && generation === refreshGeneration && observedVersion === version) accept(next);
    } catch (error) {
      if (!disposed) throw error;
    } finally { reads.delete(controller); }
  }

  function setConnection(next: ConnectionStatus): void {
    connection = next;
    options.onConnection(next);
  }

  function waitToRetry(delay: number): Promise<void> {
    return new Promise((resolve) => {
      endRetry = resolve;
      retryTimer = setTimeout(() => { retryTimer = undefined; endRetry = undefined; resolve(); }, delay);
    });
  }

  async function stream(): Promise<void> {
    let retryDelay = 700;
    while (!disposed) {
      try {
        await new Promise<void>((resolve, reject) => {
          const url = new URL('/api/socket', options.origin);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          const current = new WebSocket(url.href, options.session?.protocols() ?? (options.token ? ['pith-desk', `bearer.${options.token}`] : ['pith-desk']));
          socket = current;
          endSocket = resolve;
          let transportError = '';
          current.onopen = () => {
            if (disposed || socket !== current) { current.close(); return; }
            setConnection('connected');
          };
          current.onmessage = (event) => {
            if (disposed || socket !== current) return;
            try {
              if (typeof event.data !== 'string') throw new Error('The local service returned an invalid event.');
              accept(parseStream('/api/socket', event.data));
              retryDelay = 700;
            } catch (error) {
              transportError = error instanceof Error ? error.message : String(error);
              current.close(1003, 'Invalid state');
            }
          };
          current.onerror = () => { transportError = 'Could not connect to the local event service.'; };
          current.onclose = () => {
            if (socket === current) { socket = undefined; endSocket = undefined; }
            if (disposed) resolve();
            else void Promise.resolve(options.session?.check()).catch(() => {}).finally(() => {
              if (disposed) resolve();
              else reject(new Error(transportError || 'The event connection closed.'));
            });
          };
        });
      } catch (error) {
        if (disposed) return;
        setConnection('reconnecting');
        if (!loaded) options.onError(error instanceof Error ? error.message : String(error));
        await waitToRetry(retryDelay);
        if (disposed) return;
        retryDelay = Math.min(retryDelay * 1.6, 10000);
        try { await refresh(); } catch { /* The connection indicator explains the interruption. */ }
      }
    }
  }

  return {
    request: guard(api.request),
    download: guard(api.download),
    refresh,
    // Called only after the matching /api/read command has committed.
    confirmRead(id: string, runID: string): void {
      const entry = state.conversations.find((entry) => entry.id === id);
      if (entry?.completedRunId === runID) { entry.unread = false; version++; }
    },
    get state() { return state; },
    get loaded() { return loaded; },
    get receivedAt() { return receivedAt; },
    get connection() { return connection; },
    async start(): Promise<void> {
      if (started || disposed) return;
      started = true;
      try { await refresh(); } catch (error) { if (!disposed) options.onError(error instanceof Error ? error.message : String(error)); }
      if (!disposed) void stream();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const read of reads) read.abort();
      socket?.close();
      socket = undefined;
      endSocket?.();
      endSocket = undefined;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      endRetry?.();
      endRetry = undefined;
    },
  };
}

export {readAppBootstrap} from './ui-bootstrap.ts';
