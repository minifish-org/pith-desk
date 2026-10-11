export interface TextRange { start: number; end: number }

// Literal, case-insensitive matches, with offsets into the original text.
export function findRanges(text: string, query: string): TextRange[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
}

interface ReadingPosition { top: number; follow: boolean; anchor?: string; offset?: number }
interface Match { key: string; parts: HTMLElement[] }

export function installConversationReader(scroll: HTMLElement, messages: HTMLElement, bar: HTMLElement, latest: HTMLButtonElement) {
  const field = bar.querySelector<HTMLInputElement>('input')!;
  const count = bar.querySelector<HTMLElement>('[data-find-count]')!;
  const previous = bar.querySelector<HTMLButtonElement>('[data-find-previous]')!;
  const next = bar.querySelector<HTMLButtonElement>('[data-find-next]')!;
  const close = bar.querySelector<HTMLButtonElement>('[data-find-close]')!;
  const positions = new Map<string, ReadingPosition>();
  let activeID = '';
  let matches: Match[] = [];
  let selected = -1;
  let frame = 0;
  let pendingPosition: ReadingPosition | undefined;
  let restoring = false;
  let searchSignature = '';
  let contentHeight = scroll.scrollHeight;
  let viewportHeight = scroll.clientHeight;
  let viewportWidth = scroll.clientWidth;

  const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const layoutChanged = () => contentHeight !== scroll.scrollHeight || viewportHeight !== scroll.clientHeight || viewportWidth !== scroll.clientWidth;
  function recordLayout(): void {
    contentHeight = scroll.scrollHeight;
    viewportHeight = scroll.clientHeight;
    viewportWidth = scroll.clientWidth;
  }
  function capture(follow = nearBottom()): ReadingPosition {
    const top = scroll.getBoundingClientRect().top;
    const anchor = [...messages.querySelectorAll<HTMLElement>('[data-reading-id]')].find((element) => element.getBoundingClientRect().bottom > top);
    return { top: scroll.scrollTop, follow, anchor: anchor?.dataset.readingId, offset: anchor ? anchor.getBoundingClientRect().top - top : undefined };
  }
  function updateLatest(): void { latest.hidden = !messages.childElementCount || nearBottom(); }
  function remember(): void {
    if (activeID && !restoring && !pendingPosition) positions.set(activeID, capture());
    recordLayout();
    updateLatest();
  }
  function restore(position: ReadingPosition): void {
    restoring = true;
    if (position.follow) scroll.scrollTop = scroll.scrollHeight;
    else {
      const anchor = [...messages.querySelectorAll<HTMLElement>('[data-reading-id]')].find((element) => element.dataset.readingId === position.anchor);
      scroll.scrollTop = anchor && position.offset !== undefined
        ? scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - position.offset
        : position.top;
    }
    restoring = false;
    // Following is user intent. Layout changes (including image decoding) must
    // not turn it off, or turn a history reader back into a follower.
    if (activeID) positions.set(activeID, capture(position.follow));
    recordLayout();
    updateLatest();
  }
  function followLatest(): void {
    const position = { top: 0, follow: true };
    if (pendingPosition) pendingPosition = position;
    restore(position);
  }

  let cachedMatches = new WeakMap<HTMLElement, { query: string; version?: string; matches: typeof matches }>();
  function clearMarks(root: HTMLElement = messages): void {
    for (const mark of root.querySelectorAll('mark[data-find-match]')) mark.replaceWith(document.createTextNode(mark.textContent || ''));
    root.normalize();
    if (root === messages) cachedMatches = new WeakMap();
    else cachedMatches.delete(root);
  }
  function markMatches(): void {
    const previousKey = matches[selected]?.key;
    matches = [];
    const query = field.value;
    if (!bar.hidden && query) {
      for (const root of messages.querySelectorAll<HTMLElement>('[data-reading-id]')) {
        const cached = cachedMatches.get(root);
        if (cached?.query === query && cached.version === root.dataset.renderVersion) { matches.push(...cached.matches); continue; }
        clearMarks(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => node.parentElement?.closest('button, summary, script, style, [data-find-ignore]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        const nodes: { node: Text; start: number; end: number }[] = [];
        let text = '', block: Element | null = null;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const parent = node.parentElement?.closest('p, pre, li, h1, h2, h3, h4, h5, h6, .user-text, .system-message') || root;
          if (text && parent !== block) text += '\n';
          block = parent;
          const start = text.length;
          text += node.data;
          nodes.push({ node, start, end: text.length });
        }
        const ranges = findRanges(text, query);
        const base = matches.length;
        matches.push(...ranges.map((range) => ({ key: `${root.dataset.readingId}:${range.start}`, parts: [] })));
        for (const { node, start, end } of nodes) {
          const intersections = ranges.map((range, index) => ({ start: Math.max(start, range.start) - start, end: Math.min(end, range.end) - start, index: base + index })).filter((range) => range.end > range.start);
          if (!intersections.length) continue;
          const fragment = document.createDocumentFragment();
          let offset = 0;
          for (const range of intersections) {
            fragment.append(document.createTextNode(node.data.slice(offset, range.start)));
            const mark = document.createElement('mark');
            mark.dataset.findMatch = String(range.index);
            mark.textContent = node.data.slice(range.start, range.end);
            matches[range.index].parts.push(mark);
            fragment.append(mark);
            offset = range.end;
          }
          fragment.append(document.createTextNode(node.data.slice(offset)));
          node.replaceWith(fragment);
        }
        cachedMatches.set(root, { query, version: root.dataset.renderVersion, matches: matches.slice(base) });
      }
    } else clearMarks();
    const kept = matches.findIndex((match) => match.key === previousKey);
    selected = matches.length ? kept >= 0 ? kept : Math.max(0, Math.min(selected, matches.length - 1)) : -1;
    updateSelection();
  }
  function updateSelection(): void {
    matches.forEach((match, index) => match.parts.forEach((part) => part.classList.toggle('find-current', index === selected)));
    count.textContent = field.value ? matches.length ? `${selected + 1} / ${matches.length}` : 'No matches' : '';
    previous.disabled = next.disabled = !matches.length;
  }
  function reveal(): void {
    const target = matches[selected]?.parts[0];
    if (!target) return;
    for (let parent = target.parentElement; parent && parent !== messages; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - scroll.clientHeight / 3;
    remember();
  }
  function move(direction: number): void {
    if (!matches.length) return;
    selected = (selected + direction + matches.length) % matches.length;
    updateSelection();
    reveal();
  }
  function openFind(): void {
    bar.hidden = false;
    markMatches();
    field.focus();
    field.select();
  }
  function closeFind(): void {
    bar.hidden = true;
    clearMarks();
    matches = [];
    selected = -1;
    scroll.focus({ preventScroll: true });
    updateLatest();
  }
  field.addEventListener('input', () => { selected = -1; matches = []; markMatches(); reveal(); });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
  });
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  close.addEventListener('click', closeFind);
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
    else if (event.key === 'Escape' && !bar.hidden) { event.preventDefault(); closeFind(); }
  });
  latest.addEventListener('click', followLatest);
  scroll.addEventListener('scroll', () => {
    if (restoring || pendingPosition) return;
    const saved = positions.get(activeID);
    // A resize can clamp scrollTop and dispatch a scroll before ResizeObserver.
    // Only scrolling within a stable layout changes the following preference.
    if (saved && layoutChanged()) restore(saved);
    else if (!saved || Math.abs(scroll.scrollTop - saved.top) > 1) remember();
    else updateLatest();
  }, { passive: true });
  // Async image decoding and resizing must not displace an existing anchor.
  const observer = new ResizeObserver(() => {
    if (!pendingPosition && activeID) {
      const saved = positions.get(activeID);
      if (saved) restore(saved);
    }
    updateLatest();
  });
  observer.observe(messages);
  observer.observe(scroll);
  return {
    beforeRender(id: string): void {
      if (activeID && !positions.has(activeID)) positions.set(activeID, capture());
      pendingPosition = id === activeID ? pendingPosition || positions.get(activeID) || capture() : positions.get(id) || { top: 0, follow: true };
      if (id !== activeID) { selected = -1; matches = []; searchSignature = ''; }
      activeID = id;
      cancelAnimationFrame(frame);
    },
    afterRender(): void {
      const signature = messages.innerHTML;
      if (!bar.hidden && signature !== searchSignature) { markMatches(); searchSignature = messages.innerHTML; }
      frame = requestAnimationFrame(() => {
        const position = pendingPosition;
        pendingPosition = undefined;
        if (position) restore(position);
        else updateLatest();
      });
    },
    prune(ids: string[]): void { const keep = new Set(ids); for (const id of positions.keys()) if (!keep.has(id)) positions.delete(id); },
    followLatest,
    openFind,
  };
}
