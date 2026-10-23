import {useEffect, useRef, useState} from 'react';
import {DndContext, closestCenter, type DragEndEvent} from '@dnd-kit/core';
import {SortableContext, arrayMove, horizontalListSortingStrategy, useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {
  ArrowUp, ChevronDown, CircleStop, ImagePlus, LoaderCircle, Shield, ShieldAlert, ShieldCheck, X,
} from 'lucide-react';
import {cn} from '@/lib/utils';
import {desk, useDesk} from '@/stores/desk.ts';
import {
  addImageFiles, attachComposerElement, canSubmit, composerAction, composerDisabled,
  rememberDraft, send, setComposerText, stop, removeAttachment,
} from '@/actions/composer.ts';
import {composerPlaceholder} from '@/lib/derive.ts';
import {blockedWorkspace, changePermission, selected, activeMode} from '@/actions/conversations.ts';
import {thinkingLabel} from '@/lib/format';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';
import {useMediaQuery} from '@/hooks/use-media';
import {saveModelSelection} from '@/actions/settings.ts';

const permissionLabels = {
  ask: {label: 'Ask before changes', icon: Shield},
  'workspace-write': {label: 'Allow workspace changes', icon: ShieldCheck},
  'full-access': {label: 'Full access', icon: ShieldAlert},
} as const;

export function Composer() {
  const text = useDesk(store => store.composer.text);
  const images = useDesk(store => store.composer.images);
  const loading = useDesk(store => store.composer.loading);
  const reading = useDesk(store => store.composer.reading);
  const dropPending = useDesk(store => store.composer.dropPending);
  const state = useDesk(store => store.state);
  const loaded = useDesk(store => store.loaded);
  const busy = useDesk(store => store.activity.busy);
  const selectedId = useDesk(store => store.selectedWorkspaceId);
  const mode = useDesk(store => activeMode());
  const workspace = selected();
  const blocked = blockedWorkspace(workspace?.id);
  const action = composerAction();
  const disabled = composerDisabled();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    attachComposerElement(textarea.current);
    return () => attachComposerElement(null);
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const compact = useMediaQuery('(max-width: 720px)');

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(180, Math.max(40, element.scrollHeight))}px`;
  }, [text]);

  useEffect(() => {
    const focus = () => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(textarea.current.value.length, textarea.current.value.length);
    };
    window.addEventListener('pith:focus-composer', focus);
    return () => window.removeEventListener('pith:focus-composer', focus);
  }, []);

  const submit = () => {
    if (action === 'stop') void stop();
    else if (!disabled) void send();
  };

  const hasDraft = !!text.trim() || images.length > 0;
  const placeholder = composerPlaceholder(state, loaded, workspace, blocked);

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(false);
    const over = event.over;
    if (!over || event.active.id === over.id) return;
    const from = images.findIndex(image => image.id === event.active.id);
    const to = images.findIndex(image => image.id === over.id);
    if (from < 0 || to < 0) return;
    desk().setComposer({images: arrayMove(images, from, to)});
    rememberDraft();
  };

  return (
    <div className="mx-auto w-full max-w-[54rem] px-6">
      <form
        data-composer=""
        className={cn('rounded-xl border bg-card shadow-sm transition-colors', dropPending && 'border-foreground/40 ring-2 ring-ring/20')}
        onSubmit={event => {event.preventDefault(); submit();}}
      >
        {images.length ? (
          <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={images.map(image => image.id)} strategy={horizontalListSortingStrategy}>
              <div data-draft-images="" className="flex gap-2 overflow-x-auto px-3 pt-3">
                {images.map(image => <SortableAttachment key={image.id} image={image} disabled={busy || reading} />)}
              </div>
            </SortableContext>
          </DndContext>
        ) : null}
        <textarea
          ref={textarea}
          aria-label="Message Pith"
          value={text}
          readOnly={loading}
          disabled={!loaded}
          placeholder={placeholder}
          rows={1}
          onDragEnter={() => setDragging(true)}
          onDragOver={event => {if (event.dataTransfer.types.includes('Files')) {event.preventDefault(); setDragging(true);}}}
          onDragLeave={() => setDragging(false)}
          onDrop={event => {
            event.stopPropagation();
            setDragging(false);
            const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/'));
            if (files.length) {event.preventDefault(); void addImageFiles(files);}
          }}
          onChange={event => setComposerText(event.target.value)}
          onBlur={() => {rememberDraft(); void import('@/actions/composer.ts').then(module => module.flushAllDrafts()).catch(() => {});}}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className={cn(
            'block max-h-[180px] min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/80',
            dragging && 'opacity-70',
          )}
        />
        <div data-composer-context="" className="flex items-end gap-1.5 px-2 pt-1 pb-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button" variant="ghost" size="icon-sm" aria-label="Attach images"
                disabled={busy || reading || loading || !state.settings.supportsImages}
                onClick={() => fileInput.current?.click()}
              >
                {reading ? <LoaderCircle className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{state.settings.supportsImages ? 'Attach images' : 'This model does not support images'}</TooltipContent>
          </Tooltip>
          <input
            ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
            onChange={event => {
              const files = [...event.target.files || []];
              event.target.value = '';
              if (files.length) void addImageFiles(files);
            }}
          />
          <PermissionControl mode={mode} disabled={!state.activeId || busy} />
          <div className="ml-auto flex items-center gap-1.5">
            <ModelControl disabled={busy || state.runs.length > 0} compact={compact} />
            {state.settings.thinkingLevels && state.settings.thinkingLevels.length > 1 ? (
              <ThinkingControl disabled={busy || state.runs.length > 0} />
            ) : null}
            <Button
              type="submit"
              size="icon"
              className="size-8 rounded-lg"
              aria-label={action === 'stop' ? 'Stop agent' : action === 'queue' ? 'Queue message' : 'Send message'}
              disabled={action === 'stop' ? busy : disabled}
              title={action === 'stop' ? 'Stop the running task' : action === 'queue' ? 'Queue this message' : 'Send message'}
            >
              {action === 'stop' ? <CircleStop className="size-4" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
      </form>
      <ComposerNote hasDraft={hasDraft} mode={mode} />
    </div>
  );
}

function SortableAttachment({image, disabled}: {image: {id: string; url: string; name: string}; disabled: boolean}) {
  const {attributes, listeners, setNodeRef, transform, transition, isDragging} = useSortable({id: image.id, disabled});
  return (
    <figure
      ref={setNodeRef}
      style={{transform: CSS.Transform.toString(transform), transition}}
      data-draft-image=""
      className={cn('relative w-[104px] shrink-0', isDragging && 'z-10 opacity-80')}
      {...attributes}
      {...listeners}
    >
      <button
        type="button" aria-label={`Open ${image.name}`} className="block"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          const trigger = event.currentTarget;
          desk().openModal({kind: 'image', id: `draft-${image.id}`, src: image.url, alt: image.name, onClose: () => requestAnimationFrame(() => trigger.focus())});
        }}
      >
        <img src={image.url} alt="" className="h-20 w-[104px] rounded-lg border object-cover" />
      </button>
      <figcaption className="truncate pt-1 text-[11px] text-muted-foreground">{image.name}</figcaption>
      <Button
        type="button" variant="secondary" size="icon-xs"
        className="absolute top-1 right-1 size-5 rounded-full shadow"
        aria-label={`Remove ${image.name}`}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => removeAttachment(image.id)}
      >
        <X className="size-3" />
      </Button>
    </figure>
  );
}

function PermissionControl({mode, disabled}: {mode: 'ask' | 'workspace-write' | 'full-access'; disabled: boolean}) {
  const {label, icon: Icon} = permissionLabels[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button" variant="ghost" size="sm"
          className={cn('h-8 gap-1.5 rounded-md border border-transparent px-2 text-[12px] text-muted-foreground hover:bg-accent max-sm:w-9 max-sm:justify-center max-sm:px-0', mode === 'full-access' && 'text-[var(--warning)]')}
          aria-label="Conversation permissions"
          title={label}
          disabled={disabled}
        >
          <Icon className="size-3.5" />
          <span data-select-value="" className="hidden md:inline">{label}</span>
          <ChevronDown className="size-3 opacity-60 max-sm:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Conversation permissions</DropdownMenuLabel>
        {(['ask', 'workspace-write', 'full-access'] as const).map(value => {
          const entry = permissionLabels[value];
          const EntryIcon = entry.icon;
          return (
            <DropdownMenuItem key={value} onSelect={() => {void changePermission(value);}} className="items-start gap-2 py-2">
              <EntryIcon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{entry.label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{permissionCopy[value]}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground">Saved for this conversation. Full access has no OS sandbox.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const permissionCopy = {
  ask: 'Reads run freely. File changes, commands and external tools need approval.',
  'workspace-write': 'Workspace files may change. Commands still need approval.',
  'full-access': 'Every enabled tool runs without asking. Use with care.',
} as const;

function ModelControl({disabled, compact}: {disabled: boolean; compact: boolean}) {
  const settings = useDesk(store => store.state.settings);
  const label = settings.modelName || settings.model || 'Choose model';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button" variant="ghost" size="sm"
          className="h-8 max-w-[200px] gap-1 px-2 text-[12px] text-muted-foreground hover:bg-accent"
          aria-label="Choose model"
          disabled={disabled}
          onClick={() => desk().openModal({kind: 'models', id: 'models'})}
        >
          <span className="truncate">{compact ? settings.model || label : label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{settings.provider ? `${settings.provider} / ${settings.model}` : 'Choose a model'}</TooltipContent>
    </Tooltip>
  );
}

function ThinkingControl({disabled}: {disabled: boolean}) {
  const settings = useDesk(store => store.state.settings);
  const levels = settings.thinkingLevels || ['off'];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button" variant="ghost" size="sm"
          className="h-8 gap-1 px-2 text-[12px] text-muted-foreground hover:bg-accent"
          aria-label="Thinking effort"
          disabled={disabled}
        >
          <span>Thinking: {thinkingLabel(settings.thinkingLevel || 'off')}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {levels.map(level => (
          <DropdownMenuItem
            key={level}
            disabled={level === (settings.thinkingLevel || 'off')}
            onSelect={() => {void saveModelSelection({provider: settings.provider, model: settings.model, thinkingLevel: level});}}
          >
            {thinkingLabel(level)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ComposerNote({hasDraft, mode}: {hasDraft: boolean; mode: 'ask' | 'workspace-write' | 'full-access'}) {
  const images = useDesk(store => store.composer.images);
  const supportsImages = useDesk(store => store.state.settings.supportsImages);
  if (images.length && !supportsImages) return <p className="mt-1.5 text-center text-[11px] text-[var(--warning)]">This model does not support images. Choose an image-capable model or remove the attachments.</p>;
  if (images.length) return <p className="mt-1.5 text-center text-[11px] text-muted-foreground">Images are saved with this conversation and sent to your configured model provider.</p>;
  if (mode === 'full-access') return <p className="mt-1.5 text-center text-[11px] text-[var(--warning)]">Full access: commands and external tools run without asking.</p>;
  if (hasDraft) return null;
  return <p className="mt-1.5 text-center text-[11px] text-muted-foreground">Pith can read workspace files. Changes, commands, and external connection tools require approval.</p>;
}

export {canSubmit};
