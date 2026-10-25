// The transcript surface: scroll anchoring, jump-to-latest and find-in-
// conversation. Message rendering lives in `message.tsx`.
import {memo, useEffect, useRef, useState} from 'react';
import {ArrowDown, X} from 'lucide-react';
import {useDesk} from '@/stores/desk.ts';
import {activeWorkspace} from '@/lib/derive.ts';
import {useStickToBottom} from '@/hooks/use-stick';
import {MessageList} from '@/components/message';
import {Welcome} from '@/components/welcome';
import {EditedFiles} from '@/components/edited-files';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';

function ConversationView() {
  const messages = useDesk(store => store.state.messages);
  const running = useDesk(store => store.state.running);
  const activeId = useDesk(store => store.state.activeId);
  const artifacts = useDesk(store => store.artifacts.files);
  const artifactsError = useDesk(store => store.artifacts.error);
  const workspacePath = useDesk(store => activeWorkspace(store.state, store.selectedWorkspaceId)?.path || '');
  const scroller = useStickToBottom(JSON.stringify([messages.length, messages.at(-1)?.text?.length, running, artifacts.length]), activeId);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [matches, setMatches] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => {findInput.current?.focus(); findInput.current?.select();});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The CSS Custom Highlight API marks matches without mutating transcript
  // nodes or the user's text selection.
  useEffect(() => {
    const registry = (CSS as unknown as {highlights?: {set(name: string, value: unknown): void; delete(name: string): void}}).highlights;
    if (!findOpen || !findQuery) {
      registry?.delete('pith-find');
      setMatches(0);
      return;
    }
    const root = scroller.ref.current;
    if (!root) return;
    const ranges: Range[] = [];
    const needle = findQuery.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue || '';
      const lower = text.toLowerCase();
      let at = lower.indexOf(needle);
      while (at !== -1) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
        at = lower.indexOf(needle, at + needle.length);
      }
      node = walker.nextNode();
    }
    setMatches(ranges.length);
    if (registry && 'Highlight' in window) registry.set('pith-find', new Highlight(...ranges));
    return () => {registry?.delete('pith-find');};
  }, [findOpen, findQuery, messages]);

  const closeFind = () => {setFindOpen(false); setFindQuery('');};

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {findOpen ? (
        <div data-find-bar="" className="flex shrink-0 items-center gap-1.5 border-b bg-card px-3 py-1.5">
          <Input
            ref={findInput} aria-label="Find in conversation" placeholder="Find in conversation"
            value={findQuery} onChange={event => setFindQuery(event.target.value)}
            className="h-7 max-w-sm text-[12px]"
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="text-[11px] text-muted-foreground" aria-live="polite">{findQuery ? `${matches} ${matches === 1 ? 'match' : 'matches'}` : ''}</span>
          <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={closeFind}><X className="size-3" /></Button>
        </div>
      ) : null}
      <div ref={scroller.ref} data-conversation-scroll="" onScroll={scroller.onScroll} className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="conversation-column pt-6 pb-5">
          {messages.length ? <MessageList messages={messages} working={running} /> : <Welcome />}
          {messages.length && artifacts.length ? (
            <EditedFiles key={activeId} files={artifacts} workspacePath={workspacePath} conversationId={activeId} />
          ) : null}
          {messages.length && !artifacts.length && !running && artifactsError ? (
            <p data-artifacts-error="" className="mt-4 text-[12px] text-destructive">{artifactsError}</p>
          ) : null}
          {running ? <Working /> : null}
        </div>
      </div>
      <Button
        size="sm" variant="secondary"
        data-jump-latest=""
        hidden={!scroller.showJump}
        className="absolute right-6 bottom-3 gap-1.5 rounded-full shadow-md"
        onClick={() => scroller.jump('auto')}
      >
        <ArrowDown className="size-3.5" />Jump to latest
      </Button>
    </div>
  );
}

export const Conversation = memo(ConversationView);

function Working() {
  return (
    <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-foreground">
      <span className="flex gap-1">
        <i className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
        <i className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
        <i className="size-1 animate-bounce rounded-full bg-current" />
      </span>
      Pith is working…
    </div>
  );
}
