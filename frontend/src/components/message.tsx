import {useEffect, useMemo, useRef, useState} from 'react';
import {
  Check, ChevronRight, Copy, CornerUpLeft, FilePen, FolderOpen, GitBranch, LoaderCircle,
  Pencil, Search, TerminalSquare, Wrench, X,
} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import type {Message as WireMessage} from '@/contract.generated.ts';
import {Markdown} from '@/lib/markdown';
import {useStickToBottom} from '@/hooks/use-stick';
import {copyText, request} from '@/actions/core';
import {messageAction, openConversationFile, openWorkspace} from '@/actions/conversations.ts';
import {localFilePath} from '@/local-file-links';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';
import {relativeDay} from '@/lib/format';

export function Conversation() {
  const state = useDesk(store => store.state);
  const scroller = useStickToBottom(JSON.stringify([state.messages.length, state.messages.at(-1)?.text?.length, state.running]), state.activeId);
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

  useEffect(() => {
    const registry = (CSS as unknown as {highlights?: {set(name: string, value: unknown): void; delete(name: string): void}}).highlights;
    if (!findOpen || !findQuery) {
      registry?.delete('pith-find');
      setMatches(0);
      return;
    }
    const root = document.querySelector('[data-conversation-scroll]');
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
    if (registry && 'Highlight' in window) {
      registry.set('pith-find', new Highlight(...ranges));
    }
    return () => {registry?.delete('pith-find');};
  }, [findOpen, findQuery, state.messages]);

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
                setFindOpen(false);
                setFindQuery('');
              }
            }}
          />
          <span className="text-[11px] text-muted-foreground" aria-live="polite">{findQuery ? `${matches} ${matches === 1 ? 'match' : 'matches'}` : ''}</span>
          <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={() => {setFindOpen(false); setFindQuery('');}}><X className="size-3" /></Button>
        </div>
      ) : null}
      <div ref={scroller.ref} data-conversation-scroll="" onScroll={scroller.onScroll} className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[54rem] px-6 pt-8 pb-6">
          {state.messages.length ? <MessageList messages={state.messages} working={state.running} /> : <Welcome />}
          {state.running ? <Working /> : null}
        </div>
      </div>
      <Button
        size="sm" variant="secondary"
        data-jump-latest=""
        hidden={!scroller.showJump}
        className="absolute right-6 bottom-3 gap-1.5 rounded-full shadow-md"
        onClick={() => scroller.jump('auto')}
      >
        <CornerUpLeft className="size-3.5 rotate-90" />Jump to latest
      </Button>
    </div>
  );
}

function MessageList({messages, working}: {messages: WireMessage[]; working: boolean}) {
  let index = 0;
  const groups: ({kind: 'message'; message: WireMessage} | {kind: 'tools'; messages: WireMessage[]})[] = [];
  while (index < messages.length) {
    const message = messages[index];
    if (message.role === 'tool') {
      const tools: WireMessage[] = [];
      while (index < messages.length && messages[index].role === 'tool') tools.push(messages[index++]);
      groups.push({kind: 'tools', messages: tools});
      continue;
    }
    groups.push({kind: 'message', message});
    index++;
  }
  return (
    <div className="flex flex-col gap-7">
      {groups.map((group, groupIndex) => group.kind === 'tools'
        ? <ToolGroup key={`tools-${group.messages[0].id}`} messages={group.messages} />
        : <MessageItem key={group.message.id} message={group.message} streaming={working && groupIndex === groups.length - 1 && group.message.role === 'assistant'} />)}
    </div>
  );
}

