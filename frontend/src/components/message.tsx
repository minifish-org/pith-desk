import {memo, useEffect, useState} from 'react';
import {
  Check, ChevronRight, Copy, FilePen, FolderOpen, GitBranch, Pencil, Search, TerminalSquare, Wrench,
} from 'lucide-react';
import {cn} from '@/lib/utils';
import {app} from '@/lib/runtime.ts';
import {desk, useDesk} from '@/stores/desk.ts';
import type {Message as WireMessage} from '@/contract.generated.ts';
import {sameMessage, sameMessages} from '@/lib/messages.ts';
import {Markdown} from '@/lib/markdown';
import {copyText} from '@/actions/core';
import {messageAction, openConversationFile} from '@/actions/conversations.ts';
import {localFilePath} from '@/local-file-links';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';

/** The transcript, grouped so consecutive tool calls read as one activity. */
export function MessageList({messages, working}: {messages: WireMessage[]; working: boolean}) {
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
    <div className="flex flex-col gap-6">
      {groups.map((group, groupIndex) => group.kind === 'tools'
        ? <ToolGroup key={`tools-${group.messages[0].id}`} messages={group.messages} />
        : <MessageItem key={group.message.id} message={group.message} streaming={working && groupIndex === groups.length - 1 && group.message.role === 'assistant'} />)}
    </div>
  );
}

function MessageItemView({message, streaming}: {message: WireMessage; streaming: boolean}) {
  const activeId = useDesk(store => store.state.activeId);
  const running = useDesk(store => store.state.running);
  const busy = useDesk(store => store.activity.busy);
  const user = message.role === 'user';
  const system = message.role === 'system';
  const [copied, setCopied] = useState(false);
  const canCopy = !!message.text && message.status !== 'streaming';
  const canEdit = user && !busy && !running;
  const canBranch = !user && !!message.branchNodeId && !busy && !running;

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
        <div data-user-text="" className="max-w-[82%] rounded-xl border border-border/70 bg-muted/60 px-3.5 py-2.5 text-[14px] leading-[1.5] whitespace-pre-wrap break-words">
          {message.images?.length ? <MessageImages images={message.images} messageId={message.id} conversationId={activeId} align="end" /> : null}
          {message.text}
        </div>
      ) : (
        <div className="min-w-0 max-w-full">
          {message.images?.length ? <MessageImages images={message.images} messageId={message.id} conversationId={activeId} /> : null}
          {message.text ? (
            <Markdown
              text={message.text}
              onCopyCode={text => {void copyText(text);}}
              resolveLocalFile={href => localFilePath(href)}
              onLocalFile={path => {void openConversationFile(activeId, path);}}
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

const MessageItem = memo(MessageItemView, (previous, next) =>
  previous.streaming === next.streaming && sameMessage(previous.message, next.message));

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
    void app().download('/api/image', {id: conversationId, message: messageId, index})
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

function ToolGroupView({messages}: {messages: WireMessage[]}) {
  const [open, setOpen] = useState(false);
  const first = toolLabel(messages[0]);
  const running = messages.some(message => message.status === 'running');
  const failed = messages.some(message => message.status === 'error');
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
        <span className="min-w-0 truncate">{messages.length === 1 ? first.label : `${messages.length} tool calls`}</span>
        <span data-tool-group-status="" className={cn('shrink-0 text-[11px]', failed ? 'text-destructive' : running ? 'text-foreground' : '')}>
          {running ? 'Running…' : failed ? 'Failed' : 'Done'}
        </span>
        <ChevronRight className={cn('ml-0.5 size-3 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      <div hidden={!open} className="mt-1 flex flex-col gap-1.5">{messages.map(message => <ToolCard key={message.id} message={message} />)}</div>
    </div>
  );
}

const ToolGroup = memo(ToolGroupView, (previous, next) => sameMessages(previous.messages, next.messages));

function ToolCardView({message}: {message: WireMessage}) {
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
        {message.command ? (
          <div className="border-b px-3 py-2">
            <span className="mb-1 block text-[11px] text-muted-foreground">Command</span>
            <pre className="max-h-40 overflow-auto font-mono text-[12px] whitespace-pre-wrap break-words">{message.command.text}</pre>
            <span className="mt-2 block text-[11px] text-muted-foreground">Working directory</span>
            <code className="text-[11px] break-all">{message.command.cwd}</code>
          </div>
        ) : null}
        {message.text ? <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{message.text}</pre> : <p className="px-3 py-2 text-[12px] text-muted-foreground">No output.</p>}
      </div>
    </div>
  );
}

const ToolCard = memo(ToolCardView, (previous, next) => sameMessage(previous.message, next.message));
