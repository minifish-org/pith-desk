import {useState} from 'react';
import {Download, LoaderCircle} from 'lucide-react';
import type {ModalOf} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime.ts';
import {saveBlob} from '@/lib/save.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';

/** Server sign-in or exclusive-lease takeover. Neither can be dismissed while
 * the page has no authenticated session. */
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
