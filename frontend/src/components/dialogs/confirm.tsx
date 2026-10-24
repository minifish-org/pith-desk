import {useState} from 'react';
import {LoaderCircle, ShieldAlert} from 'lucide-react';
import {closeModalId, type ModalOf} from '@/stores/desk.ts';
import {confirmFullAccess, submitRename} from '@/actions/conversations.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';

export function ConfirmDialog({modal}: {modal: ModalOf<'confirm'>}) {
  const [busy, setBusy] = useState(false);
  const description = modal.description;
  return (
    <Dialog open onOpenChange={open => {if (!open && !busy) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{modal.title}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {description.before}
            {description.subject ? <strong className="font-medium text-foreground">{description.subject}</strong> : null}
            {description.after}
          </DialogDescription>
        </DialogHeader>
        {modal.hint ? <p className="text-[12px] leading-relaxed text-muted-foreground">{modal.hint}</p> : null}
        {modal.error ? <p className="text-[12px] text-destructive" role="alert">{modal.error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => closeModalId(modal.id)}>Cancel</Button>
          <Button
            variant="destructive" disabled={busy || modal.disabled}
            onClick={async () => {
              setBusy(true);
              try {if (await modal.run()) closeModalId(modal.id);}
              finally {setBusy(false);}
            }}
          >
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}{modal.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameDialog({modal}: {modal: ModalOf<'rename'>}) {
  const [value, setValue] = useState(modal.title);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={open => {if (!open && !busy) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Rename conversation</DialogTitle></DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async event => {
            event.preventDefault();
            setBusy(true);
            try {await submitRename(modal.id, modal.conversationId, value.trim());}
            finally {setBusy(false);}
          }}
        >
          <Input autoFocus aria-label="Conversation title" value={value} onChange={event => setValue(event.target.value)} />
          {modal.error ? <p className="text-[12px] text-destructive" role="alert">{modal.error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => closeModalId(modal.id)}>Cancel</Button>
            <Button type="submit" disabled={busy || !value.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FullAccessDialog({modal}: {modal: ModalOf<'full-access'>}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={open => {if (!open && !busy) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldAlert className="size-4 text-[var(--warning)]" />Enable full access?</DialogTitle>
          <DialogDescription className="leading-relaxed">
            Every enabled tool for <strong className="font-medium text-foreground">{modal.title}</strong> will run without asking, including commands and external connection tools. There is no operating-system sandbox. Only use this in a conversation and folder you trust.
          </DialogDescription>
        </DialogHeader>
        {modal.error ? <p className="text-[12px] text-destructive" role="alert">{modal.error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => closeModalId(modal.id)}>Cancel</Button>
          <Button
            variant="destructive" disabled={busy || modal.disabled}
            onClick={async () => {
              setBusy(true);
              try {await confirmFullAccess(modal.id, modal.conversationId);}
              finally {setBusy(false);}
            }}
          >
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Enable full access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
