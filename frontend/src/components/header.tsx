import {ChevronRight, Folder, PanelLeft, PanelRight} from 'lucide-react';
import {useDesk} from '@/stores/desk.ts';
import {workspaceAction} from '@/actions/conversations.ts';
import {activeConversation, selectedWorkspace} from '@/lib/derive.ts';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';

function CompressIcon({className}: {className?: string}) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 3h10M12 3v6m-3-3 3 3 3-3M5 12h14M12 21v-6m-3 3 3-3 3 3M7 21h10" />
    </svg>
  );
}

export function Header({onOpenNavigation, onOpenTools, showNavigationToggle, showToolsToggle}: {onOpenNavigation: (trigger?: HTMLElement) => void; onOpenTools: (trigger?: HTMLElement) => void; showNavigationToggle: boolean; showToolsToggle: boolean}) {
  const state = useDesk(store => store.state);
  const busy = useDesk(store => store.activity.busy);
  const workspace = useDesk(store => selectedWorkspace(store.state, store.selectedWorkspaceId));
  const conversation = useDesk(store => activeConversation(store.state));
  const canCompact = !busy && !state.running && !!state.activeId && state.messages.length > 0;

  return (
    <header
      data-app-region="drag"
      className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3"
      style={{height: 'var(--frame-header-height)', paddingRight: 'max(0.75rem, var(--mygo-titlebar-inset-right, 0px))', paddingLeft: showNavigationToggle ? 'max(0.75rem, var(--mygo-titlebar-inset-left, 0px))' : undefined}}
    >
      {showNavigationToggle ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Toggle navigation" aria-expanded={false} onClick={event => onOpenNavigation(event.currentTarget)}>
              <PanelLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Show navigation</TooltipContent>
        </Tooltip>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-muted-foreground">
        <Folder className="hidden size-3.5 shrink-0 min-[721px]:inline" />
        <span data-breadcrumb-workspace="" className="hidden max-w-[6.875rem] truncate min-[521px]:inline min-[721px]:max-w-[12rem]">{workspace ? workspace.name : 'No workspace'}</span>
        <ChevronRight className="hidden size-3 shrink-0 opacity-60 min-[521px]:inline" />
        <span data-breadcrumb-current="" className="min-w-0 truncate text-foreground">{conversation?.title || 'New conversation'}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost" size="icon-sm" className="text-muted-foreground"
          aria-label="Compact"
          disabled={!canCompact}
          onClick={() => {void workspaceAction('compact');}}
          title={canCompact ? 'Compress context by summarizing older messages' : 'Compacting needs a finished conversation with messages'}
        >
          <CompressIcon className="size-3.5" />
        </Button>
        {showToolsToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Toggle tools" aria-expanded={false} onClick={event => onOpenTools(event.currentTarget)}>
                <PanelRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Show workspace tools</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </header>
  );
}
