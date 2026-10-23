import {useEffect, useState} from 'react';
import {Download, FolderOpen, LoaderCircle, Pencil, GitBranch} from 'lucide-react';
import {useMemo} from 'react';
import {cn} from '@/lib/utils';
import {closeModalId, useDesk, type ModalOf} from '@/stores/desk.ts';
import {request} from '@/actions/core.ts';
import {artifactAction, downloadConversationFile, workspaceFileAction} from '@/actions/files';
import {copyText} from '@/actions/core';
import {imagePreviewBlob} from '@/image-data';
import {runtime} from '@/lib/runtime';
import {Markdown} from '@/lib/markdown';
import {relativeDay} from '@/lib/format';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import type {HistoryNode} from '@/contract.generated.ts';

export function PreviewDialog({modal}: {modal: ModalOf<'preview'>}) {
  const activeId = useDesk(store => store.state.activeId);
  const selectedWorkspaceId = useDesk(store => store.selectedWorkspaceId);
  const [page, setPage] = useState(0);
  const [state, setState] = useState<
    | {kind: 'loading'}
    | {kind: 'text'; text: string; truncated?: boolean}
    | {kind: 'markdown'; text: string; truncated?: boolean}
    | {kind: 'image'; src: string; truncated?: boolean}
    | {kind: 'error'; error: string}
  >({kind: 'loading'});
  const name = modal.path.split('/').pop() || modal.path;
  const workspacePreview = modal.owner.kind === 'workspace';

  useEffect(() => {setPage(0);}, [modal.path]);
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    const load = async () => {
      try {
        const preview = workspacePreview
          ? await request('/api/workspace-preview', {query: {workspaceId: modal.owner.id, path: modal.path}})
          : await request('/api/artifact-preview', {query: {id: modal.owner.id, path: modal.path}});
        if (!active) return;
        if (preview.kind === 'image' && preview.data && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(preview.mimeType || '')) {
          const blob = await imagePreviewBlob(preview.data, preview.mimeType!, () => active);
          if (!blob || !active) return;
          objectUrl = URL.createObjectURL(blob);
          setState({kind: 'image', src: objectUrl, truncated: preview.truncated});
          return;
        }
        setState({kind: preview.kind === 'markdown' ? 'markdown' : 'text', text: preview.text || '', truncated: preview.truncated});
      } catch (failure) {
        if (active) setState({kind: 'error', error: failure instanceof Error ? failure.message : String(failure)});
      }
    };
    void load();
    return () => {active = false; if (objectUrl) URL.revokeObjectURL(objectUrl);};
  }, [modal.owner.id, modal.owner.kind, modal.path]);

  const pages = useMemo(() => state.kind === 'text' ? paginate(state.text) : [], [state]);
  const pageText = state.kind === 'text' ? pages[Math.min(page, pages.length - 1)] || '' : '';
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent data-file-preview-modal="" className="flex max-h-[88dvh] w-[calc(100vw-2rem)] flex-col overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle className="truncate text-[14px]">{name}</DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]">{modal.path}</DialogDescription>
        </DialogHeader>
        <div data-file-preview-body="" className="scrollbar-quiet min-h-0 flex-1 overflow-auto bg-card px-5 py-4">
          {state.kind === 'loading' ? <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading preview…</p> : null}
          {state.kind === 'error' ? <p className="text-[12px] text-destructive" role="alert">{state.error}</p> : null}
{state.kind === 'image' ? <div className="grid place-items-center"><img data-file-preview-image="" src={state.src} alt={name} className="max-h-[68dvh] max-w-full object-contain" /></div> : null}
          {state.kind === 'markdown' ? <Markdown text={state.text} onCopyCode={text => {void copyText(text);}} resolveLocalFile={() => null} onLocalFile={() => {}} /> : null}
          {state.kind === 'text' ? <pre data-file-preview-text="" className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">{pageText}</pre> : null}
          {state.kind === 'text' && pages.length > 1 ? (
            <div data-preview-pagination="" className="mt-3 flex items-center justify-end gap-2 border-t pt-2 text-[11px] text-muted-foreground">
              <Button size="xs" variant="ghost" disabled={page <= 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</Button>
              <span>Page {Math.min(page + 1, pages.length)} of {pages.length}</span>
              <Button size="xs" variant="ghost" disabled={page >= pages.length - 1} onClick={() => setPage(value => Math.min(pages.length - 1, value + 1))}>Next</Button>
            </div>
          ) : null}
          {state.kind !== 'loading' && state.kind !== 'error' && state.truncated ? <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">The preview was truncated because the file is large.</p> : null}
        </div>
        <DialogFooter className="mx-0 mb-0 items-center justify-end border-t px-5 pt-3 pb-5">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => {void copyText(modal.path);}}>Copy path</Button>
            {!runtime.server ? <Button size="sm" variant="secondary" onClick={() => {if (workspacePreview) void workspaceFileAction('reveal', {workspaceId: modal.owner.id, path: modal.path}); else void artifactAction('reveal', {ownerId: activeId, path: modal.path});}}><FolderOpen className="size-3.5" />Reveal</Button> : null}
            <Button
              size="sm" variant="secondary"
              onClick={() => {
                if (workspacePreview) void workspaceFileAction('download', {workspaceId: modal.owner.id, path: modal.path});
                else void downloadConversationFile(activeId, modal.path);
              }}
            >
              <Download className="size-3.5" />Download
            </Button>
            {!runtime.server && workspacePreview ? (
              <Button
                size="sm" variant="secondary"
                onClick={() => {void workspaceFileAction('open', {workspaceId: modal.owner.id, path: modal.path});}}
              >
                <FolderOpen className="size-3.5" />Open
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function HistoryDialog({modal}: {modal: ModalOf<'history'>}) {
  const activeId = useDesk(store => store.state.activeId);
  const [nodes, setNodes] = useState<HistoryNode[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  useEffect(() => {
    let active = true;
    void request('/api/history', {query: {id: activeId}}).then(result => {if (active) setNodes(result || []);}).catch(failure => {if (active) setError(failure instanceof Error ? failure.message : String(failure));});
    return () => {active = false;};
  }, [activeId]);
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[82dvh] w-full sm:max-w-xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Branch history</DialogTitle>
          <DialogDescription>Earlier nodes are kept so you can return to a previous reply. Continuing from a node replaces this conversation’s current path.</DialogDescription>
        </DialogHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {!nodes && !error ? <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading history…</p> : null}
          {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
          {nodes && !nodes.length ? <p className="text-[12px] text-muted-foreground">No branch history is recorded for this conversation.</p> : null}
          <div className="space-y-1.5">
            {nodes?.map(node => (
              <div key={node.id} className={cn('rounded-lg border px-3 py-2', node.active && 'border-l-2 border-l-foreground bg-accent/50')}>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <GitBranch className="size-3" />
                  <span className="capitalize">{node.role}</span>
                  {node.active ? <span className="ml-auto text-[11px] text-foreground">Current path</span> : null}
                </div>
                <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed whitespace-pre-wrap">{node.text || '(empty)'}</p>
                {!node.active ? (
                  <Button
                    size="xs" variant="secondary" className="mt-1.5" disabled={!!busyId}
                    onClick={async () => {
                      setBusyId(node.id);
                      try {
                        const {mutate} = await import('@/actions/core.ts');
                        if (await mutate('/api/branch', {id: activeId, nodeId: node.id})) closeModalId(modal.id);
                        else setError(useDesk.getState().activity.error);
                      } finally {setBusyId('');}
                    }}
                  >
                    {busyId === node.id ? <LoaderCircle className="size-3 animate-spin" /> : <Pencil className="size-3" />}Continue from here
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter className="mx-0 mb-0 border-t px-4 pt-3 pb-5"><Button size="sm" variant="secondary" onClick={() => closeModalId(modal.id)}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const previewPageBytes = 256 * 1024;

function paginate(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= previewPageBytes) return [text];
  const pages: string[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(bytes.length, offset + previewPageBytes);
    // Keep UTF-8 sequences whole at the page boundary.
    while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    pages.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
  }
  return pages;
}

export {relativeDay};