function MessageItem({message, streaming}: {message: WireMessage; streaming: boolean}) {
  const state = useDesk(store => store.state);
  const busy = useDesk(store => store.activity.busy);
  const user = message.role === 'user';
  const system = message.role === 'system';
  const [copied, setCopied] = useState(false);
  const canCopy = !!message.text && message.status !== 'streaming';
  const canEdit = user && !busy && !state.running;
  const canBranch = !user && !!message.branchNodeId && !busy && !state.running;

  if (system) {
    return <div className="border-l-2 pl-3 text-[12px] leading-relaxed text-muted-foreground" data-reading-id={message.id}>{message.text}</div>;
  }

  return (
    <article
      data-reading-id={message.id}
      data-message-role={message.role}
      className={cn('group/message flex flex-col', user ? 'items-end' : 'items-stretch')}
    >
      {user ? (
        <div data-user-text="" className="max-w-[82%] rounded-xl border border-border/70 bg-muted/60 px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words">
          {message.images?.length ? <MessageImages images={message.images} messageId={message.id} conversationId={state.activeId} align="end" /> : null}
          {message.text}
        </div>
      ) : (
        <div className="min-w-0 max-w-full">
          {message.images?.length ? <MessageImages images={message.images} messageId={message.id} conversationId={state.activeId} /> : null}
          {message.text ? (
            <Markdown
              text={message.text}
              onCopyCode={text => {void copyText(text);}}
              resolveLocalFile={href => localFilePath(href)}
              onLocalFile={path => {void openConversationFile(state.activeId, path);}}
            />
          ) : streaming ? null : <p className="text-[13px] text-muted-foreground">No text output.</p>}
          {message.status === 'error' ? <span className="mt-2 block text-[12px] text-destructive">The model response ended with an error.</span> : null}
        </div>
      )}
      <div className={cn('mt-1 flex items-center gap-1', user ? 'flex-row-reverse' : '')}>
        {message.timestamp ? (
          <time
            className="px-1 text-[11px] text-muted-foreground/80"
            dateTime={new Date(message.timestamp).toISOString()}
            title={new Date(message.timestamp).toISOString()}
          >
            {new Date(message.timestamp).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}
          </time>
        ) : null}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100">
          {canCopy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon-xs" aria-label={user ? 'Copy message' : 'Copy response'}
                  onClick={async () => {await copyText(message.text); setCopied(true); window.setTimeout(() => setCopied(false), 1400);}}
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
          ) : null}
          {user ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Edit message" disabled={!canEdit} onClick={() => {void messageAction('edit', message.id);}}>
                  <Pencil className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit message</TooltipContent>
            </Tooltip>
          ) : null}
          {!user && message.branchNodeId ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Branch from this message" disabled={!canBranch} onClick={() => {void messageAction('branch', message.id, message.branchNodeId);}}>
                  <GitBranch className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Restore this branch</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function MessageImages({images, messageId, conversationId, align}: {images: NonNullable<WireMessage['images']>; messageId: string; conversationId: string; align?: 'end'}) {
  return (
    <div className={cn('mb-2 flex flex-wrap gap-2', align === 'end' && 'justify-end')}>
      {images.map(image => <MessageImage key={image.index} index={image.index} messageId={messageId} conversationId={conversationId} mimeType={image.mimeType} />)}
    </div>
  );
}

function MessageImage({index, messageId, conversationId, mimeType}: {index: number; messageId: string; conversationId: string; mimeType: string}) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void import('@/lib/runtime.ts')
      .then(({app}) => app().download('/api/image', {id: conversationId, message: messageId, index}))
      .then(blob => {
        if (!active) return;
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(blob.type)) throw new Error('Invalid image attachment.');
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {if (active) setFailed(true);});
    return () => {active = false; if (objectUrl) URL.revokeObjectURL(objectUrl);};
  }, [conversationId, messageId, index]);
  if (failed) return <div className="grid h-16 w-28 place-items-center rounded-lg border text-[11px] text-muted-foreground">Image unavailable</div>;
  if (!url) return <div className="h-20 w-28 animate-pulse rounded-lg bg-muted" />;
  return (
    <button
      type="button" className="block overflow-hidden rounded-lg border bg-muted"
      aria-label={`Open image ${index + 1}`}
      onClick={() => desk().openModal({kind: 'image', id: `image-${messageId}-${index}`, src: url, alt: `${mimeType} attachment`})}
    >
      <img src={url} alt={`Attachment ${index + 1}`} data-message-image="" className="max-h-56 max-w-72 object-contain" />
    </button>
  );
}

const toolLabels: Record<string, {label: string; icon: typeof Wrench}> = {
  write_file: {label: 'Wrote a file', icon: FilePen},
  edit_file: {label: 'Edited a file', icon: FilePen},
  read_file: {label: 'Read a file', icon: FolderOpen},
  list_directory: {label: 'Listed files', icon: FolderOpen},
  search_files: {label: 'Searched files', icon: Search},
  run_command: {label: 'Ran a command', icon: TerminalSquare},
};

function toolLabel(message: WireMessage): {label: string; icon: typeof Wrench} {
  return toolLabels[message.toolName || ''] || {label: message.toolName || 'Used a tool', icon: Wrench};
}

