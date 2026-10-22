import type {ApiRequest} from './api.ts';
import type {Application} from './ui-contract.ts';

/** User-operated content only. No Agent tools or Desk messages enter the frame. */
export function createWebPreview(api: {
  view: ReturnType<Application['tools']['createPreview']>;request:ApiRequest;
  workspaceId:string;active():boolean;disabled():boolean;
}) {
  let alive=true,epoch=0,address='',url='',externalUrl='',grant='',pending=false,error='',revision=0,wasActive=false;
  const valid=()=>alive && api.active() && !api.disabled();
  function paint() {if(alive)api.view.update({url,externalUrl,revision,pending,error,disabled:!valid()});}
  async function release(id:string) {if(id)try {await api.request('/api/web-preview/close',{id});}catch {}}
  function retire() {epoch++;pending=false;url='';const previous=grant;grant='';void release(previous);}
  async function navigate(value:string) {
    if(!valid() || pending)return;
    const generation=++epoch;pending=true;error='';paint();
    const next=value.trim();
    try {
      const result=await api.request('/api/web-preview',{workspaceId:api.workspaceId,address:next});
      if(!valid() || generation!==epoch) {void release(result.id??'');return;}
      address=next;url=result.url;externalUrl=result.externalUrl;grant=result.id??'';revision++;api.view.resetAddress(address);
    } catch(failure) {if(valid() && generation===epoch)error=String(failure instanceof Error?failure.message:failure);}
    finally {if(alive && generation===epoch) {pending=false;paint();}}
  }
  function sync() {
    const active=valid();if(!active && wasActive)retire();wasActive=active;
    // Reopening a view never replays a form action. Refresh/Enter explicitly admits
    // a new target grant; only its URL is loaded by the iframe.
    paint();
  }
  return {navigate,refresh:()=>navigate(address),sync,
    destroy() {if(!alive)return;retire();alive=false;}};
}
