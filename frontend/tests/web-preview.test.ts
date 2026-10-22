import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebPreview} from '../src/web-preview.ts';

function harness(native=false,id='web-1') {
  let active=true,disabled=false,state:any,address='',answer:(()=>Promise<any>)|undefined,viewAnswer:(()=>Promise<any>)|undefined;
  const calls:any[]=[],tabs:any[]=[];
  const controller=createWebPreview({view:{update(next:any){state=next;},resetAddress(next:string){address=next;},destroy(){}},
    request:(async(path:string,input:any)=>{calls.push({path,input});if(path==='/api/web-preview/view' && viewAnswer)return viewAnswer();if(path!=='/api/web-preview')return {ok:true};return answer?answer():{id:'grant-1',url:'https://preview.example.test/_pith_preview#grant=secret',externalUrl:'https://preview.example.test/'};}) as any,
    id,workspaceId:'original',native,active:()=>active,disabled:()=>disabled,
    openTab(){const tab={url:'',closed:false,navigate(url:string){this.url=url;},close(){this.closed=true;}};tabs.push(tab);return tab;}});controller.sync();
  return {controller,calls,tabs,state:()=>state,address:()=>address,set active(value:boolean){active=value;},set disabled(value:boolean){disabled=value;},respond(value:()=>Promise<any>){answer=value;},respondView(value:()=>Promise<any>){viewAnswer=value;}};
}
test('Server opens independent tabs with original workspace targets; panel hiding, switching, closing and refresh never revoke earlier previews',async()=>{
  const h=harness();await h.controller.navigate(' http://localhost:5173/path ');
  assert.deepEqual(h.calls[0],{path:'/api/web-preview',input:{id:'web-1',workspaceId:'original',address:'http://localhost:5173/path'}});
  assert.equal(h.address(),'http://localhost:5173/path');assert.match(h.tabs[0].url,/grant=secret/);
  h.active=false;h.controller.sync();assert.equal(h.state().disabled,true);assert.equal(h.calls.length,1);
  h.active=true;h.controller.sync();await h.controller.refresh();assert.equal(h.tabs.length,2);assert.equal(h.calls.length,2);
  h.controller.destroy();assert.equal(h.calls.length,2);assert.equal(h.tabs.some(tab=>tab.closed),false);
});
test('an already requested Server tab completes independently when its tool view is destroyed',async()=>{
  const h=harness();let resolve!:(value:any)=>void;h.respond(()=>new Promise(done=>{resolve=done;}));
  const opening=h.controller.navigate('http://localhost:5173');assert.equal(h.tabs.length,1);h.controller.destroy();
  resolve({id:'late',url:'https://preview.example.test/',externalUrl:'https://preview.example.test/'});await opening;
  assert.equal(h.tabs[0].url,'https://preview.example.test/');assert.equal(h.calls.length,1);
});
test('Desktop retains its page when hidden; viewport geometry is separate from navigation and explicit close destroys only its page',async()=>{
  const h=harness(true);await h.controller.navigate('https://example.test/');
  const bounds={x:700,y:100,width:400,height:600};h.controller.viewport(bounds);await new Promise(done=>setImmediate(done));
  assert.deepEqual(h.calls.at(-1),{path:'/api/web-preview/view',input:{id:'web-1',bounds}});
  h.active=false;h.controller.sync();await new Promise(done=>setImmediate(done));
  assert.deepEqual(h.calls.at(-1).input,{id:'web-1',bounds:null});assert.notEqual(h.state().url,'');assert.equal(h.calls.some(c=>c.path.endsWith('/close')),false);
  h.active=true;h.controller.sync();await new Promise(done=>setImmediate(done));assert.deepEqual(h.calls.at(-1).input.bounds,bounds);
  h.controller.destroy();assert.deepEqual(h.calls.at(-1),{path:'/api/web-preview/close',input:{id:'grant-1'}});assert.equal(h.tabs.length,0);
});
test('revoked and destroyed Desktop controls reject writes and close late native pages',async()=>{
  const h=harness(true);let resolve!:(value:any)=>void;h.respond(()=>new Promise(done=>{resolve=done;}));
  const opening=h.controller.navigate('http://localhost:5173');h.controller.destroy();
  resolve({id:'late',url:'https://example.test/',externalUrl:'https://example.test/'});await opening;
  assert.equal(h.calls.at(-1).input.id,'late');const count=h.calls.length;await h.controller.navigate('http://localhost:5174');assert.equal(h.calls.length,count);
  const revoked=harness();revoked.disabled=true;await revoked.controller.navigate('https://example.test');assert.equal(revoked.calls.length,0);assert.equal(revoked.tabs.length,0);
});
test('a rejected navigation closes its reserved tab and keeps the accepted address without replaying writes',async()=>{
  const h=harness();await h.controller.navigate('https://example.test/');const before=h.state().url;
  h.respond(()=>Promise.reject(new Error('Rejected target')));await h.controller.navigate('javascript:bad');
  assert.equal(h.address(),'https://example.test/');assert.equal(h.state().url,before);assert.match(h.state().error,/Rejected target/);assert.equal(h.tabs[1].closed,true);
  h.controller.sync();assert.equal(h.calls.length,2);h.controller.destroy();
});

test('native placement is serialized across independent controllers so a late resize cannot cover a newly selected tab',async()=>{
  const first=harness(true,'first'),second=harness(true,'second');
  const tick=()=>new Promise(done=>setImmediate(done));
  await first.controller.navigate('https://first.test');await tick();
  let release!:()=>void;first.respondView(()=>new Promise(done=>{release=()=>done({ok:true});}));
  first.controller.viewport({x:800,y:100,width:400,height:500});await tick();
  await second.controller.navigate('https://second.test');second.controller.viewport({x:800,y:100,width:400,height:500});await tick();
  assert.equal(second.calls.some(c=>c.path==='/api/web-preview/view'),false);
  first.active=false;first.controller.sync();first.respondView(()=>Promise.resolve({ok:true}));release();await tick();await tick();
  assert.deepEqual(first.calls.filter(c=>c.path==='/api/web-preview/view').at(-1).input.bounds,null);
  assert.equal(second.calls.filter(c=>c.path==='/api/web-preview/view').at(-1).input.bounds.width,400);
  first.controller.destroy();second.controller.destroy();
});
