import {useEffect, useState} from 'react';
import {LoaderCircle, MoreHorizontal, Plug} from 'lucide-react';
import {cn} from '@/lib/utils';
import {closeModalId, desk, useDesk, type ModalOf} from '@/stores/desk.ts';
import {runtime} from '@/lib/runtime';
import {confirmRemoveMCP, loadMCP, mcpAuth, saveMCP} from '@/actions/connections.ts';
import {onAppEvent} from '@/lib/events.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Switch} from '@/components/ui/switch';
import {Textarea} from '@/components/ui/textarea';
import {Badge} from '@/components/ui/badge';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {MCPServerView} from '@/contract.generated.ts';

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
  const login = useDesk(store => store.state.login);
  const [entries, setEntries] = useState<MCPServerView[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<MCPServerView | 'new' | null>(null);

  const refresh = () => {
    setError('');
    void loadMCP().then(setEntries).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)));
  };
  useEffect(() => {
    refresh();
    return onAppEvent('mcpRefresh', refresh);
  }, []);
  useEffect(() => {
    if (login?.phase === 'complete') refresh();
  }, [login?.id, login?.phase]);

  const disabled = busy || running;

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[86dvh] w-full sm:max-w-[500px] flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            MCP tools available to tasks in every workspace. Credentials stay on this host.
            {runtime.server ? ' Connections run on the server; localhost, environment variables and runtime dependencies all refer to that server.' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex items-center justify-between gap-1.5">
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
                    {entry.oauth ? (
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
          <label className="flex items-center gap-2 text-[12px]"><Switch checked={oauth} onCheckedChange={setOauth} />Use OAuth</label>
          {oauth ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1 text-[12px]"><span className="font-medium">OAuth client ID</span><Input aria-label="OAuth client ID" value={oauthClientId} onChange={event => setOauthClientId(event.target.value)} /></label>
                <label className="space-y-1 text-[12px]"><span className="font-medium">OAuth scope</span><Input aria-label="OAuth scope" value={oauthScope} onChange={event => setOauthScope(event.target.value)} /></label>
              </div>
              {runtime.server ? <p className="text-[11px] text-muted-foreground">After authorizing, paste the complete redirect URL from the browser address bar back into Desk. The page may show a connection error.</p> : null}
            </>
          ) : null}
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
