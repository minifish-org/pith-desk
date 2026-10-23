import {useState} from 'react';
import {ChevronRight, Download, Folder, PanelLeft, PanelRight, FileText, LoaderCircle, ScanText} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import {selected, currentConversation, workspaceAction} from '@/actions/conversations.ts';
import {openArtifacts, closeArtifacts, artifactAction} from '@/actions/files.ts';
import {Button} from '@/components/ui/button';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';
import {Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle} from '@/components/ui/empty';

export function Header({onOpenNavigation, onOpenTools, showNavigationToggle, showToolsToggle}: {onOpenNavigation: (trigger?: HTMLElement) => void; onOpenTools: (trigger?: HTMLElement) => void; showNavigationToggle: boolean; showToolsToggle: boolean}) {
  const state = useDesk(store => store.state);
  const selectedId = useDesk(store => store.selectedWorkspaceId);
  const busy = useDesk(store => store.activity.busy);
  const artifacts = useDesk(store => store.artifacts);
  const workspace = selected();
  const conversation = currentConversation();
  const canCompact = !busy && !state.running && !!state.activeId && state.messages.length > 0;
  const [artifactOpen, setArtifactOpen] = useState(false);

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
        <Folder className="size-3.5 shrink-0" />
        <span data-breadcrumb-workspace="" className="max-w-[38%] truncate">{workspace ? workspace.name : 'No workspace'}</span>
        <ChevronRight className="size-3 shrink-0 opacity-60" />
        <span data-breadcrumb-current="" className="min-w-0 truncate text-foreground">{conversation?.title || 'New conversation'}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground"
          disabled={!canCompact}
          onClick={() => {void workspaceAction('compact');}}
          title={canCompact ? 'Summarize this conversation’s context' : 'Compacting needs a finished conversation with messages'}
        >
          <ScanText className="size-3.5" />
          Compact
        </Button>
        <Popover open={artifactOpen && artifacts.open} onOpenChange={open => {
          setArtifactOpen(open);
          if (open) openArtifacts();
          else closeArtifacts();
        }}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost" size="sm" data-artifacts-control=""
              hidden={!artifacts.files.length && !artifacts.loading && !artifacts.error}
              className={'h-7 gap-1.5 px-2 text-[12px] text-muted-foreground'}
              aria-label={`Conversation files (${artifacts.files.length} ${artifacts.files.length === 1 ? 'file' : 'files'})`}
              title={`Conversation files (${artifacts.files.length} ${artifacts.files.length === 1 ? 'file' : 'files'})`}
              disabled={!state.activeId}
            >
              <FileText className="size-3.5" />
              {artifacts.files.length ? <span className="tabular-nums">{artifacts.files.length}</span> : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" data-artifacts-panel="" forceMount className="w-80 p-0 data-[state=closed]:hidden">
            <div className="border-b px-3 py-2 text-[12px] font-medium">Workspace files from this conversation</div>
            <div className="max-h-80 overflow-y-auto p-1.5">
              {artifacts.loading ? <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading files…</div> : null}
              {artifacts.error ? <p className="px-2 py-3 text-[12px] text-destructive">{artifacts.error}</p> : null}
              {!artifacts.loading && !artifacts.error && artifacts.files.length === 0 ? (
                <Empty className="border-0 p-4">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><FileText /></EmptyMedia>
                    <EmptyTitle>No files yet</EmptyTitle>
                    <EmptyDescription>Files this conversation reads, writes or edits appear here.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {artifacts.files.map(file => (
                <div key={file.path} data-artifact-file="" className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[13px]"
                    onClick={() => {
                      desk().openModal({kind: 'preview', id: `preview-${file.path}`, owner: {kind: 'artifact', id: state.activeId}, path: file.path});
                    }}
                  >
                    <strong data-artifact-name="" className="block truncate text-[13px] font-normal">{file.name}</strong>
                    <span className="block truncate text-[11px] text-muted-foreground">{file.path}</span>
                  </button>
                  <Button
                    variant="ghost" size="icon-xs" aria-label="Preview" title={`Preview ${file.name}`}
                    onClick={() => {
                      desk().openModal({kind: 'preview', id: `preview-${file.path}`, owner: {kind: 'artifact', id: state.activeId}, path: file.path});
                    }}
                  >
                    <ScanText className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon-xs" aria-label="Download" title={`Download ${file.name}`}
                    onClick={() => {
                      setArtifactOpen(false);
                      closeArtifacts();
                      void artifactAction('open', {ownerId: state.activeId, path: file.path});
                    }}
                  >
                    <Download className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
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
