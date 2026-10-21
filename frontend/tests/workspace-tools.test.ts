import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceToolsController,readToolLayout} from '../src/workspace-tools.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function storage() {
  const values = new Map<string,string>();
  return {values,getItem: (key:string) => values.get(key) ?? null,setItem: (key:string,value:string) => {values.set(key,value);},removeItem: (key:string) => {values.delete(key);}};
}
function harness(saved = storage(),initialSessions: any[] = []) {
  const workspaces = [{id:'one',name:'One',path:'/one'},{id:'two',name:'Two',path:'/two'}];
  let workspace = workspaces[0],state:any,disabled=false,serial=0;
  const views = new Map<string,any>(),calls:any[]=[],sessions=new Map<string,any>(initialSessions.map(info=>[info.id,info])),sockets:any[]=[];
  let respond: ((path:string,input:any)=>Promise<any>|undefined)|undefined;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis,'window'),oldSocket = Object.getOwnPropertyDescriptor(globalThis,'WebSocket');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{href:'http://localhost/'}}});
  Object.defineProperty(globalThis,'WebSocket',{configurable:true,value:class {
    readyState=1;bufferedAmount=0;sent:any[]=[];onmessage?: (event:any)=>void;onclose?: ()=>void;
    constructor(url:string) {sockets.push(this);queueMicrotask(()=>{const id=new URL(url).searchParams.get('id')!,info=sessions.get(id);this.onmessage?.({data:JSON.stringify({type:'ready',session:info})});this.onmessage?.({data:'{"type":"live"}'});});}
    send(data:string) {this.sent.push(JSON.parse(data));}
    close() {this.readyState=3;this.onclose?.();}
  }});
  function view(id:string,kind:string,callbacks:any) {
    const value:any={kind,callbacks,state:undefined,removed:false,restored:0,update(next:any) {this.state=next;},reset() {},fit() {},focus() {},readSize:()=>({cols:80,rows:24}),write(_bytes:Uint8Array,done:()=>void) {done();},restorePosition(top:number) {this.restored=top;},closeMenu() {},destroy() {this.removed=true;}};
    views.set(id,value);return value;
  }
  const controller = createWorkspaceToolsController({ui:{files:{areToolsOpen:()=>true,closeToolsOverlay() {}},tools:{update(next:any) {state=next;},closeMenu() {},createFiles:(id:string,callbacks:any)=>view(id,'files',callbacks),createTerminal:(id:string,callbacks:any)=>view(id,'terminal',callbacks)}} as any,
    request: (async (path:string,input:any) => {
      calls.push({path,input});const override=respond?.(path,input);if(override) return override;
      if(path==='/api/workspace-files') return {entries:[{name:'docs',path:'docs',directory:true}],truncated:false};
      if(path==='/api/terminal/close') {sessions.delete(input.id);return {ok:true};}
      if(input.query) return {location:'Server · test',session:sessions.get(input.query.id) ?? null,sessions:[...sessions.values()].filter(info=>info.workspaceId===input.query.workspaceId)};
      const info=sessions.get(input.id) ?? {id:input.id,workspaceId:input.workspaceId,directory:'/'+input.workspaceId,shell:'/bin/sh',cols:80,rows:24,running:true,exitCode:-1};sessions.set(info.id,info);return {session:info,location:'Server · test'};
    }) as any,workspace:()=>workspace,workspaces:()=>workspaces,disabled:()=>disabled,filesDisabled:()=>disabled,referenceDisabled:()=>disabled,server:true,native:false,changedDraft() {},clearPreview() {},fileAction:async()=>{},copy() {},protocols:()=>[],storage:saved,newID:()=>`view-${++serial}`});
  controller.sync();
  return {controller,saved,views,calls,sessions,sockets,state:()=>state,set disabled(value:boolean) {disabled=value;},switchWorkspace(index:number) {workspace=workspaces[index];controller.sync();},respond(fn:typeof respond) {respond=fn;},destroy() {controller.destroy();if(oldWindow) Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');if(oldSocket) Object.defineProperty(globalThis,'WebSocket',oldSocket);else Reflect.deleteProperty(globalThis,'WebSocket');}};
}

test('stored layouts are bounded, normalized and workspace-specific; empty layouts stay empty',() => {
  const saved=storage(),defaultLayout=readToolLayout(saved,'one',()=> 'default');assert.equal(defaultLayout.tabs[0].kind,'files');
  saved.setItem('pith-desk.tools.v1.one',JSON.stringify({tabs:[{id:'f',kind:'files',label:'Files',files:{query:'中文',expanded:['docs'],scrollTop:42},input:'never restore'}],activeId:'missing',next:{files:2,terminal:1}}));
  const restored=readToolLayout(saved,'one');assert.equal(restored.activeId,'f');assert.deepEqual(restored.tabs[0].files,{expanded:['docs'],scrollTop:42});assert.equal('input' in restored.tabs[0],false);
  assert.equal(readToolLayout(saved,'two',()=> 'other').activeId,'other');
  saved.setItem('pith-desk.tools.v1.one',JSON.stringify({...restored,tabs:[],activeId:''}));assert.deepEqual(readToolLayout(saved,'one').tabs,[]);
  saved.setItem('pith-desk.tools.v1.one',JSON.stringify({...restored,tabs:[restored.tabs[0],restored.tabs[0]]}));assert.equal(readToolLayout(saved,'one',()=> 'safe').activeId,'safe');
});

test('each Files view keeps expanded paths and scroll position through tabs, workspaces and refresh',async () => {
  const h=harness();try {
    await tick();const first=h.state().activeId,original=h.views.get(first);original.callbacks.onToggle({workspaceId:'one',path:'docs'},true);original.callbacks.onReadingPosition(123);await tick();
    h.controller.create('files');const second=h.state().activeId;assert.notEqual(first,second);h.views.get(second).callbacks.onReadingPosition(9);
    h.controller.select(first);assert.equal(original.state.directories.find((directory:any)=>directory.path==='docs').expanded,true);h.switchWorkspace(1);assert.equal(h.state().tabs.length,1);h.switchWorkspace(0);assert.equal(h.state().activeId,first);
    const saved=readToolLayout(h.saved,'one');assert.equal(saved.tabs[0].files?.scrollTop,123);assert.deepEqual(saved.tabs[0].files?.expanded,['docs']);assert.deepEqual(saved.tabs[1].files,{expanded:[],scrollTop:9});
    await h.controller.close(second);assert.equal(h.views.get(second).removed,true);assert.equal(h.calls.some(call=>call.path==='/api/terminal/close'),false);
    h.destroy();const again=harness(h.saved);try {await tick();assert.equal(again.views.get(first).state.directories.find((directory:any)=>directory.path==='docs').expanded,true);assert.equal(again.views.get(first).restored,123);} finally {again.destroy();}
  } finally {h.destroy();}
});

test('legacy Files filters are discarded without losing its layout or expanded directories',async()=>{
  const saved=storage();saved.setItem('pith-desk.tools.v1.one',JSON.stringify({tabs:[{id:'legacy',kind:'files',label:'Files',files:{query:'old filter',expanded:['docs'],scrollTop:42}}],activeId:'legacy',next:{files:2,terminal:1}}));
  const h=harness(saved);try {
    await tick();const view=h.views.get('legacy');assert.equal(h.state().activeId,'legacy');assert.equal(view.restored,42);assert.equal('query' in view.state,false);
    assert.equal(view.state.directories.find((directory:any)=>directory.path==='docs').expanded,true);
    assert.ok(h.calls.filter(call=>call.path==='/api/workspace-files').every(call=>!('query' in call.input.query)));
    assert.equal('query' in readToolLayout(saved,'one').tabs[0].files!,false);
  } finally {h.destroy();}
});

test('new terminals have stable identities, hidden views cannot send controls, and only explicit close ends a shell',async () => {
  const h=harness();try {
    await tick();h.controller.create('terminal');await tick();const first=h.state().activeId;h.controller.create('terminal');await tick();const second=h.state().activeId;
    assert.notEqual(first,second);assert.equal(h.sessions.size,2);const ws=h.sockets.at(-1);h.views.get(first).callbacks.onInput('late hidden input');h.views.get(second).callbacks.onInput('current');assert.deepEqual(ws.sent.filter((item:any)=>item.type==='input'),[{type:'input',data:'current'}]);
    const sent=ws.sent.length;h.switchWorkspace(1);h.views.get(second).callbacks.onInput('late workspace input');h.views.get(second).callbacks.onResize({cols:12,rows:2});assert.equal(ws.sent.length,sent);
    h.switchWorkspace(0);assert.equal(h.state().activeId,second);await h.controller.close(first);assert.equal(h.sessions.has(first),false);assert.equal(h.sessions.has(second),true);assert.equal(h.views.get(first).removed,true);
    const before=ws.sent.length;h.disabled=true;await h.controller.close(second);h.views.get(second).callbacks.onInput('revoked');assert.equal(h.sessions.has(second),true);assert.equal(ws.sent.length,before);
    h.destroy();assert.equal(h.sessions.has(second),true);assert.equal(ws.readyState,3);
  } finally {h.destroy();}
});

test('a late terminal creation stays with its workspace; restoring layout only reads existing sessions',async () => {
  const h=harness();try {
    await tick();let resolve!:(value:any)=>void;h.respond((path,input)=>path==='/api/terminal' && !input.query ? new Promise(done=>{resolve=done;}) : undefined);
    h.controller.create('terminal');const id=h.state().activeId;h.switchWorkspace(1);const active=h.state().activeId;
    const info={id,workspaceId:'one',directory:'/one',shell:'/bin/sh',cols:80,rows:24,running:true,exitCode:-1};h.sessions.set(id,info);resolve({session:info,location:'Server · first'});await tick();assert.equal(h.state().activeId,active);assert.equal(h.state().tabs.length,1);
    h.switchWorkspace(0);assert.equal(h.state().activeId,id);const saved=h.saved;h.destroy();const again=harness(saved,[info]);
    try {await tick();assert.equal(again.state().activeId,id);assert.equal(again.calls.filter(call=>call.path==='/api/terminal' && !call.input.query).length,0);assert.equal(again.sessions.size,1);assert.equal(again.sockets.length,1);} finally {again.destroy();}
  } finally {h.destroy();}
});

test('inventory recovers sessions without creating them; failed close keeps the tab for an explicit retry',async()=>{
  const info={id:'recovered',workspaceId:'one',directory:'/one',shell:'/bin/sh',cols:80,rows:24,running:true,exitCode:-1};
  const h=harness(storage(),[info]);try {
    await tick();assert.equal(h.state().tabs.length,2);assert.equal(h.calls.some(call=>call.path==='/api/terminal' && !call.input.query),false);
    h.controller.select(info.id);await tick();assert.equal(h.sockets.length,1);
    h.respond(path=>path==='/api/terminal/close'?Promise.reject(new Error('Close unavailable')):undefined);
    await h.controller.close(info.id);assert.equal(h.sessions.has(info.id),true);assert.equal(h.views.get(info.id).removed,false);assert.equal(h.state().tabs.length,2);assert.match(h.views.get(info.id).state.error,/Close unavailable/);
    h.respond(undefined);await h.controller.close(info.id);assert.equal(h.sessions.size,0);assert.equal(h.views.get(info.id).removed,true);assert.equal(h.state().tabs.length,1);
  } finally {h.destroy();}
});
