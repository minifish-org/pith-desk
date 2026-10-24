import {useEffect, useRef, useState} from 'react';
import {ChevronRight, File, Folder, FolderOpen, LoaderCircle, MoreHorizontal, RefreshCw} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk} from '@/stores/desk.ts';
import {request} from '@/actions/core.ts';
import {workspaceFileAction} from '@/actions/files.ts';
import {insertReference} from '@/actions/composer.ts';
import {runtime} from '@/lib/runtime.ts';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {WorkspaceEntry} from '@/contract.generated.ts';

interface Directory {
  path: string;
  expanded: boolean;
  entries: WorkspaceEntry[];
  loading?: boolean;
  error?: string;
}

/** Lazy workspace tree used by the Files tool tab. Expanded folders and the
 * scroll offset are owned by the tab so switching tabs restores the view. */
export function FileBrowser({workspaceId, active, initialExpanded, initialScrollTop, onExpanded, onScrollTop}: {
  workspaceId: string;
  active: boolean;
  initialExpanded: string[];
  initialScrollTop: number;
  onExpanded: (paths: string[]) => void;
  onScrollTop: (top: number) => void;
}) {
  const [directories, setDirectories] = useState<Map<string, Directory>>(new Map([['', {path: '', expanded: true, entries: [], loading: true}]]));
  const requests = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  const tree = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const desiredTop = useRef(initialScrollTop);
  const expandedPaths = useRef(new Set(initialExpanded));

  const load = async (path: string) => {
    const controller = new AbortController();
    requests.current.get(path)?.abort();
    requests.current.set(path, controller);
    const current = generation.current;
    setDirectories(previous => new Map(previous).set(path, {...(previous.get(path) || {path, expanded: true, entries: []}), loading: true, error: undefined}));
    try {
      const listing = await request('/api/workspace-files', {query: {workspaceId, path}, signal: controller.signal});
      if (current !== generation.current || requests.current.get(path) !== controller) return;
      setDirectories(previous => new Map(previous).set(path, {path, expanded: true, entries: listing.entries || [], loading: false}));
    } catch (failure) {
      if (current !== generation.current || requests.current.get(path) !== controller) return;
      setDirectories(previous => new Map(previous).set(path, {path, expanded: true, entries: [], error: failure instanceof Error ? failure.message : String(failure)}));
    } finally {
      if (requests.current.get(path) === controller) requests.current.delete(path);
    }
  };

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {if (tree.current) tree.current.scrollTop = desiredTop.current;});
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    generation.current++;
    setDirectories(new Map([['', {path: '', expanded: true, entries: [], loading: true}]]));
    const restore = initialExpanded.filter(Boolean).sort((a, b) => a.split('/').length - b.split('/').length);
    const current = generation.current;
    void (async () => {
      await load('');
      for (const path of restore) {
        if (generation.current !== current) return;
        await load(path);
        setDirectories(previous => {
          const next = new Map(previous);
          const directory = next.get(path);
          if (directory) next.set(path, {...directory, expanded: true});
          return next;
        });
      }
      if (generation.current === current && active) {
        requestAnimationFrame(() => {if (tree.current) tree.current.scrollTop = desiredTop.current;});
      }
    })();
    return () => {generation.current++; for (const controller of requests.current.values()) controller.abort(); requests.current.clear();};
  }, [workspaceId]);

  const toggle = (entry: WorkspaceEntry, expanded: boolean) => {
    if (expanded) void load(entry.path);
    setDirectories(previous => {
      const next = new Map(previous);
      const directory = next.get(entry.path) || {path: entry.path, expanded: true, entries: []};
      next.set(entry.path, {...directory, expanded});
      return next;
    });
    if (expanded) expandedPaths.current.add(entry.path);
    else expandedPaths.current.delete(entry.path);
    onExpanded([...expandedPaths.current].sort());
  };

  const refresh = () => {
    void load('');
    for (const [path, directory] of directories) if (path && directory.expanded) void load(path);
  };

  const root = directories.get('');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Refresh workspace files" onClick={refresh}><RefreshCw className="size-3.5" /></Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>
      <div
        ref={tree} role="navigation" aria-label="Workspace files"
        className="scrollbar-quiet min-h-0 flex-1 overflow-auto px-1 py-1"
        onScroll={event => {
          if (!active) return;
          const top = event.currentTarget.scrollTop;
          desiredTop.current = top;
          if (scrollFrame.current) return;
          scrollFrame.current = requestAnimationFrame(() => {scrollFrame.current = 0; onScrollTop(top);});
        }}
      >
        {root?.loading ? <p className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading files…</p> : null}
        {root?.error ? <p className="px-2 py-3 text-[12px] text-destructive">{root.error}</p> : null}
        {!root?.loading && !root?.error && !root?.entries.length ? <p className="px-2 py-3 text-[12px] text-muted-foreground">This workspace is empty.</p> : null}
        <ul>{root?.entries.map(entry => <TreeRow key={entry.path} entry={entry} workspaceId={workspaceId} directories={directories} depth={0} onToggle={toggle} />)}</ul>
      </div>
    </div>
  );
}

