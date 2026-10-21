import {APIError, createAPI} from './api.ts';
import type {Application} from './ui-contract.ts';

// Access stores only the renewable page lease. The login token is sent once,
// then discarded; the browser session cookie is HttpOnly. Draft recovery has
// its own text-only storage and never persists authentication tokens.
export function createServerSession(options: {recoveryText?(): string} = {}) {
  const storageKey = 'pith-desk-server-lease';
  const api = createAPI(() => {
    const headers = new Headers({'Content-Type': 'application/json'});
    if (lease) headers.set('X-Desk-Lease', lease);
    return headers;
  });
  let lease = '', sequence = 0, active = false, started = false, stopped = false, checking = false, acquiring = false;
  let ui: Application | undefined, onReady = () => {}, onLost = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let panel: ReturnType<Application['openServerAccess']> | undefined;
  let lastRenewed = Date.now(), expiresIn = 45000;
  const savedLease = () => {try {return sessionStorage.getItem(storageKey) || '';} catch {return '';}};
  const saveLease = (value: string) => {try {if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey);} catch {}};
  // Browsers copy sessionStorage when duplicating a tab. Only an actual reload
  // or history return may resume that saved lease without explicit takeover.
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  let resume = navigation?.type === 'reload' || navigation?.type === 'back_forward' ? savedLease() : '';
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  function show(phase: 'login'|'blocked'|'offline', error = ''): void {
    if (!ui || stopped) return;
    panel?.destroy();
    panel = ui.openServerAccess({phase, error, recoveryText: options.recoveryText?.()}, {
      async onLogin(token) {
        await api.request('/api/server/login', {token});
        // Start a fresh page with the HttpOnly cookie, including authenticated
        // Vite HMR in development. The login token is never stored for reload.
        window.location.reload();
      },
      onContinue: () => acquire(true),
    });
  }
  function lost(status: number): void {
    if (stopped || !active) return;
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (savedLease() === lease) saveLease('');
    resume = '';
    onLost();
    show(status === 401 ? 'login' : 'blocked');
  }
  async function acquire(takeover: boolean): Promise<void> {
    if (acquiring || stopped) return;
    acquiring = true;
    try {
      const result = await api.request('/api/server/lease', {resume, takeover});
      if (stopped) return;
      lease = result.lease; sequence = 0; active = true; lastRenewed = Date.now(); expiresIn = result.expiresIn * 1000;
      saveLease(lease);
      resume = lease;
      panel?.destroy(); panel = undefined;
      if (started) {window.location.reload(); return;}
      started = true;
      timer = setInterval(() => {void check().catch(() => {});}, 10000);
      onReady();
    } catch (error) {
      if (error instanceof APIError && error.status === 401) show('login', message(error));
      else if (error instanceof APIError && error.status === 409) show('blocked');
      else throw error;
    } finally {acquiring = false;}
  }
  async function check(): Promise<void> {
    if (!active || stopped || checking) return;
    checking = true;
    const observedLease = lease;
    try {
      await api.request('/api/server/heartbeat', {});
      if (stopped || lease !== observedLease) return;
      lastRenewed = Date.now();
    } catch (error) {
      if (stopped || lease !== observedLease) return;
      if (error instanceof APIError && [401,409].includes(error.status)) lost(error.status);
      else if (Date.now() - lastRenewed >= expiresIn) {
        active = false; onLost();
        if (timer) clearInterval(timer);
        timer = undefined;
        show('offline', 'Connection lost. Tasks continue on the server. Reconnect to read their current state.');
      }
      throw error;
    } finally {checking = false;}
  }
  return {
    headers(json = false): Headers {
      if (!active || stopped) throw new Error('Reconnect to Pith Desk Server before continuing.');
      const headers = new Headers({'X-Desk-Lease': lease});
      if (json) {headers.set('Content-Type', 'application/json'); headers.set('X-Desk-Request', String(++sequence));}
      return headers;
    },
    protocols: () => ['pith-desk', `lease.${lease}`],
    failed(status: number) {if ([401,409].includes(status)) lost(status);},
    check,
    async logout(): Promise<void> {
      if (!active || stopped) return;
      await api.request('/api/server/logout', {});
      lost(401);
    },
    async start(application: Application, ready: () => void, revoked: () => void): Promise<void> {
      ui = application; onReady = ready; onLost = revoked;
      try {
        const session = await api.request('/api/server/session', {});
        if (session.authenticated) await acquire(false);
        else show('login');
      } catch (error) {show('offline', message(error));}
    },
    dispose() {stopped = true; active = false; if (timer) clearInterval(timer); panel?.destroy();},
  };
}
