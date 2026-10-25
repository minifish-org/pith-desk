import {memo, useEffect, useMemo, useState} from 'react';
import {
  ChevronRight, FileText, Folder, LoaderCircle, LogOut, MoreHorizontal, Plug, Plus, Search,
  Settings, ShieldAlert, SquarePen, PanelLeftClose,
} from 'lucide-react';
import {useShallow} from 'zustand/react/shallow';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime.ts';
import {runStatus, selectedWorkspace} from '@/lib/derive.ts';
import {
  newConversation, openDeletion, openRename, openWorkspace, selectConversation, selectWorkspace,
  exportConversation, isConversationRunning,
} from '@/actions/conversations.ts';
import {openSettings} from '@/actions/settings.ts';
import {openConnections} from '@/actions/connections.ts';
import {openResources} from '@/actions/resources.ts';
import {BrandMark} from '@/components/brand';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';

function SidebarView({onCollapse, overlay, onNavigate}: {onCollapse?: () => void; overlay?: boolean; onNavigate?: () => void}) {
  const state = useDesk(useShallow(store => ({
    workspaces: store.state.workspaces,
    conversations: store.state.conversations,
    activeId: store.state.activeId,
    runs: store.state.runs,
  })));
  const initialWorkspaceId = useDesk(store => selectedWorkspace(store.state, store.selectedWorkspaceId)?.id || '');
  const workspace = useDesk(store => selectedWorkspace(store.state, store.selectedWorkspaceId));
  const busy = useDesk(store => store.activity.busy);
  const connection = useDesk(store => store.connection);
  const loaded = useDesk(store => store.loaded);
  const search = useDesk(store => store.search);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialWorkspaceId ? [initialWorkspaceId] : []));

  useEffect(() => {
    setExpanded(previous => {
      const next = new Set([...previous].filter(id => state.workspaces.some(entry => entry.id === id)));
      // The current workspace opens automatically; other groups keep the user's choice.
      if (workspace?.id) next.add(workspace.id);
      return next;
    });
  }, [state.workspaces, workspace?.id]);

  const titlebarOverlay = runtime.titlebar === 'overlay';
  const closeButton = (
    <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close navigation" title="Close navigation" aria-expanded onClick={onCollapse}>
      <PanelLeftClose className="size-4" />
    </Button>
  );
  const collapseControl = onCollapse
    ? overlay ? closeButton : (
      <Tooltip>
        <TooltipTrigger asChild>{closeButton}</TooltipTrigger>
        <TooltipContent side="right">Collapse navigation</TooltipContent>
      </Tooltip>
    )
    : null;

  const navigate = (action: () => void) => {action(); onNavigate?.();};
  const conversations = useMemo(() => [...state.conversations].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [state.conversations]);
  const query = search.trim().toLowerCase();

  return (
    <aside data-navigation-rail="" className={cn('flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground', overlay && 'w-[280px] border-r shadow-xl')} aria-label="Navigation">
      {titlebarOverlay ? (
        <div
          data-app-region="drag"
          data-titlebar-spacer=""
          className="flex shrink-0 items-center justify-end px-3"
          style={{height: 'var(--mygo-titlebar-height, 52px)'}}
        >
          {collapseControl}
        </div>
      ) : null}
      <div
        data-app-region="drag"
        data-rail-heading=""
        className="flex shrink-0 items-center gap-2.5 px-3"
        style={{
          height: titlebarOverlay ? '44px' : 'var(--frame-header-height)',
          paddingLeft: titlebarOverlay ? '1.25rem' : 'max(1.25rem, var(--mygo-titlebar-inset-left, 0px))',
        }}
      >
        <div data-brand="" className="flex min-w-0 items-center gap-2.5">
          <BrandMark className="size-6 shrink-0" />
          <span className="truncate text-[18px] font-semibold">Pith <span className="font-normal text-muted-foreground">Desk</span></span>
        </div>
        {!titlebarOverlay ? collapseControl : null}
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Workspaces</span>
          <Button variant="ghost" size="icon-xs" aria-label="Manage workspaces" title="Manage workspaces" onClick={openWorkspace}>
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search conversations"
            placeholder="Search conversations"
            value={search}
            onChange={event => desk().setSearch(event.target.value)}
            className="h-8 bg-background/70 pl-8 text-[13px] shadow-none"
          />
        </div>
      </div>

      <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {state.workspaces.length === 0 ? (
          <div className="mx-1 mt-3 rounded-lg border border-dashed p-4 text-center">
            <Folder className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">No workspaces yet.</p>
            <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => navigate(openWorkspace)}>Add workspace</Button>
          </div>
        ) : null}
        {state.workspaces.map(entry => {
          const children = conversations.filter(conversation => conversation.workspaceId === entry.id && (!query || (conversation.title || '').toLowerCase().includes(query)));
          const open = expanded.has(entry.id) || !!query;
          if (query && !children.length) return null;
          return (
            <section key={entry.id} className="mb-1">
              <div className={cn('group/workspace flex items-center rounded-md', workspace?.id === entry.id && 'bg-sidebar-accent/60')}>
                <button
                  type="button"
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[13px] font-medium hover:bg-sidebar-accent/60"
                  onClick={() => setExpanded(previous => {
                    const next = new Set(previous);
                    if (next.has(entry.id)) next.delete(entry.id);
                    else next.add(entry.id);
                    return next;
                  })}
                  onDoubleClick={() => navigate(() => {void selectWorkspace(entry.id);})}
                >
                  <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost" size="icon-xs" className="mr-0.5 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100"
                      aria-label={`New conversation in ${entry.name}`}
                      disabled={busy}
                      onClick={() => navigate(() => {void newConversation(entry.id);})}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New conversation</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost" size="icon-xs" className="mr-1 opacity-0 group-hover/workspace:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                      aria-label={`${entry.name} options`}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onSelect={() => navigate(() => {void selectWorkspace(entry.id);})}>Open workspace</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => navigate(() => {void newConversation(entry.id);})}>New conversation</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => navigate(() => openDeletion('workspace', entry.id))}>Remove workspace…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {open ? (
                <div className="mt-0.5 ml-3 flex flex-col gap-px border-l border-sidebar-border/70 pl-2">
                  {children.length ? children.map(conversation => {
                    const status = runStatus(state, conversation);
                    const active = conversation.id === state.activeId;
                    const running = isConversationRunning(conversation.id);
                    return (
                      <div key={conversation.id} className={cn('group/row flex items-center rounded-md', active && 'bg-sidebar-accent')}>
                        <button
                          type="button"
                          title={conversation.title || 'Untitled conversation'}
                          className={cn('flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[13px]', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
                          onClick={() => navigate(() => {void selectConversation(conversation.id);})}
                        >
                          <span className="truncate">{conversation.title || 'Untitled conversation'}</span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            {status === 'approval' ? <ShieldAlert className="size-3 text-[var(--warning)]" aria-label="Waiting for approval" /> : null}
                            {status === 'running' ? <LoaderCircle data-history-spinner="" className="size-3 animate-spin text-foreground" aria-label="Running" /> : null}
                            {status === 'unread' ? <span data-history-unread="" className="size-1.5 rounded-full bg-foreground" aria-label="Unread" /> : null}
                          </span>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost" size="icon-xs"
                              className="mr-0.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                              aria-label={`Actions for ${conversation.title || 'Untitled conversation'}`}
                            >
                              <MoreHorizontal className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem disabled={running} onSelect={() => navigate(() => openRename(conversation.id))}>Rename…</DropdownMenuItem>
                            {active ? <DropdownMenuItem disabled={running} onSelect={() => navigate(() => desk().openModal({kind: 'history', id: 'history'}))}>Conversation branches</DropdownMenuItem> : null}
                            <DropdownMenuItem disabled={running} onSelect={() => {void exportConversation(conversation.id);}}>Export Markdown</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" disabled={running} onSelect={() => navigate(() => openDeletion('conversation', conversation.id))}>Delete…</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  }) : (
                    <button
                      type="button"
                      className="rounded-md px-1.5 py-1.5 text-left text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => navigate(() => {void newConversation(entry.id);})}
                    >
                      <SquarePen className="mr-1.5 inline size-3" />New conversation
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <div data-sidebar-bottom="" className="shrink-0 space-y-0.5 border-t border-sidebar-border/70 p-2">
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-[13px] font-normal text-muted-foreground" onClick={() => navigate(openResources)}>
          <FileText className="size-4" />Workspace resources
        </Button>
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-[13px] font-normal text-muted-foreground" onClick={() => navigate(openConnections)}>
          <Plug className="size-4" />Connections
        </Button>
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-[13px] font-normal text-muted-foreground" onClick={() => navigate(openSettings)}>
          <Settings className="size-4" />Settings
        </Button>
        {runtime.server ? (
          <Button
            variant="ghost" size="icon-sm" aria-label="Log out" title="Log out"
            className="ml-1 text-muted-foreground"
            onClick={() => {void runtime.session?.logout().catch(() => {});}}
          >
            <LogOut className="size-4" />
          </Button>
        ) : null}
        <div data-local-status="" className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
          <span
            className={cn('size-1.5 rounded-full', connection === 'reconnecting' ? 'bg-[var(--warning)] animate-pulse' : loaded ? 'bg-[var(--success)]' : 'bg-muted-foreground/50')}
            aria-hidden="true"
          />
          {connection === 'reconnecting' ? 'Reconnecting…' : !loaded ? 'Connecting…' : runtimeLabel()}
        </div>
      </div>
    </aside>
  );
}


export const Sidebar = memo(SidebarView);

function runtimeLabel(): string {
  return runtime.server ? 'Server' : 'Local';
}
