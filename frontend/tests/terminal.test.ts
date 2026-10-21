import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceTerminal} from '../src/terminal.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {let resolve!: (value: T)=>void;const promise = new Promise<T>(done => {resolve = done;});return {promise,resolve};}
function harness(request: (...args: any[])=>Promise<any>) {
  let workspace = {id: 'one',path: '/one',name: 'One'},state: any,view = 'terminal',open = true,disabled = false;
  const writes: string[] = [],parsed: Array<()=>void> = [],sockets: any[] = [];
  const ui: any = {files: {areToolsOpen: () => open,toolView: () => view},terminal: {update(next: any) {state = next;},reset() {},fit() {},focus() {},readSize: () => ({cols: 80,rows: 24}),write(bytes: Uint8Array,done: ()=>void) {writes.push(new TextDecoder().decode(bytes));parsed.push(done);}}};
  const terminal = createWorkspaceTerminal({ui,request: request as any,workspace: () => workspace,disabled: () => disabled,protocols: () => ['pith-desk','lease.test'],origin: 'http://localhost',socket() {const socket: any = {readyState: 1,bufferedAmount: 0,sent: [],send(data: string) {this.sent.push(JSON.parse(data));},close() {this.readyState = 3;this.onclose?.();},event(value: any) {this.onmessage?.({data: JSON.stringify(value)});}};sockets.push(socket);return socket;}});
  return {terminal,sockets,writes,parsed,state: () => state,setWorkspace(id: string) {workspace = {id,path: '/'+id,name: id};},hide() {open = false;view = 'files';},disable() {disabled = true;}};
}
const session = (workspaceId: string,id = workspaceId) => ({id,workspaceId,directory: '/'+workspaceId,shell: '/bin/sh',running: true,cols: 80,rows: 24,exitCode: -1});
const response = (workspaceId: string) => ({location: 'Test host',session: session(workspaceId)});
const ready = (socket: any,id = 'one') => {socket.event({type: 'ready',session: session(id),start: 0,end: 0});socket.event({type: 'live',start: 0,end: 0});};

test('workspace switches retire delayed reads, starts, frames and parse acknowledgements',async () => {
  const read = deferred<any>();
  const h = harness(async (_path,input) => input?.query?.workspaceId === 'one' ? read.promise : response('two'));
  h.terminal.sync();h.setWorkspace('two');h.terminal.sync();await tick();read.resolve(response('one'));await tick();
  assert.equal(h.sockets.length,1);ready(h.sockets[0],'two');assert.equal(h.state().directory,'Initial directory: /two');
  h.sockets[0].event({type: 'output',data: btoa('two'),start: 0,end: 3});h.setWorkspace('three');h.terminal.sync();h.parsed[0]();
  assert.equal(h.sockets[0].sent.filter((item:any) => item.type === 'ack').length,0);h.sockets[0].event({type: 'output',data: btoa('late'),start: 3,end: 7});assert.deepEqual(h.writes,['two']);h.terminal.destroy();
  const start = deferred<any>();const other = harness(async (_path,input) => input?.cols ? start.promise : {location: 'Host',session: null});
  other.terminal.sync();await tick();const pending = other.terminal.start();other.setWorkspace('two');other.terminal.sync();await tick();start.resolve(response('one'));await pending;
  assert.equal(other.sockets.length,0);assert.equal(other.state().exists,false);other.terminal.destroy();
});

test('parse ACK limits output and reconnect never replays input; hidden views retain the connection',async () => {
  const h = harness(async () => response('one'));h.terminal.sync();await tick();const ws = h.sockets[0];
  ws.event({type: 'ready',session: session('one'),start: 0,end: 3});
  ws.event({type: 'output',data: btoa('one'),start: 0,end: 3});h.terminal.input('during replay');assert.equal(ws.sent.length,0);
  h.parsed.shift()!();assert.deepEqual(ws.sent,[{type: 'ack',end: 3}]);ws.event({type: 'live',start: 0,end: 0});
  h.terminal.input('manual');assert.equal(ws.sent.at(-1).data,'manual');h.hide();h.terminal.sync();assert.equal(ws.readyState,1);
  ws.readyState = 3;ws.onclose();h.terminal.input('offline');h.terminal.resize({cols: 90,rows: 40});assert.equal(ws.sent.filter((item:any) => item.type === 'input').length,1);
  await new Promise(resolve => setTimeout(resolve,550));await tick();const next = h.sockets[1];ready(next);assert.equal(next.sent.filter((item:any) => item.type === 'input').length,0);
  h.disable();h.terminal.input('revoked');h.terminal.resize({cols: 10,rows: 2});assert.equal(next.sent.filter((item:any) => item.type === 'input').length,0);
  h.terminal.destroy();assert.equal(next.readyState,3);next.event({type: 'output',data: btoa('late'),start: 0,end: 4});assert.deepEqual(h.writes,['one']);
});

test('truncation is explicit; malformed, oversized and mismatched streams fail closed',async () => {
  const h = harness(async () => response('one'));h.terminal.sync();await tick();ready(h.sockets[0]);
  h.sockets[0].event({type: 'output',data: btoa('tail'),start: 100,end: 104,truncated: true});assert.match(h.state().notice,/truncated/);h.parsed.shift()!();
  h.terminal.input('x'.repeat(16385));assert.match(h.state().error,/16 KiB/);assert.equal(h.sockets[0].sent.filter((item:any) => item.type === 'input').length,0);
  h.sockets[0].event({type: 'output',data: btoa('bad'),start: 104,end: 200});assert.equal(h.sockets[0].readyState,3);h.terminal.destroy();
});

test('a delayed pre-start read cannot erase a newly opened session',async () => {
  const stale = deferred<any>();const h = harness(async (_path,input) => input?.query ? stale.promise : response('one'));
  h.terminal.sync();await h.terminal.start();ready(h.sockets[0]);assert.equal(h.state().exists,true);
  stale.resolve({location:'Host',session:null});await tick();assert.equal(h.state().exists,true);assert.match(h.state().status,/Connected/);h.terminal.destroy();
});
