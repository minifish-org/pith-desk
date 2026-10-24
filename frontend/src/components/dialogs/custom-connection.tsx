import {useEffect, useState} from 'react';
import {LoaderCircle, Trash2} from 'lucide-react';
import {closeModalId, desk, type ModalOf} from '@/stores/desk.ts';
import {loadCustomConnection, saveCustomConnection} from '@/actions/models.ts';
import {emitAppEvent} from '@/lib/events.ts';
import type {ModelsJsonModel} from '@/contract.generated.ts';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';

const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations'];

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

const emptyModel = (sourceIndex = 0): ModelDraft => ({
  sourceIndex, id: '', name: '', contextWindow: 128000, maxTokens: 8192, images: false, reasoning: false,
  prices: {input: '', output: '', cacheRead: '', cacheWrite: ''},
});

export function CustomConnectionDialog({modal}: {modal: ModalOf<'custom-connection'>}) {
  const editing = !!modal.connectionId;
  const [loading, setLoading] = useState(editing);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState(protocols[0]);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelDraft[]>([emptyModel()]);
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
        id: modal.connectionId || '', name, baseUrl, api, apiKey,
        models: models.map(model => {
          const definition: ModelsJsonModel = {
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
        emitAppEvent('modelConnectionsChanged');
      } else setError(desk().activity.error);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {setBusy(false);}
  };

  return (
    <Dialog open onOpenChange={open => {if (!open) closeModalId(modal.id);}}>
      <DialogContent className="flex max-h-[88dvh] w-full sm:max-w-[500px] flex-col overflow-hidden p-0">
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
                <Button type="button" size="sm" variant="secondary" onClick={() => setModels(previous => [...previous, emptyModel(previous.length)])}>Add model</Button>
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
                    {([['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write']] as const).map(([key, label]) => (
                      <label key={key} className="space-y-1 text-[11px]"><span className="text-muted-foreground">{label} $/1M</span><Input aria-label={`Model ${index + 1} ${key} price`} value={model.prices[key]} onChange={event => updateModel(index, {prices: {...model.prices, [key]: event.target.value}})} placeholder="unknown" /></label>
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
          <DialogFooter className="mx-0 mb-0 border-t px-5 pt-3 pb-5">
            <Button type="button" variant="ghost" onClick={() => closeModalId(modal.id)}>Cancel</Button>
            <Button type="submit" disabled={busy || loading || !name.trim() || !baseUrl.trim()}>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}Save connection</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
