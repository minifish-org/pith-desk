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
