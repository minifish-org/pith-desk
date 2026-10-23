import {useEffect, useMemo, useRef, useState} from 'react';
import {Check, ChevronDown, Download, LoaderCircle, RefreshCw, Search, ShieldCheck, Sparkles, TriangleAlert} from 'lucide-react';
import {cn} from '@/lib/utils';
import {closeModalId, desk, useDesk, type ModalOf} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime.ts';
import {applyAppearance} from '@/actions/core.ts';
import {
  createInstructions, exportDiagnostics, loadModels, openCustomConnection, openModels, openSettings,
  providerAction, removeProviderKey, saveAppearance, saveModelSelection, saveProviderConfig,
  testProviderConnection, updateAction, updateStatus,
} from '@/actions/settings.ts';
import {thinkingLabel} from '@/lib/format';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Badge} from '@/components/ui/badge';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Separator} from '@/components/ui/separator';
import {Switch} from '@/components/ui/switch';
import type {ModelCatalog, ProviderChoice, UpdateStatus} from '@/contract.generated.ts';

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
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{message: string; ok?: boolean}>({message: ''});
  const [error, setError] = useState('');
  const [appearance, setAppearance] = useState(settings.appearance || 'system');
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const providerGeneration = useRef(0);
  const probe = useRef<AbortController | null>(null);

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
        setProviderId(next.id);
        setBaseUrl(next.baseUrl);
      }
    }).catch(failure => {if (active) setError(failure instanceof Error ? failure.message : String(failure));});
    return () => {active = false;};
  }, [settings.provider]);

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
    if (provider?.signedIn) setApiKey('');
  }, [provider?.signedIn]);

  const choose = (id: string) => {
    const next = catalog?.providers?.find(entry => entry.id === id);
    if (!next) return;
    providerGeneration.current++;
    setProviderId(next.id);
    setBaseUrl(next.baseUrl);
    setApiKey('');
    setTest({message: ''});
    setError('');
  };

  const disabled = busy || running;
  // A pending save must not freeze the form: choosing another provider is how a
  // user abandons that draft. The generation guard keeps the earlier result out.
  const fieldsDisabled = running;

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Model connections, appearance, diagnostics{runtime.server ? '' : ' and updates'}.</DialogDescription>
        </DialogHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <section className="space-y-3">
            {runtime.server ? <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">Model requests run on the server. localhost in a Base URL refers to the server, not this browser’s device. Credentials stay in the server’s private data directory.</p> : null}
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold">Model connection</h3>
              {catalog ? <Badge variant="secondary" className="font-normal">{catalog.providers?.length || 0} providers</Badge> : null}
            </div>
            {!catalog && !error ? <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading providers…</p> : null}
            {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
            {catalog ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium" htmlFor="provider-select">Provider</label>
                  <Select value={provider?.id || ''} onValueChange={choose} disabled={fieldsDisabled}>
                    <SelectTrigger id="provider-select" aria-label="Provider" className="w-full"><SelectValue placeholder="Choose a provider" /></SelectTrigger>
                    <SelectContent>
                      {(catalog.providers || []).map(entry => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}{entry.hasApiKey ? ' · configured' : ''}{entry.signedIn ? ' · signed in' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {provider ? (
                    <p className="text-[11px] text-muted-foreground">
                      {provider.custom ? 'Independent endpoint with its own models and credentials.' : provider.oauth ? 'Supports provider sign-in.' : 'API key stored in Pith Desk’s private local data.'}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ''}
                    </p>
                  ) : null}
                </div>

                {provider?.oauth || provider?.custom ? (
                  <div className="flex flex-wrap gap-1.5">
                    {provider.oauth ? (
                      <Button
                        size="sm" variant={provider.signedIn ? 'secondary' : 'default'} disabled={disabled}
                        aria-label="Sign in with provider"
                        onClick={async () => {
                          const result = await providerAction(provider.signedIn ? 'logout' : 'login', provider);
                          if (!result.ok) setError(result.error || '');
                        }}
                      >
                        {provider.signedIn ? `Sign out of ${provider.name}` : `Sign in with ${provider.name}`}
                      </Button>
                    ) : null}
                    {provider.custom ? (
                      <>
                        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => {closeModalId(modal.id); openCustomConnection(provider.id);}}>Edit connection</Button>
                        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {void providerAction('remove-connection', provider);}}>Remove connection…</Button>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {!keyStatus.hidden ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-[12px] font-medium" htmlFor="provider-key">API key</label>
                      <span className={cn('text-[11px]', keyStatus.retained ? 'text-[var(--success)]' : 'text-muted-foreground')}>{keyStatus.status}</span>
                    </div>
                    <Input
                      id="provider-key" type="password" autoComplete="new-password"
                      aria-label="API key"
                      placeholder={keyStatus.retained ? 'Leave blank to keep this provider’s key' : provider?.custom ? 'Optional API key for this endpoint' : 'Paste this provider’s API key'}
                      value={apiKey} onChange={event => setApiKey(event.target.value)}
                      disabled={fieldsDisabled}
                    />
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {keyStatus.retained
                        ? 'A saved key stays on the host and is never returned to this page. Changing the endpoint requires entering the key again.'
                        : 'Testing sends one small model request. It does not save this form or access workspace files.'}
                    </p>
                  </div>
                ) : (
                  <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-[12px] text-muted-foreground">No API key is needed for this provider; sign in with your provider account above.</p>
                )}

                <details className="rounded-md border px-3 py-2" open={advanced} onToggle={event => setAdvanced((event.target as HTMLDetailsElement).open)}>
                  <summary className="cursor-pointer text-[12px] text-muted-foreground">Advanced connection settings</summary>
                  <div className="mt-2 space-y-1.5">
                    <label className="text-[12px] font-medium" htmlFor="provider-url">API base URL</label>
                    <Input id="provider-url" aria-label="API base URL" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={fieldsDisabled} />
                    <p className="text-[11px] text-muted-foreground">{runtime.server ? 'Model requests run on the server. localhost refers to the server, not this browser.' : 'Override the endpoint for proxies or compatible services that speak the selected provider’s protocol.'}</p>
                  </div>
                </details>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm" variant="secondary" disabled={disabled || !provider}
                    onClick={async () => {
                      if (testing) {
                        probe.current?.abort();
                        return;
                      }
                      const controller = new AbortController();
                      probe.current = controller;
                      setTesting(true);
                      setTest({message: 'Testing streaming and tool calling…'});
                      try {
                        const result = await testProviderConnection({provider: providerId, baseUrl, ...(apiKey ? {apiKey} : {})}, controller.signal);
                        if (probe.current === controller) setTest({message: result.message, ok: result.ok});
                      } catch (failure) {
                        if (probe.current === controller) setTest({message: controller.signal.aborted ? 'Test cancelled.' : failure instanceof Error ? failure.message : String(failure), ok: false});
                      } finally {
                        if (probe.current === controller) {
                          probe.current = null;
                          setTesting(false);
                        }
                      }
                    }}
                  >
                    {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{testing ? 'Cancel test' : 'Test connection'}
                  </Button>
                  {keyStatus.retained ? (
                    <Button
                      size="sm" variant="ghost" disabled={disabled}
                      onClick={async () => {if (await removeProviderKey({provider: providerId, baseUrl})) closeModalId(modal.id); else setError(desk().activity.error);}}
                    >
                      Remove saved key
                    </Button>
                  ) : null}
                  <Button
                    size="sm" className="ml-auto" disabled={disabled || saving || testing || !provider}
                    onClick={async () => {
                      setSaving(true);
                      setError('');
                      const generation = providerGeneration.current;
                      try {
                        const saved = await saveProviderConfig({provider: providerId, baseUrl, ...(apiKey ? {apiKey} : {})});
                        if (generation !== providerGeneration.current) return;
                        if (saved) {
                          setApiKey('');
                          closeModalId(modal.id);
                          if (!desk().state.settings.hasApiKey && desk().state.settings.hasConnections) openModels();
                        } else setError(desk().activity.error);
                      } finally {setSaving(false);}
                    }}
                  >
                    {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Save settings
                  </Button>
                </div>
                {test.message ? (
                  <p className={cn('text-[12px]', test.ok === false ? 'text-destructive' : test.ok ? 'text-[var(--success)]' : 'text-muted-foreground')} role="status">{test.message}</p>
                ) : null}
                <button type="button" className="text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => {closeModalId(modal.id); openCustomConnection();}}>
                  Add independent model connection
                </button>
              </>
            ) : null}
          </section>

          <Separator className="my-5" />

          <section className="space-y-2">
            <h3 className="text-[14px] font-semibold">Appearance</h3>
            <p className="text-[12px] text-muted-foreground">Applies immediately and follows the system when selected.</p>
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

          <Separator className="my-5" />

          <section className="space-y-2">
            <h3 className="text-[14px] font-semibold">Diagnostics</h3>
            <p className="text-[12px] leading-relaxed text-muted-foreground">Save a JSON report with version, platform, counts, usage and failure categories. It excludes prompts, transcript text, file contents, local paths, endpoints and credentials.</p>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => {void exportDiagnostics();}}>
              <Download className="size-3.5" />{runtime.server ? 'Download diagnostics' : 'Save diagnostics'}
            </Button>
          </section>

          {!runtime.server ? (
            <>
              <Separator className="my-5" />
              <section className="space-y-2">
                <h3 className="text-[14px] font-semibold">Updates</h3>
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
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="ghost" onClick={() => closeModalId(modal.id)}>Cancel</Button>
          <Button variant="secondary" onClick={() => closeModalId(modal.id)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ModelsDialog({modal}: {modal: ModalOf<'models'>}) {
  const settings = useDesk(store => store.state.settings);
  const login = useDesk(store => store.state.login);
  const running = useDesk(store => store.state.runs.length > 0);
  const busy = useDesk(store => store.activity.busy);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [provider, setProvider] = useState(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [thinking, setThinking] = useState(settings.thinkingLevel || 'off');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void loadModels().then(result => {
      if (!active) return;
      setCatalog(result);
      if (!(result.providers || []).some(entry => entry.hasApiKey)) {
        closeModalId(modal.id);
        openSettings();
      }
    }).catch(failure => {if (active) setError(failure instanceof Error ? failure.message : String(failure));});
    return () => {active = false;};
  }, []);

  const providers = (catalog?.providers || []).filter(entry => entry.hasApiKey);
  const models = (catalog?.models || []).filter(entry => entry.provider === provider && (!search.trim() || `${entry.name} ${entry.id}`.toLowerCase().includes(search.trim().toLowerCase())));
  const selectedModel = (catalog?.models || []).find(entry => entry.provider === provider && entry.id === model);
  const levels = selectedModel?.thinkingLevels?.length ? selectedModel.thinkingLevels : ['off'];
  const currentProvider = providers.find(entry => entry.id === provider) || providers[0];

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>Choose model</DialogTitle>
          <DialogDescription>Applies to the next task. Stop running tasks before changing the shared model.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {providers.map(entry => (
              <Button
                key={entry.id} size="sm" variant={entry.id === currentProvider?.id ? 'secondary' : 'ghost'}
                className="h-7 shrink-0 text-[12px]"
                onClick={() => {setProvider(entry.id); setModel('');}}
              >
                {entry.name}
              </Button>
            ))}
          </div>
          <div className="relative w-40 shrink-0">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search models" placeholder="Search models" value={search} onChange={event => setSearch(event.target.value)} className="h-7 pl-7 text-[12px]" />
          </div>
        </div>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto p-2">
          {!catalog ? <p className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading models…</p> : null}
          {catalog && !models.length ? <p className="p-3 text-[12px] text-muted-foreground">No models match this provider and search.</p> : null}
          {models.map(entry => (
            <button
              key={`${entry.provider}/${entry.id}`}
              type="button"
              className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-accent', entry.id === model && entry.provider === provider && 'bg-accent')}
              onClick={() => {setModel(entry.id); if (!entry.thinkingLevels?.includes(thinking)) setThinking(entry.thinkingLevels?.[0] || 'off');}}
            >
              <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{entry.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{entry.id} · {Math.round((entry.contextWindow || 0) / 1000)}k context{entry.supportsImages ? ' · images' : ''}</span>
              </span>
              {entry.id === model && entry.provider === provider ? <Check className="size-4 shrink-0" /> : null}
            </button>
          ))}
        </div>
        {error ? <p className="border-t px-4 py-2 text-[12px] text-destructive">{error}</p> : null}
        <DialogFooter className="items-center border-t px-4 py-2.5 sm:justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Thinking</span>
            <Select value={thinking} onValueChange={setThinking} disabled={levels.length < 2 || running || busy}>
              <SelectTrigger aria-label="Thinking effort" className="h-7 w-32 text-[12px]"><SelectValue /></SelectTrigger>
              <SelectContent>{levels.map(level => <SelectItem key={level} value={level}>{thinkingLabel(level)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button
            size="sm" disabled={!selectedModel || saving || running || busy}
            onClick={async () => {
              setSaving(true);
              try {
                if (await saveModelSelection({provider, model, thinkingLevel: thinking})) closeModalId(modal.id);
                else setError(desk().activity.error);
              } finally {setSaving(false);}
            }}
          >
            {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Use this model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
