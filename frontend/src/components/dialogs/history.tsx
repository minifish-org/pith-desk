import {useEffect, useState} from 'react';
import {GitBranch, LoaderCircle, Pencil} from 'lucide-react';
import {cn} from '@/lib/utils';
import {closeModalId, desk, useDesk, type ModalOf} from '@/stores/desk.ts';
import {mutate, request} from '@/actions/core.ts';
import {Button} from '@/components/ui/button';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import type {HistoryNode} from '@/contract.generated.ts';

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
                        if (await mutate('/api/branch', {id: activeId, nodeId: node.id})) closeModalId(modal.id);
                        else setError(desk().activity.error);
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