function TreeRow({entry, workspaceId, directories, depth, onToggle}: {
  entry: WorkspaceEntry;
  workspaceId: string;
  directories: Map<string, Directory>;
  depth: number;
  onToggle: (entry: WorkspaceEntry, expanded: boolean) => void;
}) {
  const directory = directories.get(entry.path) || {path: entry.path, expanded: false, entries: []};
  const Icon = entry.directory ? (directory.expanded ? FolderOpen : Folder) : File;
  const preview = () => desk().openModal({kind: 'preview', id: `preview-${entry.path}`, owner: {kind: 'workspace', id: workspaceId}, path: entry.path});
  return (
    <li>
      <div className="group flex items-center rounded-md hover:bg-accent/60">
        <button
          type="button"
          aria-expanded={entry.directory ? directory.expanded : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px]"
          style={{paddingLeft: `${6 + depth * 13}px`}}
          onClick={() => entry.directory ? onToggle(entry, !directory.expanded) : preview()}
        >
          {entry.directory ? <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', directory.expanded && 'rotate-90')} /> : <span className="size-3 shrink-0" />}
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{entry.name}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className="mr-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Actions for ${entry.path}`}><MoreHorizontal className="size-3.5" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {entry.directory ? (
              <>
                <DropdownMenuItem onSelect={() => onToggle(entry, true)}>Open folder</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => insertReference(entry.path)}>Insert reference</DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onSelect={preview}>Preview</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => insertReference(entry.path)}>Insert reference</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => {void workspaceFileAction('download', {workspaceId, path: entry.path});}}>Download</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => {void workspaceFileAction('open', {workspaceId, path: entry.path});}}>Open</DropdownMenuItem>
                {!runtime.server ? <DropdownMenuItem onSelect={() => {void workspaceFileAction('reveal', {workspaceId, path: entry.path});}}>Reveal</DropdownMenuItem> : null}
                {!runtime.server ? <DropdownMenuItem onSelect={() => {void workspaceFileAction('copy', {workspaceId, path: entry.path});}}>Copy file</DropdownMenuItem> : null}
                <DropdownMenuItem onSelect={() => {void workspaceFileAction('copy-path', {workspaceId, path: entry.path});}}>{runtime.server ? 'Copy server path' : 'Copy path'}</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {entry.directory && directory.expanded ? (
        <ul>
          {directory.loading ? <li className="py-1 pl-6 text-[11px] text-muted-foreground">Loading…</li> : null}
          {directory.error ? <li className="py-1 pl-6 text-[11px] text-destructive">{directory.error}</li> : null}
          {directory.entries.map(child => <TreeRow key={child.path} entry={child} workspaceId={workspaceId} directories={directories} depth={depth + 1} onToggle={onToggle} />)}
        </ul>
      ) : null}
    </li>
  );
}
