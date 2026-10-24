import {useState} from 'react';
import {FolderOpen, LoaderCircle} from 'lucide-react';
import {closeModalId, useDesk, type ModalOf} from '@/stores/desk.ts';
import {addWorkspace, pickWorkspace, selectWorkspace} from '@/actions/conversations.ts';
import {runtime} from '@/lib/runtime.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle} from '@/components/ui/empty';

export function WorkspaceDialog({modal}: {modal: ModalOf<'workspace'>}) {
  const workspaces = useDesk(current => current.state.workspaces);
  const busy = useDesk(current => current.activity.busy);
  const [path, setPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Workspaces</DialogTitle></DialogHeader>
        {workspaces.length ? (
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {workspaces.map(workspace => (
              <button
                key={workspace.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left hover:bg-accent"
                onClick={() => {closeModalId(modal.id); void selectWorkspace(workspace.id);}}
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{workspace.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{workspace.path}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Empty className="border p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
              <EmptyTitle>No workspaces yet</EmptyTitle>
              <EmptyDescription>Choose a folder to give Pith a place to work.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <form
          className="space-y-2 border-t pt-3"
          onSubmit={async event => {
            event.preventDefault();
            if (!path.trim()) return;
            setError('');
            await addWorkspace(path.trim(), modal.id);
          }}
        >
          <label className="block text-[12px] font-medium" htmlFor="workspace-path">
            {runtime.server ? 'Server folder path' : 'Workspace folder'}
          </label>
          <div className="flex gap-1.5">
            <Input
              id="workspace-path"
              aria-label={runtime.server ? 'Server folder path' : 'Workspace folder'}
              placeholder={runtime.server ? '/srv/workspace' : '/Users/you/Work'}
              value={path}
              onChange={event => setPath(event.target.value)}
              autoFocus
            />
            {!runtime.server ? (
              <Button
                type="button" variant="secondary" disabled={picking}
                onClick={async () => {
                  setPicking(true);
                  try {
                    const chosen = await pickWorkspace();
                    if (chosen) setPath(chosen);
                  } finally {setPicking(false);}
                }}
              >
                {picking ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Choose…
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {runtime.server ? 'Choose an existing absolute directory on the server. Browser-local folders are not uploaded.' : 'Pith can read files in this folder. Changes need your approval unless you allow them.'}
          </p>
          {error || modal.error ? <p className="text-[12px] text-destructive" role="alert">{error || modal.error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => closeModalId(modal.id)}>Cancel</Button>
            <Button type="submit" disabled={busy || !path.trim()}>Add workspace</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
