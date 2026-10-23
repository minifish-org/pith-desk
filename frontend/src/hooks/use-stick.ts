import {useCallback, useEffect, useRef, useState} from 'react';

interface ReadingPosition {
  top: number;
  pinned: boolean;
}

/** Keep a transcript pinned to the latest message unless the reader scrolled up.
 * Each conversation remembers its own reading position for the page lifetime. */
export function useStickToBottom(dependency: unknown, conversationKey?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const positions = useRef(new Map<string, ReadingPosition>());
  const currentKey = useRef(conversationKey || '');
  const lastTop = useRef(0);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    pinned.current = distance < 64;
    lastTop.current = element.scrollTop;
    positions.current.set(currentKey.current, {top: element.scrollTop, pinned: pinned.current});
    setShowJump(distance > 240);
  }, []);

  const jump = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = ref.current;
    if (!element) return;
    pinned.current = true;
    setShowJump(false);
    element.scrollTo({top: element.scrollHeight, behavior});
    lastTop.current = element.scrollTop;
    positions.current.set(currentKey.current, {top: element.scrollTop, pinned: true});
  }, []);

  useEffect(() => {
    if (pinned.current) jump('auto');
  }, [dependency, jump]);

  // Switching conversations restores that conversation's reading position; an
  // unvisited conversation starts at its latest message.
  useEffect(() => {
    const key = conversationKey || '';
    if (currentKey.current === key) return;
    positions.current.set(currentKey.current, {top: lastTop.current, pinned: pinned.current});
    currentKey.current = key;
    const saved = positions.current.get(key);
    const restorePinned = saved ? saved.pinned : true;
    pinned.current = restorePinned;
    setShowJump(!restorePinned);
    // Restore after the new transcript has laid out. A layout-induced scroll
    // event on the previous content must not override this decision.
    const frame = requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      if (restorePinned) {
        element.scrollTo({top: element.scrollHeight, behavior: 'auto'});
      } else if (saved) {
        element.scrollTop = saved.top;
        pinned.current = false;
        lastTop.current = element.scrollTop;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationKey]);

  useEffect(() => {
    const onFollow = () => jump('smooth');
    window.addEventListener('pith:follow-latest', onFollow);
    return () => window.removeEventListener('pith:follow-latest', onFollow);
  }, [jump]);

  return {ref, onScroll, showJump, jump};
}
