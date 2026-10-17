import test from 'node:test';
import assert from 'node:assert/strict';
import type {Application, LoadingSession} from '../src/ui-types.ts';
import type {ApiRequest} from '../src/api.ts';
import type {Confirmation} from '../src/confirmation.ts';
import type {SDKFeatureAPI} from '../src/sdk-feature-api.ts';
import {initialState} from '../src/app-state.ts';
import {createSDKUI} from '../src/sdk-features.ts';

function harness(ui:Application={} as Application) {
  const state=initialState('light'),events:unknown[]=[],confirmations:Confirmation[]=[];
  let busy=false,saved=true,refreshFails=false;
  const api:SDKFeatureAPI={ui,state:()=>state,busy:()=>busy,error:()=> 'Fixture write rejected',workspaceBusy:()=>false,draft:()=>{},
    request:async()=>{throw new Error('Unexpected read');},
    mutate:async(path,payload)=>{events.push({path,payload});return saved;},
    confirm:options=>{confirmations.push(options);},settings:()=>{events.push('settings');},
    refreshResources:async()=>{},refreshProviderAuth:id=>{events.push({providerRefresh:id});},
    refreshMCP:async()=>{events.push('mcp-refresh');if(refreshFails)throw new Error('Read failed after committed write');},
  };
  return {api,state,events,confirmations,setBusy(value:boolean){busy=value;},setSaved(value:boolean){saved=value;},setRefreshFailure(value:boolean){refreshFails=value;}};
}

test('SDK dispatch initializes without a DOM and exposes finite provider presentation data',()=>{
  const h=harness(),sdk=createSDKUI(h.api);
  const provider={id:'provider',name:'Provider',baseUrl:'https://example.test',oauth:true,apiKeySupported:true,signedIn:false,custom:true,hasApiKey:true,hasSavedKey:true};
  assert.deepEqual(sdk.providerActions(provider),{id:'provider',oauth:true,signedIn:false,custom:true,disabled:false});
  h.setBusy(true);assert.equal(sdk.providerActions(provider).disabled,true);
  h.setBusy(false);h.state.runs=[{conversationId:'other',workspaceId:'w',phase:'working',needsApproval:false}];assert.equal(sdk.providerActions(provider).disabled,true);
  sdk.destroy();sdk.destroy();
});

test('provider auth dispatch preserves targets, mutation failure and successful refresh behavior',async()=>{
  const h=harness(),sdk=createSDKUI(h.api);
  assert.deepEqual(await sdk.providerAction('login',{id:'first'}),{ok:true});
  assert.deepEqual(await sdk.providerAction('logout',{id:'second'}),{ok:true});
  h.setSaved(false);assert.deepEqual(await sdk.providerAction('logout',{id:'failed'}),{ok:false,error:'Fixture write rejected'});
  assert.deepEqual(h.events,[{path:'/api/oauth/start',payload:{provider:'first'}},{path:'/api/oauth/logout',payload:{provider:'second'}},{providerRefresh:'second'},{path:'/api/oauth/logout',payload:{provider:'failed'}}]);
  sdk.destroy();
});

test('a committed MCP logout remains successful when its following list read fails',async()=>{
  const h=harness(),sdk=createSDKUI(h.api);h.setRefreshFailure(true);
  assert.deepEqual(await sdk.mcpAuth('mcp-logout','tools'),{ok:true});
  h.setSaved(false);assert.deepEqual(await sdk.mcpAuth('mcp-login','other'),{ok:false,error:'Fixture write rejected'});
  assert.deepEqual(h.events,[{path:'/api/mcp/oauth/logout',payload:{name:'tools'}},'mcp-refresh',{path:'/api/mcp/oauth/start',payload:{name:'other'}}]);
  sdk.destroy();
});