function ToolGroup({messages}: {messages: WireMessage[]}) {
  const [open, setOpen] = useState(false);
  const first = toolLabel(messages[0]);
  const running = messages.some(message => message.status === 'running');
  const failed = messages.some(message => message.status === 'error');
  const label = messages.length === 1 ? first.label : first.label.replace(/^(\w+ed|\w+)/, match => match.replace(/^(\w+?)e?d$/, '$1')) ;
  return (
    <div data-tool-group="" className="-mt-2 text-muted-foreground">
      <button
        type="button"
        data-tool-group-summary=""
        className="flex min-h-8 w-full items-center gap-2 py-1 text-left text-[13px] hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <first.icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{messages.length === 1 ? label : `${messages.length} tool calls`}</span>
        <span data-tool-group-status="" className={cn('shrink-0 text-[11px]', failed ? 'text-destructive' : running ? 'text-foreground' : '')}>
          {running ? 'Running…' : failed ? 'Failed' : 'Done'}
        </span>
        <ChevronRight className={cn('ml-0.5 size-3 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      <div hidden={!open} className="mt-1 flex flex-col gap-1.5">{messages.map(message => <ToolCard key={message.id} message={message} />)}</div>
    </div>
  );
}

function ToolCard({message}: {message: WireMessage}) {
  const [open, setOpen] = useState(false);
  const {label, icon: Icon} = toolLabel(message);
  const failed = message.status === 'error';
  return (
    <div data-reading-id={message.id} className="overflow-hidden rounded-lg border bg-card/50">
      <button
        type="button"
        data-tool-card-summary=""
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-accent/50"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span data-tool-status="" className={cn('shrink-0 text-[11px]', failed ? 'text-destructive' : 'text-muted-foreground')}>{failed ? 'Failed' : message.status === 'running' ? 'Running' : 'Completed'}</span>
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      <div hidden={!open} className="border-t">
        <>
          {message.command ? (
            <div className="border-b px-3 py-2">
              <span className="mb-1 block text-[11px] text-muted-foreground">Command</span>
              <pre className="max-h-40 overflow-auto font-mono text-[12px] whitespace-pre-wrap break-words">{message.command.text}</pre>
              <span className="mt-2 block text-[11px] text-muted-foreground">Working directory</span>
              <code className="text-[11px] break-all">{message.command.cwd}</code>
            </div>
          ) : null}
          {message.text ? <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{message.text}</pre> : <p className="px-3 py-2 text-[12px] text-muted-foreground">No output.</p>}
        </>
      </div>
    </div>
  );
}

function Welcome() {
  const state = useDesk(store => store.state);
  const selectedId = useDesk(store => store.selectedWorkspaceId);
  const workspace = useDesk(store => {
    const conversation = store.state.conversations.find(entry => entry.id === store.state.activeId);
    return store.state.workspaces.find(entry => entry.id === (conversation?.workspaceId || store.selectedWorkspaceId)) ?? store.state.workspaces[0];
  });
  const ready = state.settings.hasApiKey;
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-10 text-center">
      <div className="mb-5 grid size-14 place-items-center rounded-2xl border bg-card shadow-sm">
        <BrandGlyph />
      </div>
      <h1 className="mb-1.5 text-[17px] font-semibold tracking-tight">How can Pith help today?</h1>
      <p className="text-[13px] text-muted-foreground">
        {workspace ? (
          <>
            Working in <strong className="font-medium text-foreground">{workspace.name}</strong>{' '}
            <Button type="button" variant="link" size="xs" className="h-auto p-0 text-[13px] font-normal" onClick={openWorkspace}>Change</Button>
          </>
        ) : 'Choose a workspace to start a conversation.'}
      </p>
      {!ready ? (
        <div className="mt-6 w-full rounded-xl border bg-card p-4 text-left">
          <p className="text-[13px] font-medium">Connect a model to get started</p>
          <p className="mt-1 text-[12px] text-muted-foreground">Add a provider key or sign in with your provider account in Settings. Credentials stay in Pith Desk’s private local data.</p>
          <Button size="sm" className="mt-3" onClick={() => desk().openModal({kind: 'settings', id: 'settings'})}>Open settings</Button>
        </div>
      ) : null}
      <div className="mt-6 grid w-full gap-1.5">
        {['Summarize the files in this workspace', 'Draft a plan and save it as a Markdown file', 'Review recent changes and suggest next steps'].map(suggestion => (
          <button
            key={suggestion}
            type="button"
            className="w-full rounded-lg border bg-card px-3 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => {
              desk().setComposer({text: suggestion});
              window.dispatchEvent(new CustomEvent('pith:focus-composer'));
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function BrandGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="size-6 text-foreground" fill="currentColor">
      <g transform="rotate(-8 16 16)">
        <rect x="4" y="4" width="9" height="9" rx="2.4" />
        <path d="M19 4h1.2A7.8 7.8 0 0 1 28 11.8V13a2.4 2.4 0 0 1-2.4 2.4H19a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" opacity=".55" />
        <path d="M5.4 19H7a2.4 2.4 0 0 1 2.4 2.4V28H7.8A3.8 3.8 0 0 1 4 24.2V20.6a1.6 1.6 0 0 1 1.4-1.6Z" opacity=".55" />
        <rect x="19" y="19" width="9" height="9" rx="2.4" />
      </g>
    </svg>
  );
}

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

export {relativeDay};
