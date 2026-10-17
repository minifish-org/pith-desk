/** Test-only platform scheduling. Production assemblies never receive nodes or
 * geometry inputs; every tested reader/diff controller is a formal public part. */
import {
  createButtonPart, createPreformattedPart, createReadingColumnPart,
  createReadingNotePart, createReadingViewportPart, createStackPart, mountParts,
} from 'pith-ui';

export function readerFixture() {
  const original = {requestAnimationFrame: window.requestAnimationFrame,cancelAnimationFrame: window.cancelAnimationFrame,ResizeObserver: window.ResizeObserver};
  const frames = new Map<number,FrameRequestCallback>();let sequence = 0,resized = () => {};
  window.requestAnimationFrame = callback => {frames.set(++sequence,callback);return sequence;};
  window.cancelAnimationFrame = id => {frames.delete(id);};
  window.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {resized = () => callback([],this);}
    observe() {} unobserve() {} disconnect() {}
  };
  let height = 1200,top = 0,anchorTop = 500;
  const note = createReadingNotePart({key:'message',text:'Reading anchor'});
  const reading = createReadingColumnPart({children:[note]});
  const latest = createButtonPart({variant:'latest',icon:'down',label:'Back to latest',hidden:true});
  const viewport = createReadingViewportPart({reading,children:[reading],onLatestChange(visible) {latest.update({variant:'latest',icon:'down',label:'Back to latest',hidden:!visible});}});
  const mount = document.body.appendChild(document.createElement('div'));
  const tree = mountParts(mount,createStackPart({children:[viewport,latest]}));
  const scroll = mount.querySelector<HTMLElement>('.pui-chat-scroll')!;
  const anchor = mount.querySelector<HTMLElement>('[data-reading-id="message"]')!;
  const latestNode = mount.querySelector<HTMLButtonElement>('button')!;
  // The original seven Node regressions intentionally control layout and event
  // order. Retain their exact 1200/400/600/500 model on real library-created DOM.
  Object.defineProperties(scroll,{
    clientHeight:{configurable:true,get:()=>400},clientWidth:{configurable:true,get:()=>600},
    scrollHeight:{configurable:true,get:()=>height},
    scrollTop:{configurable:true,get:()=>top,set:(value:number)=>{top=Math.max(0,Math.min(value,height-scroll.clientHeight));}},
  });
  scroll.getBoundingClientRect = () => ({top:0}) as DOMRect;
  anchor.getBoundingClientRect = () => ({top:anchorTop-top,bottom:anchorTop+1000-top}) as DOMRect;
  const flush = () => {const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback(0));};
  const render = (id='a') => {viewport.beforeUpdate(id);viewport.afterUpdate();flush();};
  const reader = {beforeRender:viewport.beforeUpdate,afterRender:viewport.afterUpdate,followLatest:viewport.followLatest};
  render();
  let alive=true;
  return {
    reader,scroll,latest:latestNode,flush,render,
    emitScroll() {scroll.dispatchEvent(new Event('scroll'));},
    resize() {resized();},grow(amount:number) {height+=amount;},moveAnchor(amount:number) {anchorTop+=amount;},
    gap() {return height-scroll.clientHeight-top;},
    findRanges(text:string,query:string) {
      note.update({text});viewport.openSearch(query);
      return [...anchor.querySelectorAll<HTMLElement>('mark[data-find-match]')].map(mark=>{
        const range=document.createRange();range.selectNodeContents(anchor);range.setEndBefore(mark);
        const start=range.toString().length;return {start,end:start+(mark.textContent?.length??0)};
      });
    },
    destroy() {if(!alive)return;alive=false;tree.destroy();mount.remove();Object.assign(window,original);},
  };
}
export type ReaderFixture = ReturnType<typeof readerFixture>;

export function diffFixture(text:string) {
  const part=createPreformattedPart({kind:'diff',text,label:'Proposed file changes'});
  const mount=document.body.appendChild(document.createElement('div')),tree=mountParts(mount,part);
  const pre=mount.querySelector('pre')!;
  const result={html:pre.innerHTML,text:pre.textContent,scripts:pre.querySelectorAll('script').length,images:pre.querySelectorAll('img').length};
  tree.destroy();mount.remove();return result;
}
