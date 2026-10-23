import {useEffect, useRef, useState} from 'react';
import {Download, FolderOpen, LoaderCircle, ShieldAlert, X} from 'lucide-react';
import {desk, useDesk, closeModalId, type ModalOf} from '@/stores/desk.ts';
import {addWorkspace, closeNavigation, confirmFullAccess, pickWorkspace, selectWorkspace, submitRename} from '@/actions/conversations.ts';
import {editorValues, submitMessageEdit} from '@/actions/composer.ts';
import {submitEditor} from '@/actions/conversations.ts';
import {runtime} from '@/lib/runtime.ts';
import {saveBlob} from '@/lib/save.ts';
import {desk as store} from '@/stores/desk.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle} from '@/components/ui/empty';

export function ConfirmDialog({modal}: {modal: ModalOf<'confirm'>}) {
  const [busy, setBusy] = useState(false);
  const error = modal.error;
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
        {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
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

export function WorkspaceDialog({modal}: {modal: ModalOf<'workspace'>}) {
  const workspaces = useDesk(current => current.state.workspaces);
  const busy = useDesk(current => current.activity.busy);
  const [path, setPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(modal.error || '');
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
                onClick={() => {closeModalId(modal.id); closeNavigation(); void selectWorkspace(workspace.id);}}
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

export function EditorDialog({modal}: {modal: ModalOf<'editor'>}) {
  const [value, setValue] = useState(modal.value);
  const [busy, setBusy] = useState(false);
  const state = useDesk(store => store.state);
  const ref = useRef<HTMLTextAreaElement>(null);
  const invalid = modal.conversationId !== undefined && modal.conversationId !== state.activeId
    ? true
    : modal.slot === 'message'
      ? !!modal.expectedLastMessageId && state.messages.at(-1)?.id !== modal.expectedLastMessageId
      : !state.queuedMessages.some(entry => entry.id === modal.targetId);
  useEffect(() => {editorValues.set(modal.id, value);}, [modal.id, value]);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(value.length, value.length);
  }, []);
  useEffect(() => {
    return () => {editorValues.delete(modal.id);};
  }, [modal.id]);
  return (
    <Dialog open onOpenChange={open => {if (!open && !busy) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-xl" data-text-edit="">
        <DialogHeader><DialogTitle>{modal.title}</DialogTitle></DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async event => {
            event.preventDefault();
            setBusy(true);
            try {
              if (modal.slot === 'queue') await submitEditor(modal.id, value, modal.targetId);
              else await submitMessageEdit(modal.id, modal.targetId, value);
            } finally {setBusy(false);}
          }}
        >
          <Textarea
            ref={ref} aria-label={modal.title} value={value} rows={7} className="min-h-40 resize-y font-normal"
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {modal.note ? <p className="text-[11px] leading-relaxed text-muted-foreground">{modal.note}</p> : null}
          {modal.error ? <p className="text-[12px] text-destructive" role="alert">{modal.error}</p> : null}
          {invalid && !modal.error ? <p className="text-[12px] text-destructive" role="alert">The conversation changed. Reopen the message to send this edit. Your text is kept here so you can copy it.</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => closeModalId(modal.id)}>Cancel</Button>
            <Button type="submit" disabled={busy || invalid || (!value.trim() && !modal.note?.includes('image'))}>{modal.submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ImageDialog({modal}: {modal: ModalOf<'image'>}) {
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-[min(92vw,1100px)] p-2" aria-describedby={undefined} onCloseAutoFocus={event => event.preventDefault()}>
        <DialogHeader className="sr-only"><DialogTitle>{modal.alt}</DialogTitle></DialogHeader>
        <div className="grid max-h-[80dvh] place-items-center overflow-auto rounded-md bg-muted/40">
          <img src={modal.src} alt={modal.alt} className="max-h-[78dvh] max-w-full object-contain" />
        </div>
        <DialogFooter className="sm:justify-end">
          <Button variant="ghost" size="sm" onClick={() => closeModalId(modal.id)}><X className="size-3.5" />Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ServerDialog({modal}: {modal: ModalOf<'server'>}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(modal.error || '');
  const login = modal.phase === 'login';
  const session = runtime.session;
  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined} onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{login ? 'Pith Desk Server' : 'Reconnect to Pith Desk'}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {login ? 'Sign in with the token configured on your Pith Desk server.' : 'Continue here to take control. Other pages will disconnect. Tasks and terminals keep running.'}
          </DialogDescription>
        </DialogHeader>
        {modal.recoveryText ? (
          <div className="space-y-2 rounded-md border bg-muted/40 p-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">Unsent text is kept on this page. Copy it below, or continue here to download it. It will not be submitted automatically.</p>
            <Textarea readOnly value={modal.recoveryText} aria-label="Unsent text on this page" className="h-24 text-[11px]" />
            <Button size="sm" variant="secondary" onClick={() => {void saveBlob(new Blob([modal.recoveryText || ''], {type: 'text/plain;charset=utf-8'}), 'pith-desk-unsent-text.txt');}}>
              <Download className="size-3.5" />Download text
            </Button>
          </div>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={async event => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              if (login) await session?.login(token);
              else await session?.continueHere();
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : String(failure));
            } finally {setBusy(false);}
          }}
        >
          {login ? (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium" htmlFor="server-token">Server token</label>
              <Input id="server-token" type="password" aria-label="Server token" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} autoFocus />
            </div>
          ) : null}
          {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={busy || (login && !token.trim())}>
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}{login ? 'Sign in' : 'Continue here'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RecoveredDialog({modal}: {modal: ModalOf<'recovered'>}) {
  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Recovered unsent text</DialogTitle>
          <DialogDescription className="leading-relaxed">
            This page kept text that could not be confirmed as saved. Copy or download it before discarding. Check the current conversation and queue before submitting again; nothing is sent automatically.
          </DialogDescription>
        </DialogHeader>
        <Textarea readOnly value={modal.text} aria-label="Recovered unsent text" className="h-48 font-mono text-[12px]" />
        <DialogFooter>
          <Button variant="secondary" onClick={() => {void saveBlob(new Blob([modal.text], {type: 'text/plain;charset=utf-8'}), 'pith-desk-unsent-text.txt');}}>
            <Download className="size-3.5" />Download text
          </Button>
          <Button variant="secondary" onClick={() => {store().closeModal(modal.id);}}>Discard copy</Button>
          <Button onClick={() => closeModalId(modal.id)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
