import {useEffect, useRef, useState} from 'react';
import {Terminal as XTerm} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {LoaderCircle} from 'lucide-react';
import {request} from '@/actions/core';
import {closeToolTab} from '@/actions/workspace-tools.ts';
import {runtime} from '@/lib/runtime';
import type {TerminalControl, TerminalEvent} from '@/contract.generated.ts';

interface Props {
  workspaceId: string;
  tabId: string;
  active: boolean;
}

export function TerminalView({workspaceId, tabId, active}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Connecting…');
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const session = useRef<{socket?: WebSocket; generation: number; timer?: ReturnType<typeof setTimeout>; delay: number}>({generation: 0, delay: 500});
  const terminal = useRef<XTerm | undefined>(undefined);
  const fit = useRef<FitAddon | undefined>(undefined);
  const connectedRef = useRef(false);
  const replaying = useRef(false);
  const retrying = useRef(false);
  const cursor = useRef(0);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.35,
      fontFamily: 'Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: themeFor(document.documentElement.classList.contains('dark')),
      allowProposedApi: false,
      scrollback: 5000,
      screenReaderMode: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    term.textarea?.setAttribute('aria-label', 'Terminal input');
    terminal.current = term;
    fit.current = fitAddon;
    try {fitAddon.fit();} catch { /* Layout settles after the first frame. */ }

    const onData = term.onData(data => {
      if (replaying.current) return;
      send({type: 'input', data});
    });
    const onResize = term.onResize(({cols, rows}) => send({type: 'resize', cols, rows}));
    let fitFrame = 0, fitTimer: ReturnType<typeof setTimeout> | undefined, lastFit = 0;
    const fitNow = () => {
      if (!active) return;
      try {fitAddon.fit();} catch { /* Hidden panels have no measurable size. */ }
    };
    // Resizing the rail fires one observer callback per pointer frame. Coalesce
    // xterm's expensive fit pass to at most one per frame and at most ~12/s.
    const scheduleFit = () => {
      if (fitFrame) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0;
        const now = performance.now();
        if (now - lastFit >= 80) {
          lastFit = now;
          fitNow();
          return;
        }
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {lastFit = performance.now(); fitNow();}, 80);
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);
    const themeObserver = new MutationObserver(() => {
      const next = document.documentElement.classList.contains('dark');
      setDark(next);
      term.options.theme = themeFor(next);
    });
    themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});

    let cancelled = false;
    void attach().catch(failure => {if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));});

    return () => {
      cancelled = true;
      session.current.generation++;
      session.current.socket?.close();
      clearTimeout(session.current.timer);
      onData.dispose();
      onResize.dispose();
      observer.disconnect();
      if (fitFrame) cancelAnimationFrame(fitFrame);
      if (fitTimer) clearTimeout(fitTimer);
      themeObserver.disconnect();
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
    };
    // The tab identity is the lifetime boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, tabId]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {fit.current?.fit();} catch { /* Not measurable yet. */ }
      if (connectedRef.current) terminal.current?.focus();
      const size = readSize();
      send({type: 'resize', cols: size.cols, rows: size.rows});
    });
  }, [active]);

  function readSize(): {cols: number; rows: number} {
    const term = terminal.current;
    return {cols: Math.min(500, Math.max(2, term?.cols || 80)), rows: Math.min(300, Math.max(1, term?.rows || 24))};
  }

  function send(control: TerminalControl): boolean {
    const socket = session.current.socket;
    if (!socket || !connectedRef.current || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > 32 * 1024) {
      setError('Terminal input was not sent: connection is busy. Try again after it recovers.');
      return false;
    }
    socket.send(JSON.stringify(control));
    return true;
  }

  async function lookup() {
    try {
      const result = await request('/api/terminal', {query: {workspaceId, id: tabId}});
      return {session: result.session, location: result.location};
    } catch {
      return undefined;
    }
  }

  // Adopt this tab's shell, starting one when the service has none: a new tab,
  // or a session it dropped while the link was down.
  async function attach() {
    const generation = session.current.generation;
    const result = await lookup();
    if (generation !== session.current.generation) return;
    if (result?.session) {connect(); return;}
    const size = readSize();
    const started = await request('/api/terminal', {workspaceId, id: tabId, cols: size.cols, rows: size.rows});
    if (generation !== session.current.generation) return;
    if (started.session && (started.session.id !== tabId || started.session.workspaceId !== workspaceId)) throw new Error('Terminal session changed');
    if (!started.session) {setStatus('Terminal session ended. Close this tab and create a new terminal.'); return;}
    connect(true);
  }

  function scheduleRetry() {
    session.current.timer = setTimeout(() => {
      session.current.timer = undefined;
      void attach().catch(scheduleRetry);
    }, session.current.delay);
    session.current.delay = Math.min(5000, session.current.delay * 2);
  }

  function connect(focus = false) {
    if (session.current.socket) return;
    const generation = session.current.generation;
    let ws: WebSocket;
    try {
      const url = new URL('/api/terminal/socket', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('workspaceId', workspaceId);
      url.searchParams.set('id', tabId);
      ws = new WebSocket(url, runtime.protocols());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    session.current.socket = ws;
    connectedRef.current = false;
    replaying.current = true;
    // While reconnecting, keep the outage notice instead of blinking back to
    // "Connecting…" on every attempt.
    if (!retrying.current) setStatus('Connecting…');
    let ready = false;
    let exited = false;
    // A shell that ends leaves nothing to type into or restore, so its tab goes
    // away entirely. Closing reuses the explicit close so the host drops it.
    const closeExited = () => {
      exited = true;
      ws.close();
      void closeToolTab(workspaceId, tabId);
    };

    ws.onmessage = event => {
      if (generation !== session.current.generation || exited) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 64 * 1024) throw new Error('Invalid terminal frame');
        const data = JSON.parse(event.data) as TerminalEvent;
        if (data.type === 'ready') {
          if (ready || data.session?.id !== tabId || data.session?.workspaceId !== workspaceId) throw new Error('Terminal session changed');
          if (data.session?.running === false) { closeExited(); return; }
          ready = true;
          terminal.current?.reset();
          terminal.current?.resize(data.session.cols, data.session.rows);
          cursor.current = 0;
          setStatus('Restoring terminal output…');
        } else if (data.type === 'output') {
          if (!ready || typeof data.data !== 'string' || !Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.end) || data.start < cursor.current || data.end < data.start || data.end - data.start > 32 * 1024 || (data.start !== cursor.current && !data.truncated)) throw new Error('Invalid terminal output');
          const bytes = Uint8Array.from(atob(data.data), character => character.charCodeAt(0));
          if (bytes.length !== data.end - data.start) throw new Error('Invalid terminal byte count');
          if (data.truncated) {
            terminal.current?.reset();
            setNotice('Earlier terminal output was truncated (1 MiB replay limit). The display was reset; full-screen programs may need a redraw.');
          }
          terminal.current?.write(bytes, () => {
            if (generation !== session.current.generation) return;
            cursor.current = data.end;
            ws.send(JSON.stringify({type: 'ack', end: cursor.current} satisfies TerminalControl));
          });
        } else if (data.type === 'live') {
          if (!ready) throw new Error('Terminal was not initialized');
          connectedRef.current = true;
          replaying.current = false;
          retrying.current = false;
          session.current.delay = 500;
          setConnected(true);
          setError('');
          setStatus('');
          requestAnimationFrame(() => {
            try {fit.current?.fit();} catch { /* Not measurable yet. */ }
            const size = readSize();
            send({type: 'resize', cols: size.cols, rows: size.rows});
            if (focus && active) terminal.current?.focus();
          });
        } else if (data.type === 'exit') {
          closeExited();
        } else throw new Error('Unknown terminal event');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        connectedRef.current = false;
        ws.close();
      }
    };
    ws.onclose = () => {
      if (generation !== session.current.generation || exited) return;
      session.current.socket = undefined;
      connectedRef.current = false;
      setConnected(false);
      replaying.current = false;
      retrying.current = true;
      setStatus('Disconnected · reconnecting. Input is disabled and will not be replayed.');
      void runtime.checkAccess().catch(() => {});
      scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? <p className="border-b bg-destructive/10 px-2 py-1 text-[11px] text-destructive" role="alert">{error}</p> : null}
      <div className="relative min-h-0 flex-1 bg-[var(--code-surface)] p-1.5">
        <div
          ref={host} role="group" aria-label="Interactive terminal" data-terminal-viewport=""
          aria-description={error || notice || (!connected ? status : undefined)}
          aria-disabled={!connected} className="h-full w-full"
          style={{backgroundColor: themeFor(dark).background, color: themeFor(dark).foreground, fontSize: 12, '--terminal-surface': themeFor(dark).background} as React.CSSProperties}
        />
        {!connected && !error ? <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />{status}</div> : null}
      </div>
    </div>
  );
}

function themeFor(dark: boolean) {
  return dark
    ? {background: '#171717', foreground: '#e5e5e5', cursor: '#e5e5e5', selectionBackground: '#3f3f3f'}
    : {background: '#fafafa', foreground: '#1a1a1a', cursor: '#1a1a1a', selectionBackground: '#d4d4d4'};
}
