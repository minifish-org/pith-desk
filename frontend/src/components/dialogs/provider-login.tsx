import {useState} from 'react';
import {ExternalLink, LoaderCircle} from 'lucide-react';
import {closeModalId, desk, useDesk, type ModalOf} from '@/stores/desk.ts';
import {oauthAnswer, oauthCancel} from '@/actions/models.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import type {LoginStatus} from '@/contract.generated.ts';

export function ProviderLoginDialog({modal}: {modal: ModalOf<'provider-login'>}) {
  const login: LoginStatus | undefined = useDesk(store => store.state.login);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => {
    closeModalId(modal.id);
    if (login && !['complete', 'error'].includes(login.phase)) void oauthCancel();
  };
  return (
    <Dialog open onOpenChange={open => {if (!open) close();}}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with {login?.provider || modal.provider}</DialogTitle>
          <DialogDescription className="leading-relaxed">{login?.message || 'Waiting for the provider sign-in to start…'}</DialogDescription>
        </DialogHeader>
        {login?.phase === 'error' ? <p role="alert" className="text-[12px] text-destructive">{login.message}</p> : null}
        {login?.url ? (
          <Button variant="secondary" onClick={() => window.open(login.url, '_blank', 'noopener')}>
            <ExternalLink className="size-3.5" />Open sign-in page
          </Button>
        ) : null}
        {login?.code ? (
          <div className="rounded-md border bg-muted/40 p-2">
            <p className="text-[11px] text-muted-foreground">Authorization code</p>
            <code className="block font-mono text-[18px] tracking-wider select-all">{login.code}</code>
          </div>
        ) : null}
        {login?.prompt ? (
          <form
            className="space-y-2"
            onSubmit={async event => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {if (!await oauthAnswer(login.id, answer)) setError(desk().activity.error);}
              finally {setBusy(false);}
            }}
          >
            <label className="block text-[12px] font-medium" htmlFor="oauth-answer">{login.prompt}</label>
            {login.options?.length ? (
              <Select value={answer} onValueChange={setAnswer}>
                <SelectTrigger id="oauth-answer" aria-label={login.prompt}><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>{login.options.map(option => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            ) : (
              <Input id="oauth-answer" aria-label={login.prompt} type={login.promptType === 'secret' ? 'password' : 'text'} value={answer} onChange={event => setAnswer(event.target.value)} autoFocus />
            )}
            {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
            <Button type="submit" size="sm" disabled={busy || !answer}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Continue</Button>
          </form>
        ) : null}
        <DialogFooter className="mx-0 mb-0 border-t px-5 pt-3 pb-5">
          <Button variant="ghost" onClick={close}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
