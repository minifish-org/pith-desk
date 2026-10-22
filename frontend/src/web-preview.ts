import {reservePreviewTab} from './ui-native.ts';
import type {ApiRequest} from './api.ts';
import type {BrowserBounds} from './contract.generated.ts';
import type {Application} from './ui-contract.ts';

// One native window presents one preview at a time. Serialize placement across
// controllers so a late resize from a hidden tab cannot cover its successor.
let placements:Promise<unknown>=Promise.resolve();

export interface PreviewTab {navigate(url:string):void;close():void}

/** Shared admission and intents; native Desktop pages or independent Server tabs. */
export function createWebPreview(api:{
  view:ReturnType<Application['tools']['createPreview']>;request:ApiRequest;
  id:string;workspaceId:string;native:boolean;active():boolean;disabled():boolean;
  openTab?():PreviewTab;
}) {
  let alive=true,epoch=0,address='',url='',externalUrl='',grant='',pending=false,error='';
  let bounds:BrowserBounds|null=null,desired:BrowserBounds|null=null,sending=false,last='';
  const valid=()=>alive && api.active() && !api.disabled();
  function paint(){if(alive)api.view.update({url,externalUrl,pending,error,disabled:!valid(),presentation:api.native?'native':'external'});}
  async function release(id:string){if(id)try{await api.request('/api/web-preview/close',{id});}catch{}}
  async function present(){
    desired=valid() && url ? bounds:null;
    if(!api.native || !grant || sending)return;
    sending=true;
    try {
      while(alive && grant && JSON.stringify(desired)!==last){
        const next=desired;last=JSON.stringify(next);
        const position=placements.catch(()=>{}).then(()=>alive ? api.request('/api/web-preview/view',{id:api.id,bounds:valid()?next:null}):undefined);
        placements=position;await position;
      }
    }catch(failure){last='';if(valid()){error=String(failure instanceof Error?failure.message:failure);paint();}}
    finally{sending=false;}
  }
  async function navigate(value:string){
    if(!valid() || pending)return;
    let tab:PreviewTab|undefined;
    try{if(!api.native)tab=(api.openTab??reservePreviewTab)();}catch(failure){error=String(failure instanceof Error?failure.message:failure);paint();return;}
    const generation=++epoch,next=value.trim();pending=true;error='';paint();
    try{
      const result=await api.request('/api/web-preview',{id:api.id,workspaceId:api.workspaceId,address:next});
      // User-opened Server previews outlive this view; Go owns lease revocation.
      if(tab)tab.navigate(result.url);
      if(!alive || generation!==epoch || api.disabled()){
        if(api.native)void release(result.id??'');
        return;
      }
      address=next;url=result.url;externalUrl=result.externalUrl;grant=result.id??'';last='';
      api.view.resetAddress(address);void present();
    }catch(failure){tab?.close();if(alive && generation===epoch)error=String(failure instanceof Error?failure.message:failure);}
    finally{if(alive && generation===epoch){pending=false;paint();}}
  }
  return {navigate,refresh:()=>navigate(address),viewport(next:BrowserBounds|null){bounds=next;void present();},
    sync(){paint();void present();},
    destroy(){if(!alive)return;alive=false;epoch++;if(api.native)void release(grant);grant='';},
  };
}
