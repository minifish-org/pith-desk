import type {ApiRequest} from './api.ts';
import type {Info,TerminalControl,TerminalEvent,Workspace} from './contract.generated.ts';
import type {Application} from './ui-contract.ts';

/** Manual shell coordinator. It never reads or writes Agent/composer state. */
export function createWorkspaceTerminal(api: {
  ui: Application;request: ApiRequest;workspace(): Workspace|undefined;disabled(): boolean;
  protocols(): string[];checkAccess?(): Promise<void>;origin?: string;
  socket?(url: string,protocols: string[]): WebSocket;
}) {
  let alive = true,epoch = 0,connection = 0,workspace: Workspace|undefined,info: Info|undefined,location = '';
  let socket: WebSocket|undefined,timer: ReturnType<typeof setTimeout>|undefined,read: AbortController|undefined;
  let loaded = false,pending = false,connected = false,opening = false,delay = 500,error = '',notice = '',status = '';
  const visible = () => api.ui.files.areToolsOpen() && api.ui.files.toolView() === 'terminal';
  const current = (generation: number,id?: string) => alive && generation === epoch && (!id || workspace?.id === id) && workspace?.id === api.workspace()?.id;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  function paint(): void {
    if (!alive) return;
    api.ui.terminal.update({id: `${workspace?.id ?? ''}/${info?.id ?? ''}`,location,directory: workspace ? 'Initial directory: '+(info?.directory ?? workspace.path) : '',status: status || (info ? info.running ? 'Connecting…' : `Shell exited (${info.exitCode}). Close it to start a new terminal.` : 'Start an interactive shell for this workspace.'),
      connected,exists: !!info,disabled: api.disabled() || !workspace,pending,notice,error});
  }
  function detach(): void {
    connection++;connected = false;opening = false;clearTimeout(timer);timer = undefined;
    const previous = socket;socket = undefined;previous?.close();
  }
  function send(control: TerminalControl): boolean {
    if (!alive || !current(epoch) || api.disabled() || !connected || socket?.readyState !== 1) return false;
    if (socket.bufferedAmount > 32*1024) {error = 'Terminal input was not sent: connection is busy. Try again after it recovers.';paint();return false;}
    socket.send(JSON.stringify(control));return true;
  }
  function input(data: string): void {
    if (new TextEncoder().encode(data).length > 16*1024) {error = 'Paste is limited to 16 KiB at a time. This input was not sent.';paint();return;}
    if (!send({type: 'input',data}) && alive && !connected) {error = 'Terminal is disconnected. Input was not sent and will not be replayed.';paint();}
  }
  function resize(size: {cols: number;rows: number}): void {
    if (info?.running) send({type: 'resize',cols: Math.min(500,Math.max(2,size.cols)),rows: Math.min(300,Math.max(1,size.rows))});
  }
  function connect(focus = false): void {
    if (!alive || !info || socket || opening || api.disabled()) return;
    const generation = epoch,target = info,attempt = ++connection;
    opening = true;connected = false;status = 'Connecting…';paint();
    const url = new URL('/api/terminal/socket',api.origin ?? window.location.href);url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('workspaceId',target.workspaceId);url.searchParams.set('id',target.id);
    let ws: WebSocket;
    try {ws = (api.socket ?? ((url,protocols) => new WebSocket(url,protocols)))(url.toString(),api.protocols());}
    catch (failure) {opening = false;error = message(failure);paint();return;}
    socket = ws;
    let ready = false,exited = false,cursor = 0,live = false;
    const valid = () => current(generation,target.workspaceId) && connection === attempt && socket === ws;
    ws.onmessage = event => {
      if (!valid()) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 64*1024) throw new Error('Invalid terminal frame');
        const data = JSON.parse(event.data) as TerminalEvent;
        if (data.type === 'ready') {
          if (ready || data.session?.id !== target.id || data.session?.workspaceId !== target.workspaceId) throw new Error('Terminal session changed');
          ready = true;info = data.session;api.ui.terminal.reset({cols: info.cols,rows: info.rows});status = 'Restoring terminal output…';paint();
        } else if (data.type === 'output') {
          if (!ready || typeof data.data !== 'string' || !Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.end) || data.start < cursor || data.end < data.start || data.end-data.start > 32*1024 || data.start !== cursor && !data.truncated) throw new Error('Invalid terminal output');
          const bytes = Uint8Array.from(atob(data.data),char => char.charCodeAt(0));
          if (bytes.length !== data.end-data.start) throw new Error('Invalid terminal byte count');
          if (data.truncated) {api.ui.terminal.reset(api.ui.terminal.readSize());notice = 'Earlier terminal output was truncated (1 MiB replay limit). The display was reset; full-screen programs may need a redraw.';paint();}
          // Suppress emulator-generated device replies during replay, so old
          // escape sequences cannot synthesize new input on reconnect.
          api.ui.terminal.write(bytes,() => {
            if (!valid()) return;cursor = data.end;
            ws.send(JSON.stringify({type: 'ack',end: cursor} satisfies TerminalControl));
          });
        } else if (data.type === 'live') {
          if (!ready) throw new Error('Terminal was not initialized');
          live = true;connected = !!info?.running;opening = false;delay = 500;status = connected ? 'Connected · manual shell' : `Shell exited (${info?.exitCode ?? -1}). Close it to start another.`;error = '';
          paint();api.ui.terminal.fit();resize(api.ui.terminal.readSize());if (focus && visible()) api.ui.terminal.focus();
        } else if (data.type === 'exit') {
          if (!ready || data.session?.id !== target.id || data.session?.workspaceId !== target.workspaceId) throw new Error('Invalid terminal exit');
          exited = true;info = data.session;connected = false;opening = false;status = `Shell exited (${info.exitCode}). Close it to start a new terminal.`;paint();
        } else throw new Error('Unknown terminal event');
      } catch (failure) {error = message(failure);connected = false;ws.close();paint();}
    };
    ws.onclose = () => {
      if (!valid()) return;socket = undefined;opening = false;connected = false;
      if (exited) {paint();return;}
      status = 'Disconnected · shell continues. Input is disabled and will not be replayed.';paint();void api.checkAccess?.().catch(() => {});
      timer = setTimeout(() => {timer = undefined;if (current(generation)) void lookup(true);},delay);delay = Math.min(5000,delay*2);
    };
    ws.onerror = () => {if (valid()) ws.close();};
  }
  async function lookup(reconnect = false): Promise<void> {
    if (!workspace || pending || read || !alive || api.disabled()) return;
    const generation = epoch,id = workspace.id,controller = new AbortController();read = controller;
    try {
      const result = await api.request('/api/terminal',{query: {workspaceId: id},signal: controller.signal});
      if (!current(generation,id) || read !== controller) return;
      location = result.location;info = result.session ?? undefined;loaded = true;
      if (info) connect();else {status = '';api.ui.terminal.reset();}
    } catch (failure) {
      if (!current(generation,id) || read !== controller) return;error = message(failure);
      if (reconnect) timer = setTimeout(() => {timer = undefined;void lookup(true);},delay);
    } finally {if (current(generation,id) && read === controller) {read = undefined;paint();}}
  }
  function sync(): void {
    if (!alive) return;
    const next = api.workspace();
    if (workspace?.id !== next?.id) {
      epoch++;detach();read?.abort();read = undefined;workspace = next;info = undefined;loaded = false;pending = false;
      error = '';notice = '';status = '';location = '';delay = 500;api.ui.terminal.reset();
    }
    if (workspace && visible() && !loaded && !read) void lookup();
    if (visible()) api.ui.terminal.fit();paint();
  }
  async function start(): Promise<void> {
    if (!workspace || pending || info || api.disabled()) return;
    read?.abort();read = undefined;
    const generation = epoch,id = workspace.id;pending = true;error = '';notice = '';paint();
    try {
      const size = api.ui.terminal.readSize();
      const result = await api.request('/api/terminal',{workspaceId: id,cols: Math.min(500,Math.max(2,size.cols)),rows: Math.min(300,Math.max(1,size.rows))});
      if (!current(generation,id)) return;info = result.session ?? undefined;location = result.location;loaded = true;connect(true);
    } catch (failure) {if (current(generation,id)) {error = message(failure);loaded = false;}}
    finally {if (current(generation,id)) {pending = false;paint();}}
  }
  async function close(): Promise<void> {
    if (!info || pending || api.disabled()) return;
    read?.abort();read = undefined;
    const generation = epoch,target = info;pending = true;detach();paint();
    try {
      await api.request('/api/terminal/close',{workspaceId: target.workspaceId,id: target.id});
      if (!current(generation,target.workspaceId)) return;info = undefined;status = '';notice = '';error = '';api.ui.terminal.reset();
    } catch (failure) {if (current(generation,target.workspaceId)) {error = message(failure);loaded = false;}}
    finally {if (current(generation,target.workspaceId)) {pending = false;paint();}}
  }
  return {sync,start,close,input,resize,destroy() {if (!alive) return;connected = false;status = 'Terminal connection closed. The shell continues until explicitly closed or the service exits.';paint();alive = false;epoch++;detach();read?.abort();read = undefined;}};
}
