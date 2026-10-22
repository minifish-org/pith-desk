import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebPreview} from '../src/web-preview.ts';

function harness() {
  let active=true,disabled=false,state:any,address='',answer:(()=>Promise<any>)|undefined;
  const calls:any[]=[];
  const controller=createWebPreview({view:{update(next:any){state=next;},resetAddress(next:string){address=next;},destroy(){}},
    request:(async(path:string,input:any)=>{calls.push({path,input});if(path==='/api/web-preview/close')return {ok:true};return answer?answer():{id:'grant-1',url:'https://preview.example.test/_pith_preview#grant=secret',externalUrl:'https://preview.example.test/'};}) as any,
    workspaceId:'original',active:()=>active,disabled:()=>disabled});controller.sync();
  return {controller,calls,state:()=>state,address:()=>address,set active(value:boolean){active=value;},set disabled(value:boolean){disabled=value;},respond(value:()=>Promise<any>){answer=value;}};
}
test('preview uses the original workspace, explicit refresh and scoped close; it never sends navigation through Agent state',async()=>{
  const h=harness();await h.controller.navigate(' http://localhost:5173/path ');
  assert.deepEqual(h.calls[0],{path:'/api/web-preview',input:{workspaceId:'original',address:'http://localhost:5173/path'}});assert.equal(h.address(),'http://localhost:5173/path');
  h.controller.sync();h.controller.sync();assert.equal(h.calls.length,1);
  await h.controller.refresh();assert.equal(h.calls.length,2);assert.equal(h.state().revision,2);
  h.active=false;h.controller.sync();assert.equal(h.state().url,'');assert.equal(h.state().disabled,true);assert.deepEqual(h.calls.at(-1),{path:'/api/web-preview/close',input:{id:'grant-1'}});
  h.active=true;h.controller.sync();assert.equal(h.calls.length,3);assert.equal(h.state().url,'');h.controller.destroy();
});
test('hidden, revoked and destroyed views reject controls and retire late grants without replacing the current view',async()=>{
  const h=harness();let resolve!:(value:any)=>void;h.respond(()=>new Promise(done=>{resolve=done;}));
  const opening=h.controller.navigate('http://localhost:5173');h.active=false;h.controller.sync();
  resolve({id:'late',url:'https://preview.example.test/',externalUrl:'https://preview.example.test/'});await opening;
  assert.equal(h.state().url,'');assert.equal(h.calls.at(-1).input.id,'late');const count=h.calls.length;
  await h.controller.navigate('http://localhost:5174');assert.equal(h.calls.length,count);
  h.active=true;h.disabled=true;h.controller.sync();await h.controller.navigate('http://localhost:5174');assert.equal(h.calls.length,count);
  h.controller.destroy();h.active=true;h.disabled=false;await h.controller.navigate('http://localhost:5174');assert.equal(h.calls.length,count);
});
test('a failed navigation keeps the accepted address and frame without replaying the request',async()=>{
  const h=harness();await h.controller.navigate('https://example.test/');const before=h.state().url;
  h.respond(()=>Promise.reject(new Error('Rejected target')));await h.controller.navigate('javascript:bad');assert.equal(h.address(),'https://example.test/');assert.equal(h.state().url,before);assert.match(h.state().error,/Rejected target/);
  h.controller.sync();assert.equal(h.calls.length,2);h.controller.destroy();
});
