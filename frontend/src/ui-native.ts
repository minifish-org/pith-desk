import {readNativeDrop,type NativeDrop} from './native-protocol.ts';

export function isForeground(): boolean {return document.visibilityState === 'visible' && document.hasFocus();}

// Native coordinates are data; only the library tests interface bounds.
export function installNativeDrop(enabled: boolean, receive: (drop: NativeDrop) => void): () => void {
  const onDrop = (event: Event) => {
    if (!enabled) return;
    const drop = readNativeDrop((event as CustomEvent<unknown>).detail);
    if (drop) receive(drop);
  };
  if (enabled) window.addEventListener('pith:file-drop', onDrop);
  return () => window.removeEventListener('pith:file-drop', onDrop);
}

export function reservePreviewTab() {
  // Reserve during the user gesture; authorization finishes asynchronously.
  const tab=window.open('about:blank','_blank');
  if(!tab)throw new Error('Allow new tabs for Pith Desk, then try again.');
  tab.opener=null;
  return {navigate(url:string){tab.location.replace(url);},close(){tab.close();}};
}