test('a committed provider logout remains successful when its following credential read fails',async()=>{
  const h=harness();h.api.refreshProviderAuth=id=>{h.events.push({providerRefresh:id});throw new Error('Read failed after committed write');};
  const sdk=createSDKUI(h.api);
  assert.deepEqual(await sdk.providerAction('logout',{id:'provider'}),{ok:true});
  assert.deepEqual(h.events,[{path:'/api/oauth/logout',payload:{provider:'provider'}},{providerRefresh:'provider'}]);sdk.destroy();
});

test('global availability and destruction block auth writes without starting transactions',async()=>{
  const h=harness(),sdk=createSDKUI(h.api);h.setBusy(true);
  assert.equal((await sdk.providerAction('login',{id:'provider'})).ok,false);assert.equal((await sdk.mcpAuth('mcp-login','tools')).ok,false);
  h.setBusy(false);h.state.runs=[{conversationId:'other',workspaceId:'w',phase:'working',needsApproval:false}];
  assert.equal((await sdk.providerAction('remove-connection',{id:'provider'})).ok,false);
  h.state.runs=[];sdk.destroy();
  assert.equal((await sdk.providerAction('logout',{id:'provider'})).ok,false);assert.equal((await sdk.mcpAuth('mcp-logout','tools')).ok,false);
  assert.deepEqual(h.events,[]);assert.deepEqual(h.confirmations,[]);
});

test('destroyed SDK entry points do not reopen resource or history windows',async()=>{
  const h=harness(),sdk=createSDKUI(h.api);h.state.activeId='active';h.state.workspaces=[{id:'w',name:'Project',path:'/demo/project'}];
  sdk.destroy();
  const results=await Promise.allSettled([sdk.resource('w','skill'),sdk.history()]);
  assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled']);assert.deepEqual(h.events,[]);
});

test('connection removal uses a structured confirmation and captures its original target',async()=>{
  const h=harness(),sdk=createSDKUI(h.api),target={id:'<old provider>'};
  assert.deepEqual(await sdk.providerAction('remove-connection',target),{ok:true});target.id='changed target';
  assert.equal(h.events.length,0);assert.equal(h.confirmations.length,1);
  const confirmation=h.confirmations[0];
  assert.deepEqual(confirmation.description,{before:'Remove ',subject:'<old provider>',after:' and its saved credentials?'});
  assert.deepEqual(confirmation.scope,{global:true});assert.equal(confirmation.unavailable(),false);
  assert.equal(await confirmation.run(),true);
  assert.deepEqual(h.events,[{path:'/api/remove-model-connection',payload:{id:'<old provider>'}},'settings']);
  sdk.destroy();
});

test('compact follows active-conversation availability and preserves successful write results',async()=>{
  const h=harness(),sdk=createSDKUI(h.api);h.state.activeId='active';
  assert.equal((await sdk.compact()).ok,false);
  h.state.messages=[{id:'m',role:'user',text:'Existing conversation'}];
  assert.deepEqual(await sdk.compact(),{ok:true});
  h.state.running=true;assert.equal((await sdk.compact()).ok,false);
  assert.deepEqual(h.events,[{path:'/api/compact',payload:{id:'active'}}]);sdk.destroy();
});

test('destroy releases custom loading and prevents a delayed read from opening its editor',async()=>{
  let open=true,editors=0,release!:(connection:{name:string;baseUrl:string;api:string;models:[]})=>void;
  const loading:LoadingSession={update(){},fail(){},isOpen:()=>open,close(){open=false;},destroy(){open=false;}};
  const h=harness({settings:{openConnectionLoading(){return loading;},openCustomConnection(){editors++;throw new Error('Old read opened an editor');}}} as unknown as Application);
  h.api.request=(()=>new Promise(resolve=>{release=resolve;})) as ApiRequest;
  const sdk=createSDKUI(h.api),pending=sdk.custom('old');
  sdk.destroy();assert.equal(open,false);
  release({name:'Old',baseUrl:'https://old.test',api:'openai-completions',models:[]});await pending;
  assert.equal(editors,0);assert.deepEqual(h.events,[]);
});
