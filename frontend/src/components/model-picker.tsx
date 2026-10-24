import {useEffect, useState} from 'react';
import {Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle} from 'lucide-react';
import {useDesk, desk} from '@/stores/desk.ts';
import {loadModels, saveModelSelection} from '@/actions/models.ts';
import {thinkingLabel} from '@/lib/format';
import {Button} from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type {ModelCatalog} from '@/contract.generated.ts';

/** Model and thinking effort for the next task. The menu keeps an explicit
 * draft so closing it without choosing leaves the shared selection untouched. */
export function ModelPicker({disabled}: {disabled: boolean}) {
  const settings = useDesk(store => store.state.settings);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'root' | 'model' | 'thinking'>('root');
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({provider: settings.provider, model: settings.model, thinkingLevel: settings.thinkingLevel || 'off'});

  useEffect(() => {
    if (!open) return;
    setDraft({provider: settings.provider, model: settings.model, thinkingLevel: settings.thinkingLevel || 'off'});
    // Connections can change while the menu is closed. Retire the old choices
    // until this opening has read the current catalog.
    setCatalog(null);
    setError('');
    let active = true;
    void loadModels().then(result => {if (active) setCatalog(result);}).catch(failure => {if (active) setError(failure instanceof Error ? failure.message : String(failure));});
    return () => {active = false;};
  }, [open]);

  const providers = (catalog?.providers || []).filter(provider => provider.hasApiKey);
  const models = catalog?.models || [];
  const groups = providers.map(provider => ({provider, models: models.filter(entry => entry.provider === provider.id)})).filter(group => group.models.length);
  const selected = models.find(entry => entry.provider === draft.provider && entry.id === draft.model);
  const levels = selected?.thinkingLevels?.length ? selected.thinkingLevels : settings.thinkingLevels?.length ? settings.thinkingLevels : ['off'];
  const label = selected?.name || settings.modelName || settings.model || 'Choose model';
  const currentLevels = settings.thinkingLevels?.length ? settings.thinkingLevels : ['off'];

  const save = async (next: {provider: string; model: string; thinkingLevel: string}, closeAfter: boolean) => {
    setSaving(true);
    setError('');
    try {
      if (await saveModelSelection(next)) {
        setDraft(next);
        setView('root');
        if (closeAfter) setOpen(false);
      } else setError(desk().activity.error);
    } finally {setSaving(false);}
  };

  return (
    <DropdownMenu open={open} onOpenChange={value => {setOpen(value); if (!value) {setView('root'); setError('');}}}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button" variant="ghost" size="sm"
          className="h-8 max-w-[250px] gap-1 px-2 text-[12px] text-muted-foreground hover:bg-accent"
          aria-label="Choose model"
          disabled={disabled}
          title={settings.provider ? `${settings.provider} / ${settings.model}` : 'Choose a model'}
        >
          <span className="truncate">{label}</span>
          {currentLevels.length > 1 ? <span className="shrink-0 opacity-60">· {thinkingLabel(settings.thinkingLevel || 'off')}</span> : null}
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {view === 'root' ? (
          <>
            <DropdownMenuItem className="py-2" onSelect={event => {event.preventDefault(); setView('model');}}>
              <span>Model</span>
              <span className="ml-2 min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">{label}</span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2" onSelect={event => {event.preventDefault(); setView('thinking');}}>
              <span>Thinking</span>
              <span className="ml-2 min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">{thinkingLabel(draft.thinkingLevel || 'off')}</span>
              <ChevronRight className="size-3.5 text-muted-foreground" />
            </DropdownMenuItem>
          </>
        ) : null}

        {view === 'model' ? (
          <>
            <DropdownMenuItem className="gap-1 py-1.5 text-[11px] text-muted-foreground" onSelect={event => {event.preventDefault(); setView('root');}}>
              <ChevronLeft className="size-3.5" />Model
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="scrollbar-quiet max-h-[60dvh] overflow-y-auto pr-1">
              {!catalog && !error ? <DropdownMenuItem disabled><LoaderCircle className="size-3.5 animate-spin" />Loading models…</DropdownMenuItem> : null}
              {catalog && !groups.length ? <DropdownMenuItem disabled>No configured models</DropdownMenuItem> : null}
              {groups.map(group => (
                <DropdownMenuGroup key={group.provider.id}>
                  <DropdownMenuLabel className="px-1.5 py-1 text-[10.5px] font-medium text-muted-foreground">{group.provider.name}</DropdownMenuLabel>
                  {group.models.map(entry => {
                    const active = entry.provider === draft.provider && entry.id === draft.model;
                    return (
                      <DropdownMenuItem
                        key={`${entry.provider}/${entry.id}`}
                        className="pr-5"
                        disabled={saving || disabled}
                        onSelect={event => {
                          event.preventDefault();
                          const nextLevels = entry.thinkingLevels?.length ? entry.thinkingLevels : ['off'];
                          const thinkingLevel = nextLevels.includes(draft.thinkingLevel) ? draft.thinkingLevel : nextLevels[0] || 'off';
                          void save({provider: entry.provider, model: entry.id, thinkingLevel}, nextLevels.length < 2);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{entry.name}</span>
                        {active ? <Check className="size-3.5" /> : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              ))}
              {error ? <p className="px-2 py-1 text-[11px] text-destructive" role="alert">{error}</p> : null}
            </div>
          </>
        ) : null}

        {view === 'thinking' ? (
          <>
            <DropdownMenuItem className="gap-1 py-1.5 text-[11px] text-muted-foreground" onSelect={event => {event.preventDefault(); setView('root');}}>
              <ChevronLeft className="size-3.5" />Thinking
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {levels.map(level => (
              <DropdownMenuItem
                key={level}
                disabled={saving || disabled || levels.length < 2}
                onSelect={() => {void save({...draft, thinkingLevel: level}, true);}}
              >
                {thinkingLabel(level)}
                {level === (draft.thinkingLevel || 'off') ? <Check className="ml-auto size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
