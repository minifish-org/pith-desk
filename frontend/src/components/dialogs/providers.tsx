import {useEffect, useState} from 'react';
import {ExternalLink, LoaderCircle, Plug, Trash2, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {closeModalId, desk, useDesk, type ModalOf} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime';
import {
  confirmRemoveMCP, loadCustomConnection, loadMCP, mcpAuth, oauthAnswer, oauthCancel,
  saveCustomConnection, saveMCP,
} from '@/actions/settings.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Switch} from '@/components/ui/switch';
import {Textarea} from '@/components/ui/textarea';
import {Badge} from '@/components/ui/badge';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {MoreHorizontal} from 'lucide-react';
import type {LoginStatus, MCPServerView} from '@/contract.generated.ts';

const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'];

function mcpStatus(entry: MCPServerView): string {
  if (!entry.enabled) return 'Will not be used by tasks';
  if (entry.status === 'connected') return `Connected · ${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}`;
  if (entry.status === 'connecting') return 'Connecting…';
  if (entry.status === 'error') return 'Connection failed';
  return 'Connects automatically when a task starts';
}

export function ConnectionsDialog({modal}: {modal: ModalOf<'connections'>}) {
  const busy = useDesk(store => store.activity.busy);
  const running = useDesk(store => store.state.runs.length > 0);
  const [entries, setEntries] = useState<MCPServerView[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<MCPServerView | 'new' | null>(null);

  const refresh = () => {
    setError('');
    void loadMCP().then(setEntries).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)));
  };
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener('pith:mcp-refresh', onChange);
    return () => window.removeEventListener('pith:mcp-refresh', onChange);
  }, []);

  const disabled = busy || running;

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[86dvh] w-full max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            MCP tools available to tasks in every workspace. Credentials stay on this host.
            {runtime.server ? ' Connections run on the server; localhost, environment variables and runtime dependencies all refer to that server.' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={refresh} disabled={busy}>Refresh</Button>
            <Button size="sm" onClick={() => setEditing('new')} disabled={disabled}>New connection</Button>
          </div>
          {error ? <p className="mb-2 text-[12px] text-destructive" role="alert">{error}</p> : null}
          {!entries ? <p className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading connections…</p> : null}
          {entries && !entries.length ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <Plug className="mx-auto mb-2 size-5 text-muted-foreground" />
              <p className="text-[13px]">No connections yet</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Add an HTTP or local stdio MCP server to give tasks extra tools.</p>
            </div>
          ) : null}
          {entries?.map(entry => (
            <div key={entry.name} className="mb-2 rounded-lg border px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <strong className="truncate text-[13px] font-medium">{entry.name}</strong>
                    <Badge variant="secondary" className="font-normal">{entry.type}</Badge>
                    {entry.hasBearerToken ? <Badge variant="outline" className="font-normal">token</Badge> : null}
                  </div>
                  <p className={cn('mt-0.5 text-[11px]', entry.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{mcpStatus(entry)}</p>
                  <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{entry.url || entry.command}</p>
                </div>
                <Switch
                  aria-label={`Enable ${entry.name}`}
                  checked={entry.enabled}
                  disabled={disabled}
                  onCheckedChange={async enabled => {
                    await saveMCP({...entry, args: entry.args || [], enabled, oauth: entry.oauth});
                    refresh();
                  }}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`${entry.name} options`}><MoreHorizontal className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem disabled={disabled} onSelect={() => setEditing({...entry, args: entry.args || []})}>Edit…</DropdownMenuItem>
                    {entry.oauth && !runtime.server ? (
                      entry.signedIn
                        ? <DropdownMenuItem disabled={disabled} onSelect={async () => {await mcpAuth('mcp-logout', entry.name); refresh();}}>Sign out</DropdownMenuItem>
                        : <DropdownMenuItem disabled={disabled || running} onSelect={() => {void mcpAuth('mcp-login', entry.name);}}>Sign in…</DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={() => confirmRemoveMCP(entry.name)}>Delete…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
          {editing ? <ConnectionEditor key={editing === 'new' ? 'new' : editing.name} entry={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={() => {setEditing(null); refresh();}} /> : null}
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="secondary" onClick={() => closeModalId(modal.id)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionEditor({entry, onCancel, onSaved}: {entry?: MCPServerView; onCancel: () => void; onSaved: () => void}) {
  const [name, setName] = useState(entry?.name || '');
  const [type, setType] = useState(entry?.type || 'http');
  const [url, setUrl] = useState(entry?.url || '');
  const [command, setCommand] = useState(entry?.command || '');
  const [args, setArgs] = useState(JSON.stringify(entry?.args || [], null, 2));
  const [env, setEnv] = useState('');
  const [oauth, setOauth] = useState(entry?.oauth || false);
  const [oauthClientId, setOauthClientId] = useState(entry?.oauthClientId || '');
  const [oauthScope, setOauthScope] = useState(entry?.oauthScope || '');
  const [bearerToken, setBearerToken] = useState('');
  const [clearBearerToken, setClearBearerToken] = useState(false);
  const [enabled, setEnabled] = useState(entry?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const parsedArgs: unknown = type === 'stdio' ? JSON.parse(args || '[]') : [];
      if (!Array.isArray(parsedArgs) || !parsedArgs.every(value => typeof value === 'string')) throw new Error('Arguments must be a JSON array of strings.');
      let parsedEnv: Record<string, string> | undefined;
      if (type === 'stdio' && env.trim()) {
        const value: unknown = JSON.parse(env);
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every(item => typeof item === 'string')) throw new Error('Environment overrides must be a JSON object with string values.');
        parsedEnv = value as Record<string, string>;
      }
      const ok = await saveMCP({
        name, type, args: parsedArgs, oauth: type === 'http' ? oauth : false, enabled,
        ...(type === 'http' ? {
          url,
          ...(oauthClientId ? {oauthClientId} : {}),
          ...(oauthScope ? {oauthScope} : {}),
          ...(bearerToken ? {bearerToken} : {}),
          ...(clearBearerToken ? {clearBearerToken: true} : {}),
        } : {command, ...(parsedEnv ? {env: parsedEnv} : {})}),
      });
      if (ok) onSaved();
      else {
        // The token is a one-shot secret: a rejected write must not keep it in the form.
        setBearerToken('');
        setClearBearerToken(false);
        setError(desk().activity.error);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {setBusy(false);}
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-2.5 border-t pt-4">
      <h3 className="text-[13px] font-semibold">{entry ? 'Edit connection' : 'New connection'}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-[12px]"><span className="font-medium">Name</span><Input aria-label="Connection name" value={name} onChange={event => setName(event.target.value)} required /></label>
        <label className="space-y-1 text-[12px]"><span className="font-medium">Type</span>
          <Select value={type} onValueChange={value => setType(value)}>
            <SelectTrigger aria-label="Connection type"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="http">HTTP</SelectItem><SelectItem value="stdio">Local command (stdio)</SelectItem></SelectContent>
          </Select>
        </label>
      </div>
      {type === 'http' ? (
        <>
          <label className="block space-y-1 text-[12px]"><span className="font-medium">URL</span><Input aria-label="Connection URL" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" required /></label>
          <label className="block space-y-1 text-[12px]"><span className="font-medium">Bearer token</span><Input aria-label="Bearer token" type="password" value={bearerToken} onChange={event => setBearerToken(event.target.value)} placeholder={entry?.hasBearerToken ? 'Leave blank to keep the saved token' : 'Optional'} /></label>
          {entry?.hasBearerToken ? <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={clearBearerToken} onChange={event => setClearBearerToken(event.target.checked)} />Remove the saved bearer token</label> : null}
          {!runtime.server ? <label className="flex items-center gap-2 text-[12px]"><Switch checked={oauth} onCheckedChange={setOauth} />Use OAuth</label> : null}
          {oauth ? <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-[12px]"><span className="font-medium">OAuth client ID</span><Input aria-label="OAuth client ID" value={oauthClientId} onChange={event => setOauthClientId(event.target.value)} /></label>
            <label className="space-y-1 text-[12px]"><span className="font-medium">OAuth scope</span><Input aria-label="OAuth scope" value={oauthScope} onChange={event => setOauthScope(event.target.value)} /></label>
          </div> : null}
        </>
      ) : (
        <>
          <label className="block space-y-1 text-[12px]"><span className="font-medium">Command</span><Input aria-label="Command" value={command} onChange={event => setCommand(event.target.value)} placeholder="npx" required /></label>
          <label className="block space-y-1 text-[12px]"><span className="font-medium">Arguments (JSON array)</span><Textarea aria-label="Arguments" value={args} onChange={event => setArgs(event.target.value)} className="h-20 font-mono text-[11px]" /></label>
          <label className="block space-y-1 text-[12px]"><span className="font-medium">Environment overrides (JSON object)</span><Textarea aria-label="Environment overrides" value={env} onChange={event => setEnv(event.target.value)} placeholder={entry?.envKeys?.length ? `Saved keys: ${entry.envKeys.join(', ')}` : '{}'} className="h-16 font-mono text-[11px]" /></label>
        </>
      )}
      <label className="flex items-center gap-2 text-[12px]"><Switch checked={enabled} onCheckedChange={setEnabled} />Enabled</label>
      {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="submit" size="sm" disabled={busy}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Save connection</Button>
      </div>
    </form>
  );
}

interface ModelDraft {
  sourceIndex: number;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  images: boolean;
  reasoning: boolean;
  prices: {input: string; output: string; cacheRead: string; cacheWrite: string};
}

export function CustomConnectionDialog({modal}: {modal: ModalOf<'custom-connection'>}) {
  const editing = !!modal.connectionId;
  const [loading, setLoading] = useState(editing);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState(protocols[0]);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelDraft[]>([{
    sourceIndex: 0, id: '', name: '', contextWindow: 128000, maxTokens: 8192, images: false, reasoning: false,
    prices: {input: '', output: '', cacheRead: '', cacheWrite: ''},
  }]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!modal.connectionId) return;
    let active = true;
    void loadCustomConnection(modal.connectionId).then(connection => {
      if (!active) return;
      setName(connection.name);
      setBaseUrl(connection.baseUrl);
      setApi(connection.api);
      setModels((connection.models || []).map((model, index) => ({
        sourceIndex: index,
        id: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 8192,
        images: (model.input || []).includes('image'),
        reasoning: !!model.reasoning,
        prices: {
          input: model.cost ? String(model.cost.input) : '',
          output: model.cost ? String(model.cost.output) : '',
          cacheRead: model.cost ? String(model.cost.cacheRead) : '',
          cacheWrite: model.cost ? String(model.cost.cacheWrite) : '',
        },
      })));
    }).catch(failure => {if (active) setError(failure instanceof Error ? failure.message : String(failure));}).finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [modal.connectionId]);

  const updateModel = (index: number, patch: Partial<ModelDraft>) => setModels(previous => previous.map((entry, position) => position === index ? {...entry, ...patch} : entry));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      for (const model of models) {
        const rates = Object.values(model.prices);
        if (rates.some(Boolean) && rates.some(value => value === '')) throw new Error('Enter all four rates, using 0 for a free or unused category, or leave all four blank for unknown prices.');
      }
      const ok = await saveCustomConnection({
        id: modal.connectionId || '', name, baseUrl, api, ...(apiKey ? {apiKey} : {}),
        models: models.map(model => {
          const definition: Record<string, unknown> = {
            id: model.id, name: model.name || model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
            reasoning: model.reasoning, input: model.images ? ['text', 'image'] : ['text'],
          };
          if (Object.values(model.prices).some(value => value !== '')) {
            definition.cost = {
              input: Number(model.prices.input || 0), output: Number(model.prices.output || 0),
              cacheRead: Number(model.prices.cacheRead || 0), cacheWrite: Number(model.prices.cacheWrite || 0),
            };
          }
          return definition;
        }),
      });
      if (ok) {
        closeModalId(modal.id);
        if (desk().state.settings.hasConnections) desk().openModal({kind: 'settings', id: 'settings'});
      } else setError(desk().activity.error);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {setBusy(false);}
  };

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{editing ? 'Edit model connection' : 'Add independent model connection'}</DialogTitle>
          <DialogDescription>An endpoint with its own name, protocol, models and credentials. It can coexist with other providers.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="scrollbar-quiet min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
            {loading ? <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Loading connection…</p> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-[12px]"><span className="font-medium">Connection name</span><Input aria-label="Connection name" value={name} onChange={event => setName(event.target.value)} required /></label>
              <label className="space-y-1 text-[12px]"><span className="font-medium">API protocol</span>
                <Select value={api} onValueChange={setApi}>
                  <SelectTrigger aria-label="API protocol"><SelectValue /></SelectTrigger>
                  <SelectContent>{protocols.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
                </Select>
              </label>
            </div>
            <label className="block space-y-1 text-[12px]"><span className="font-medium">API base URL</span><Input aria-label="API base URL" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" required /></label>
            <label className="block space-y-1 text-[12px]"><span className="font-medium">API key</span><Input aria-label="API key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={editing ? 'Leave blank to keep the key at the same endpoint' : 'API key (optional for local endpoints)'} /></label>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold">Models</h3>
                <Button type="button" size="sm" variant="secondary" onClick={() => setModels(previous => [...previous, {sourceIndex: previous.length, id: '', name: '', contextWindow: 128000, maxTokens: 8192, images: false, reasoning: false, prices: {input: '', output: '', cacheRead: '', cacheWrite: ''}}])}>Add model</Button>
              </div>
              {models.map((model, index) => (
                <div key={index} className="space-y-2 rounded-lg border p-2.5">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Model ID</span><Input aria-label={`Model ${index + 1} ID`} value={model.id} onChange={event => updateModel(index, {id: event.target.value})} required /></label>
                    <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Display name</span><Input aria-label={`Model ${index + 1} name`} value={model.name} onChange={event => updateModel(index, {name: event.target.value})} /></label>
                    <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Context window</span><Input aria-label={`Model ${index + 1} context window`} type="number" value={model.contextWindow} onChange={event => updateModel(index, {contextWindow: Number(event.target.value)})} /></label>
                    <label className="space-y-1 text-[11px]"><span className="text-muted-foreground">Max output tokens</span><Input aria-label={`Model ${index + 1} max tokens`} type="number" value={model.maxTokens} onChange={event => updateModel(index, {maxTokens: Number(event.target.value)})} /></label>
                  </div>
                  <div className="flex flex-wrap gap-3 text-[11px]">
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={model.images} onChange={event => updateModel(index, {images: event.target.checked})} />Supports images</label>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={model.reasoning} onChange={event => updateModel(index, {reasoning: event.target.checked})} />Reasoning</label>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(key => (
                      <label key={key} className="space-y-1 text-[11px]"><span className="text-muted-foreground">{key} USD / 1M</span><Input aria-label={`Model ${index + 1} ${key} price`} value={model.prices[key]} onChange={event => updateModel(index, {prices: {...model.prices, [key]: event.target.value}})} placeholder="unknown" /></label>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Button type="button" size="xs" variant="ghost" disabled={models.length === 1} onClick={() => setModels(previous => previous.filter((_, position) => position !== index))}><Trash2 className="size-3" />Remove model</Button>
                  </div>
                </div>
              ))}
            </div>
            {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button type="button" variant="ghost" onClick={() => closeModalId(modal.id)}>Cancel</Button>
            <Button type="submit" disabled={busy || loading || !name.trim() || !baseUrl.trim()}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Save connection</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
      <DialogContent className="max-w-md">
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
        <DialogFooter>
          <Button variant="ghost" onClick={close}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

