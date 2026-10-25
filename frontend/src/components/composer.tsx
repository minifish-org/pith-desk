// The message composer: text, attachments, permission and model controls. The
// business rules for what may be submitted live in `actions/composer.ts`.
import {memo, useEffect, useRef} from 'react';
import {ArrowUp, CircleStop, ImagePlus, LoaderCircle} from 'lucide-react';
import {cn} from '@/lib/utils';
import {useDesk} from '@/stores/desk.ts';
import {
  addImageFiles, attachComposerElement, composerAction, composerDisabled, flushAllDrafts,
  rememberDraft, send, setComposerText, stop,
} from '@/actions/composer.ts';
import {activeConversation, blockingWorkspaceRun, composerPlaceholder, selectedWorkspace} from '@/lib/derive.ts';
import {permissionModeOf} from '@/lib/permissions.ts';
import {onAppEvent} from '@/lib/events.ts';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';
import {DraftAttachments} from '@/components/attachments';
import {ModelPicker} from '@/components/model-picker';
import {PermissionControl} from '@/components/permission-control';

function ComposerView() {
  const text = useDesk(store => store.composer.text);
  const images = useDesk(store => store.composer.images);
  const loading = useDesk(store => store.composer.loading);
  const reading = useDesk(store => store.composer.reading);
  const dropPending = useDesk(store => store.composer.dropPending);
  const loaded = useDesk(store => store.loaded);
  const busy = useDesk(store => store.activity.busy);
  const activeId = useDesk(store => store.state.activeId);
  const supportsImages = useDesk(store => store.state.settings.supportsImages);
  const modelLocked = useDesk(store => store.state.runs.length > 0);
  const mode = useDesk(store => permissionModeOf(activeConversation(store.state)));
  const placeholder = useDesk(store => {
    const workspace = selectedWorkspace(store.state, store.selectedWorkspaceId);
    return composerPlaceholder(store.state, store.loaded, workspace, blockingWorkspaceRun(store.state, workspace?.id));
  });
  const action = useDesk(() => composerAction());
  const disabled = useDesk(() => composerDisabled());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    attachComposerElement(textarea.current);
    return () => attachComposerElement(null);
  }, []);

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
    return onAppEvent('focusComposer', focus);
  }, []);

  const submit = () => {
    if (action === 'stop') void stop();
    else if (!disabled) void send();
  };

  return (
    <div className="conversation-column">
      <form
        data-composer=""
        className={cn('rounded-xl border bg-card shadow-sm transition-colors', dropPending && 'border-foreground/40 ring-2 ring-ring/20')}
        onSubmit={event => {event.preventDefault(); submit();}}
      >
        {images.length ? <DraftAttachments images={images} disabled={busy || reading} /> : null}
        <textarea
          ref={textarea}
          aria-label="Message Pith"
          value={text}
          readOnly={loading}
          disabled={!loaded}
          placeholder={placeholder}
          rows={1}
          onChange={event => setComposerText(event.target.value)}
          onBlur={() => {rememberDraft(); void flushAllDrafts().catch(() => {});}}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="block max-h-[180px] min-h-[40px] w-full resize-none bg-transparent px-3.5 pt-2.5 text-[14px] leading-[1.5] outline-none placeholder:text-muted-foreground/80"
        />
        <div data-composer-context="" className="flex items-end gap-1.5 px-2 pt-1 pb-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button" variant="ghost" size="icon-sm" aria-label="Attach images"
                disabled={busy || reading || loading || !supportsImages}
                onClick={() => fileInput.current?.click()}
              >
                {reading ? <LoaderCircle className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{supportsImages ? 'Attach images' : 'This model does not support images'}</TooltipContent>
          </Tooltip>
          <input
            ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
            onChange={event => {
              const files = [...event.target.files || []];
              event.target.value = '';
              if (files.length) void addImageFiles(files);
            }}
          />
          <PermissionControl mode={mode} disabled={!activeId || busy} />
          <div className="ml-auto flex items-center gap-1.5">
            <ModelPicker disabled={busy || modelLocked} />
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
      <ComposerNote />
    </div>
  );
}

export const Composer = memo(ComposerView);

function ComposerNote() {
  const images = useDesk(store => store.composer.images);
  const supportsImages = useDesk(store => store.state.settings.supportsImages);
  if (images.length && !supportsImages) return <p className="mt-1.5 text-center text-[11px] text-[var(--warning-text)]">This model does not support images. Choose an image-capable model or remove the attachments.</p>;
  if (images.length) return <p className="mt-1.5 text-center text-[11px] text-muted-foreground">Images are saved with this conversation and sent to your configured model provider.</p>;
  return null;
}
