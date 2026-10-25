// Workspace tool tabs. The action/store pair owns workspace layouts,
// persistence and explicit terminal closing.
import {memo, useEffect, useState} from 'react';
import {Folder, FolderOpen, Globe, PanelRightClose, Plus, TerminalSquare, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {useDesk} from '@/stores/desk.ts';
import {emptyToolLayout, useWorkspaceTools} from '@/stores/workspace-tools.ts';
import {selectedWorkspace} from '@/lib/derive.ts';
import {closeToolTab, createToolTab, loadWorkspaceTools, selectToolTab, updateFileView} from '@/actions/workspace-tools.ts';
import {runtime} from '@/lib/runtime.ts';
import {Button} from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {FileBrowser} from '@/components/file-browser';
import {TerminalView} from '@/components/terminal';
import {WebPreviewView} from '@/components/web-preview';

function ToolsRailView({onClose, visible = true}: {onClose: () => void; visible?: boolean}) {
  const workspaceId = useDesk(store => selectedWorkspace(store.state, store.selectedWorkspaceId)?.id || '');
  const workspacePath = useDesk(store => selectedWorkspace(store.state, store.selectedWorkspaceId)?.path || '');
  const hasWorkspace = useDesk(store => !!selectedWorkspace(store.state, store.selectedWorkspaceId));
  const layout = useWorkspaceTools(store => store.workspaces[workspaceId]?.layout || emptyToolLayout);
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {if (visible) setEverOpened(true);}, [visible]);

  useEffect(() => {loadWorkspaceTools(workspaceId);}, [workspaceId]);

  return (
    <aside data-tools-rail="" aria-label="Workspace tools" className="flex h-full min-h-0 flex-col border-l border-border/70 bg-background">
      <div
        data-app-region="drag"
        data-rail-heading=""
        className="flex shrink-0 items-center gap-1 border-b px-2"
        style={{height: 'var(--frame-header-height)', paddingRight: 'max(0.5rem, var(--mygo-titlebar-inset-right, 0px))'}}
      >
        {layout.tabs.length ? (
          <div role="tablist" aria-label="Workspace tools" data-app-region="no-drag" className="scrollbar-quiet flex min-w-0 items-center gap-0.5 overflow-x-auto py-1">
            {layout.tabs.map(tab => (
              <div key={tab.id} className={cn('group/tab flex shrink-0 items-center rounded-md text-[12px]', tab.id === layout.activeId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === layout.activeId}
                  title={tab.kind === 'files' ? workspacePath : tab.kind === 'terminal' ? `${runtime.server ? 'Server' : 'Local'} · ${workspacePath}` : tab.label}
                  className="flex items-center gap-1.5 px-2 py-1"
                  onClick={() => selectToolTab(workspaceId, tab.id)}
                >
                  {tab.kind === 'files' ? <Folder className="size-3" /> : tab.kind === 'terminal' ? <TerminalSquare className="size-3" /> : <Globe className="size-3" />}
                  {tab.label}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.label}`}
                  className="mr-0.5 rounded p-0.5 opacity-0 hover:bg-background/70 group-hover/tab:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => {void closeToolTab(workspaceId, tab.id);}}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="New tool tab" disabled={!hasWorkspace}><Plus className="size-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>New tool</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => createToolTab(workspaceId, 'files')}><FolderOpen className="size-3.5" />New files</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => createToolTab(workspaceId, 'terminal')}><TerminalSquare className="size-3.5" />New terminal</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => createToolTab(workspaceId, 'preview')}><Globe className="size-3.5" />New Web</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-xs" aria-label="Close tools" title="Close tools" aria-expanded onClick={onClose}><PanelRightClose className="size-3.5" /></Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!everOpened ? null
          : !hasWorkspace ? <p className="p-4 text-[12px] text-muted-foreground">Choose a workspace to browse its files.</p>
          : !layout.tabs.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <p className="text-[13px] text-muted-foreground">No tool tabs open</p>
              <div className="grid w-full max-w-44 gap-2">
                <Button size="sm" variant="secondary" className="justify-start" onClick={() => createToolTab(workspaceId, 'files')}><FolderOpen className="size-3.5" />Open files</Button>
                <Button size="sm" variant="secondary" className="justify-start" onClick={() => createToolTab(workspaceId, 'terminal')}><TerminalSquare className="size-3.5" />Open terminal</Button>
                <Button size="sm" variant="secondary" className="justify-start" onClick={() => createToolTab(workspaceId, 'preview')}><Globe className="size-3.5" />Open Web</Button>
              </div>
            </div>
          ) : layout.tabs.map(tab => (
            <div key={tab.id} role="tabpanel" aria-label={tab.label} className={cn('h-full min-h-0 flex-col', tab.id === layout.activeId ? 'flex' : 'hidden')}>
              {tab.kind === 'files' ? (
                <FileBrowser
                  key={`${workspaceId}-${tab.id}`} workspaceId={workspaceId} active={tab.id === layout.activeId}
                  expandedPaths={tab.files?.expanded || []}
                  initialScrollTop={tab.files?.scrollTop || 0}
                  onExpanded={expanded => updateFileView(workspaceId, tab.id, {expanded})}
                  onScrollTop={scrollTop => updateFileView(workspaceId, tab.id, {scrollTop})}
                />
              ) : tab.kind === 'terminal' ? (
                <TerminalView
                  workspaceId={workspaceId} tabId={tab.id} active={tab.id === layout.activeId}
                />
              ) : <WebPreviewView workspaceId={workspaceId} tabId={tab.id} active={tab.id === layout.activeId && visible} />}
            </div>
          ))}
      </div>
    </aside>
  );
}

export const ToolsRail = memo(ToolsRailView);
