import {readDraftFlushCallback} from './native-protocol.ts';

// Centralize browser/native lifecycle ingress. The composer supplies the save
// operation, including its readonly/failed-save UI; lifecycle never owns drafts.
export function installAppLifecycle(options: {
  acknowledge: () => void;
  saveOnLeave: () => void;
  flushDrafts: () => Promise<boolean>;
  dispose: () => void;
}): () => void {
  const onVisibility = () => {
    options.acknowledge();
    if (document.visibilityState === 'hidden') options.saveOnLeave();
  };
  const onFlush = (event: Event) => {
    const callback = readDraftFlushCallback((event as CustomEvent<unknown>).detail);
    if (!callback) return;
    event.preventDefault();
    void options.flushDrafts().then(callback, () => callback(false));
  };
  const onUnload = () => { options.saveOnLeave(); options.dispose(); };
  window.addEventListener('focus', options.acknowledge);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', options.saveOnLeave);
  window.addEventListener('pith:flush-drafts', onFlush);
  window.addEventListener('beforeunload', onUnload);
  return () => {
    window.removeEventListener('focus', options.acknowledge);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', options.saveOnLeave);
    window.removeEventListener('pith:flush-drafts', onFlush);
    window.removeEventListener('beforeunload', onUnload);
  };
}
