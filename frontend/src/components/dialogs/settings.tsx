import {useEffect, useMemo, useState} from 'react';
import {Download, LoaderCircle, RefreshCw} from 'lucide-react';
import {cn} from '@/lib/utils';
import {closeModalId, useDesk, type ModalOf} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime.ts';
import {onAppEvent} from '@/lib/events.ts';
import {applyAppearance} from '@/actions/core.ts';
import {exportDiagnostics, saveAppearance, updateAction, updateStatus} from '@/actions/settings.ts';
import {
  createProviderEditor, emptyProviderEditor, loadModels, openCustomConnection, providerAction,
} from '@/actions/models.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import type {ModelCatalog, UpdateStatus} from '@/contract.generated.ts';

export function SettingsDialog({modal}: {modal: ModalOf<'settings'>}) {
  const settings = useDesk(store => store.state.settings);
  const login = useDesk(store => store.state.login);
  const busy = useDesk(store => store.activity.busy);
  const running = useDesk(store => store.state.runs.length > 0);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [providerId, setProviderId] = useState(settings.provider);
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [edit, setEdit] = useState(emptyProviderEditor);
  const [editor] = useState(() => createProviderEditor(setEdit, () => setApiKey('')));
  const [appearance, setAppearance] = useState(settings.appearance || 'system');
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const {error, saved, test} = edit;
  const saving = edit.pending === 'save';
  const testing = edit.pending === 'test';
  const providerDraft = {provider: providerId, baseUrl, ...(apiKey ? {apiKey} : {})};

  const provider = catalog?.providers?.find(entry => entry.id === providerId) || catalog?.providers?.[0];
  const keyStatus = useMemo(() => {
    if (!provider) return {status: 'Not configured', hidden: false, retained: false};
    const signedIn = !!provider.signedIn;
    const retained = !!provider.hasSavedKey && provider.baseUrl === baseUrl.replace(/\/+$/, '');
    const useSignIn = (provider.oauth && !provider.apiKeySupported) || signedIn;
    return {status: signedIn ? 'Signed in' : retained ? 'Configured' : 'Not configured', hidden: useSignIn, retained, signedIn};
  }, [provider, baseUrl]);

  useEffect(() => {
    let active = true;
    void loadModels().then(result => {
      if (!active) return;
      setCatalog(result);
      const next = (result.providers || []).find(entry => entry.id === settings.provider) || (result.providers || [])[0];
      if (next) {
        editor.reset();
        setProviderId(next.id);
        setBaseUrl(next.baseUrl);
        setApiKey('');
      }
    }).catch(failure => {if (active) setEdit(current => ({...current, error: failure instanceof Error ? failure.message : String(failure)}));});
    return () => {active = false;};
  }, [settings.provider, editor]);

  useEffect(() => {
    let active = true;
    const off = onAppEvent('modelConnectionsChanged', () => {void loadModels().then(result => {if (active) setCatalog(result);}).catch(() => {});});
    return () => {active = false; off();};
  }, []);

  useEffect(() => () => editor.dispose(), [editor]);

  useEffect(() => {
    if (runtime.server) return;
    void updateStatus().then(setUpdate).catch(() => {});
    const timer = setInterval(() => {void updateStatus().then(setUpdate).catch(() => {});}, 500);
    return () => clearInterval(timer);
  }, []);

  // Provider account changes arrive through the snapshot, not the form. Refresh
  // the catalog when an OAuth flow finishes so key controls follow sign-in.
  useEffect(() => {
    if (!login || login.phase !== 'complete') return;
    let active = true;
    void loadModels().then(result => {if (active) setCatalog(result);}).catch(() => {});
    return () => {active = false;};
  }, [login?.id, login?.phase]);

  useEffect(() => {
    // A signed-in provider never forwards a stale API-key draft.
    if (provider?.signedIn) {editor.reset(); setApiKey('');}
  }, [provider?.signedIn, editor]);

  const choose = (id: string) => {
    const next = catalog?.providers?.find(entry => entry.id === id);
    if (!next) return;
    editor.reset();
    setProviderId(next.id);
    setBaseUrl(next.baseUrl);
    setApiKey('');
  };

  const disabled = busy || running;
  // Edits abandon earlier results; a pending save must not freeze the form.
  const fieldsDisabled = running;

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[86dvh] w-full sm:max-w-[500px] flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Model connections, appearance, diagnostics{runtime.server ? '' : ' and updates'}.</DialogDescription>
        </DialogHeader>
        <div className="settings-body scrollbar-quiet flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5">
          <section className="space-y-2">
            <h3 className="text-[16px] font-semibold">Appearance</h3>
            <p className="text-[13px] leading-5 text-muted-foreground">Applies immediately and follows the system when selected.</p>
            <Select
              value={appearance}
              onValueChange={async value => {
                const mode = value as 'system' | 'light' | 'dark';
                setAppearance(mode);
                applyAppearance(mode);
                await saveAppearance(mode);
              }}
              disabled={busy}
            >
              <SelectTrigger aria-label="Appearance" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="system">Follow system</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </section>

          {!runtime.server ? (
            <>
              <section className="mt-5 space-y-2 border-t pt-5">
                <h3 className="text-[16px] font-semibold">Updates</h3>
                {update ? (
                  <div className="space-y-1.5">
                    <p className="text-[12px] text-muted-foreground">
                      Pith Desk {update.version || 'unknown'}{update.availableVersion ? ` · ${update.availableVersion} available` : ''}
                    </p>
                    {update.message ? <p className="text-[12px]">{update.message}</p> : null}
                    {update.phase === 'installing' ? <progress aria-label="Update progress" value={update.progress} max={100} className="h-1.5 w-full overflow-hidden rounded-full" /> : null}
                    {update.enabled ? (
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="secondary" disabled={['checking', 'installing', 'restarting'].includes(update.phase)} onClick={() => {void updateAction('check').then(() => updateStatus().then(setUpdate));}}>Check for updates</Button>
                        {update.availableVersion ? <Button size="sm" disabled={['checking', 'installing', 'restarting'].includes(update.phase)} onClick={() => {void updateAction('install').then(() => updateStatus().then(setUpdate)).catch(() => updateStatus().then(setUpdate));}}>Update and restart</Button> : null}
                      </div>
                    ) : <p className="text-[11px] text-muted-foreground">Automatic updates are unavailable for this build.</p>}
                  </div>
                ) : <p className="text-[12px] text-muted-foreground">Checking…</p>}
              </section>
            </>
          ) : null}

          <section className="mt-5 space-y-3 border-t pt-5">
            {runtime.server ? <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">Model requests run on the server. localhost in a Base URL refers to the server, not this browser’s device. Credentials stay in the server’s private data directory.</p> : null}
            <h3 className="text-[16px] font-semibold">Model providers</h3>
            <p className="text-[13px] leading-5 text-muted-foreground">Connect your model providers here. Choose models and thinking effort beside the message box.</p>
            <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => {openCustomConnection();}}>Add independent model connection</Button></div>
            {!catalog && !error ? <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading providers…</p> : null}
            {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
            {catalog ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-[13px] font-medium" htmlFor="provider-select">Provider</label>
                  <Select value={provider?.id || ''} onValueChange={choose} disabled={fieldsDisabled}>
                    <SelectTrigger id="provider-select" aria-label="Provider" className="w-full"><SelectValue placeholder="Choose a provider" /></SelectTrigger>
                    <SelectContent className="!max-h-80" collisionPadding={12}>
                      {(catalog.providers || []).map(entry => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}{entry.hasApiKey ? ' · configured' : ''}{entry.signedIn ? ' · signed in' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {provider?.baseUrl ? <p className="text-[12px] text-muted-foreground">{provider.baseUrl}</p> : null}
                </div>

                {provider?.oauth || provider?.custom ? (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {provider.oauth ? (
                      <Button
                        size="sm" variant={provider.signedIn ? 'secondary' : 'default'} disabled={disabled}
                        aria-label="Sign in with provider"
                        onClick={async () => {
                          const result = await providerAction(provider.signedIn ? 'logout' : 'login', provider);
                          if (!result.ok) setEdit(current => ({...current, error: result.error || ''}));
                        }}
                      >
                        {provider.signedIn ? `Sign out of ${provider.name}` : `Sign in with ${provider.name}`}
                      </Button>
                    ) : null}
                    {provider.custom ? (
                      <>
                        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => {openCustomConnection(provider.id);}}>Edit connection</Button>
                        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {void providerAction('remove-connection', provider);}}>Remove connection…</Button>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {!keyStatus.hidden ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[13px] font-medium" htmlFor="provider-key">API key</label>
                      <span className={cn('text-[11px]', keyStatus.retained ? 'text-[var(--success)]' : 'text-muted-foreground')}>{keyStatus.status}</span>
                    </div>
                    <div className="relative">
                      <Input
                        id="provider-key" type="password" autoComplete="new-password"
                        aria-label="API key"
                        className={keyStatus.retained ? 'pr-20' : undefined}
                        placeholder={keyStatus.retained ? 'Leave blank to keep this provider’s key' : provider?.custom ? 'Optional API key for this endpoint' : 'Paste this provider’s API key'}
                        value={apiKey} onChange={event => {editor.reset(); setApiKey(event.target.value);}}
                        disabled={fieldsDisabled}
                      />
                      {keyStatus.retained ? (
                        <Button
                          type="button" size="xs" variant="ghost"
                          className="absolute top-1/2 right-1 h-8 -translate-y-1/2 px-2 text-destructive hover:text-destructive"
                          aria-label="Remove saved key"
                          disabled={disabled || testing || saving}
                          onClick={() => {void editor.run('remove', providerDraft);}}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {keyStatus.retained ? 'Saved key stays on this host; leave blank to keep it.' : 'Stored in Pith Desk’s private data.'}
                    </p>
                  </div>
                ) : (
                  <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-[12px] text-muted-foreground">No API key is needed for this provider; sign in with your provider account above.</p>
                )}

                <details className="rounded-md border px-3 py-2" open={advanced} onToggle={event => setAdvanced((event.target as HTMLDetailsElement).open)}>
                  <summary className="cursor-pointer text-[12px] text-muted-foreground">Advanced connection settings</summary>
                  <div className="mt-2 space-y-1.5">
                    <label className="text-[12px] font-medium" htmlFor="provider-url">API base URL</label>
                    <Input id="provider-url" aria-label="API base URL" value={baseUrl} onChange={event => {editor.reset(); setBaseUrl(event.target.value);}} disabled={fieldsDisabled} />
                    <p className="text-[11px] text-muted-foreground">{runtime.server ? 'Model requests run on the server. localhost refers to the server, not this browser.' : 'Override the endpoint for proxies or compatible services that speak the selected provider’s protocol.'}</p>
                  </div>
                </details>

                <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5 border-t pt-4">
                  <Button
                    size="sm" variant="secondary" disabled={disabled || !provider}
                    title="Check streaming and tool calling without saving"
                    onClick={() => {void editor.run('test', providerDraft);}}
                  >
                    {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{testing ? 'Cancel test' : 'Test connection'}
                  </Button>
                  <Button
                    size="sm" className={undefined} disabled={disabled || saving || testing || !provider}
                    onClick={() => {void editor.run('save', providerDraft);}}
                  >
                    {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Save settings
                  </Button>
                </div>
                {saved ? <p role="status" className="text-right text-[12px] text-[var(--success)]">{saved}</p> : null}
                {test.message ? <p className={cn('text-[12px]', test.ok === false ? 'text-destructive' : test.ok ? 'text-[var(--success)]' : 'text-muted-foreground')} role="status">{test.message}</p> : null}
              </>
            ) : null}
          </section>

          <section className="mt-5 space-y-2 border-t pt-5">
            <h3 className="text-[16px] font-semibold">Diagnostics</h3>
            <p className="text-[13px] leading-5 text-muted-foreground">Version, usage and failure category only; no conversation, file contents, paths or credentials.</p>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => {void exportDiagnostics();}}>
              <Download className="size-3.5" />{runtime.server ? 'Download diagnostics' : 'Save diagnostics'}
            </Button>
          </section>
                </div>
      </DialogContent>
    </Dialog>
  );
}
