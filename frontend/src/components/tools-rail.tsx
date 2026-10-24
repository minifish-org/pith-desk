// The workspace tools rail: persisted tabs for files, terminals and web
// previews, plus the narrow-screen drawer wrapper.
import {memo, useEffect, useRef, useState} from 'react';
import {Folder, FolderOpen, Globe, PanelRightClose, Plus, TerminalSquare, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {useDesk} from '@/stores/desk.ts';
import {selectedWorkspace} from '@/lib/derive.ts';
import {request} from '@/actions/core.ts';
import {runtime} from '@/lib/runtime.ts';
import {Button} from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {FileBrowser} from '@/components/file-browser';
import {TerminalView} from '@/components/terminal';
import {WebPreviewView} from '@/components/web-preview';

type Kind = 'files' | 'terminal' | 'preview';
interface Tab {id: string; kind: Kind; label: string; files?: {expanded: string[]; scrollTop?: number}}
interface Layout {tabs: Tab[]; activeId: string; next: {files: number; terminal: number}}

const storagePrefix = 'pith-desk.tools.v1.';
const newID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

function readLayout(workspaceId: string): Layout {
  try {
    const raw = localStorage.getItem(storagePrefix + workspaceId);
    if (raw && raw.length < 2 * 1024 * 1024) {
      const value = JSON.parse(raw) as Layout;
      if (Array.isArray(value.tabs) && value.tabs.length <= 32) {
        const tabs = value.tabs
          .filter(tab => tab && typeof tab.id === 'string' && ['files', 'terminal', 'preview'].includes(tab.kind))
          .map(tab => ({
            id: tab.id, kind: tab.kind, label: tab.label,
            ...(tab.kind === 'files' ? {files: {expanded: Array.isArray(tab.files?.expanded) ? tab.files.expanded.filter(path => typeof path === 'string').slice(0, 256) : [], scrollTop: tab.files?.scrollTop}} : {}),
          }));
        // A saved empty layout is intentional: closing every tab is remembered.
        const activeId = tabs.some(tab => tab.id === value.activeId) ? value.activeId : tabs[0]?.id || '';
        return {tabs, activeId, next: {files: value.next?.files || 2, terminal: value.next?.terminal || 1}};
      }
    }
  } catch { /* Fall through to a fresh layout. */ }
  const id = newID();
  return {tabs: [{id, kind: 'files', label: 'Files', files: {expanded: []}}], activeId: id, next: {files: 2, terminal: 1}};
}

function saveLayout(workspaceId: string, layout: Layout): void {
  try {localStorage.setItem(storagePrefix + workspaceId, JSON.stringify(layout));} catch { /* Layout is a preference. */ }
}

function ToolsRailView({onClose, visible = true}: {onClose: () => void; visible?: boolean}) {
  const workspaceId = useDesk(store => selectedWorkspace(store.state, store.selectedWorkspaceId)?.id || '');
  const workspace = useDesk(store => store.state.workspaces.find(entry => entry.id === workspaceId));
  const [layout, setLayout] = useState<Layout>(() => workspace ? readLayout(workspace.id) : {tabs: [], activeId: '', next: {files: 2, terminal: 1}});
  const [pending, setPending] = useState('');
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {if (visible) setEverOpened(true);}, [visible]);

  useEffect(() => {
    if (!workspaceId) return;
    setLayout(readLayout(workspaceId));
  }, [workspaceId]);

  const update = (next: Layout) => {
    setLayout(next);
    if (workspace) saveLayout(workspace.id, next);
  };
  const create = (kind: Kind) => {
    if (!workspace || layout.tabs.length >= 32) return;
    const next = {...layout.next};
    const number = kind === 'preview' ? 1 : next[kind]++;
    const label = kind === 'files' ? (number === 1 ? 'Files' : `Files ${number}`) : kind === 'terminal' ? (number === 1 ? 'Terminal' : `Terminal ${number}`) : 'Web';
    const tab: Tab = {id: newID(), kind, label, ...(kind === 'files' ? {files: {expanded: []}} : {})};
    update({...layout, tabs: [...layout.tabs, tab], activeId: tab.id, next});
  };
  const close = async (id: string) => {
    const entry = layout.tabs.find(tab => tab.id === id);
    if (!entry || pending || !workspace) return;
    setPending(id);
    try {
      if (entry.kind === 'terminal') {
        // Closing a tab owns the shell it created; a deliberate session ends
        // only through this action (or the Close shell button).
        try {await request('/api/terminal/close', {workspaceId: workspace.id, id});} catch { /* The tab closes anyway. */ }
      }
      const index = layout.tabs.findIndex(tab => tab.id === id);
      const tabs = layout.tabs.filter(tab => tab.id !== id);
      const activeId = layout.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id || '' : layout.activeId;
      update({...layout, tabs, activeId});
    } finally {setPending('');}
  };

  return (
    <aside data-tools-rail="" aria-label="Workspace tools" className="flex h-full min-h-0 flex-col border-l border-border/70 bg-background">
      <div
        data-app-region="drag"
        data-rail-heading=""
        className="flex shrink-0 items-center gap-1 border-b px-2"
        style={{height: 'var(--frame-header-height)', paddingRight: 'max(0.5rem, var(--mygo-titlebar-inset-right, 0px))'}}
      >
        <span className="truncate pl-1.5 text-[12px] font-medium text-muted-foreground">Workspace tools</span>
        <div className="ml-auto flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="New tool tab" disabled={!workspace}><Plus className="size-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>New tool</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => create('files')}><FolderOpen className="size-3.5" />New files</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => create('terminal')}><TerminalSquare className="size-3.5" />New terminal</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => create('preview')}><Globe className="size-3.5" />New Web</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-xs" aria-label="Close tools" title="Close tools" aria-expanded onClick={onClose}><PanelRightClose className="size-3.5" /></Button>
        </div>
      </div>
      {layout.tabs.length ? (
        <div role="tablist" aria-label="Workspace tools" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5 py-1">
          {layout.tabs.map(tab => (
            <div key={tab.id} className={cn('group/tab flex shrink-0 items-center rounded-md text-[12px]', tab.id === layout.activeId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60')}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === layout.activeId}
                title={tab.kind === 'files' ? workspace?.path : tab.kind === 'terminal' ? `${runtime.server ? 'Server' : 'Local'} · ${workspace?.path || ''}` : tab.label}
                className="flex items-center gap-1.5 px-2 py-1"
                onClick={() => update({...layout, activeId: tab.id})}
              >
                {tab.kind === 'files' ? <Folder className="size-3" /> : tab.kind === 'terminal' ? <TerminalSquare className="size-3" /> : <Globe className="size-3" />}
                {tab.label}
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.label}`}
                className="mr-0.5 rounded p-0.5 opacity-0 hover:bg-background/70 group-hover/tab:opacity-100"
                onClick={() => {void close(tab.id);}}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!everOpened ? null
          : !workspace ? <p className="p-4 text-[12px] text-muted-foreground">Choose a workspace to browse its files.</p>
          : !layout.tabs.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FolderOpen className="size-6 text-muted-foreground" />
              <p className="text-[13px]">No tool tabs open</p>
              <Button size="sm" variant="secondary" onClick={() => create('files')}>Open files</Button>
            </div>
          ) : layout.tabs.map(tab => (
            <div key={tab.id} role="tabpanel" aria-label={tab.label} className={cn('h-full min-h-0 flex-col', tab.id === layout.activeId ? 'flex' : 'hidden')}>
              {tab.kind === 'files' ? (
                <FileBrowser
                  key={`${workspace.id}-${tab.id}`} workspaceId={workspace.id} active={tab.id === layout.activeId}
                  initialExpanded={tab.files?.expanded || []}
                  initialScrollTop={tab.files?.scrollTop || 0}
                  onExpanded={paths => update({...layout, tabs: layout.tabs.map(entry => entry.id === tab.id ? {...entry, files: {...entry.files, expanded: paths}} : entry)})}
                  onScrollTop={top => update({...layout, tabs: layout.tabs.map(entry => entry.id === tab.id ? {...entry, files: {...entry.files, expanded: entry.files?.expanded || [], scrollTop: top}} : entry)})}
                />
              ) : tab.kind === 'terminal' ? (
                <TerminalView
                  workspaceId={workspace.id} tabId={tab.id} active={tab.id === layout.activeId}
                  disabled={false}
                  onSessionClosed={() => {void close(tab.id);}}
                />
              ) : <WebPreviewView workspaceId={workspace.id} tabId={tab.id} active={tab.id === layout.activeId && visible} />}
            </div>
          ))}
      </div>
    </aside>
  );
}

export const ToolsRail = memo(ToolsRailView);

export function WorkspaceToolsDrawer({open, onClose}: {open: boolean; onClose: () => void}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[aria-label="Close tools"]')?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest('.xterm')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {cancelAnimationFrame(frame); window.removeEventListener('keydown', onKey);};
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button type="button" aria-label="Close tools overlay" className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div ref={panel} data-drawer-panel="" className="absolute inset-y-0 right-0 w-[min(340px,90vw)] shadow-xl"><ToolsRail onClose={onClose} /></div>
    </div>
  );
}
